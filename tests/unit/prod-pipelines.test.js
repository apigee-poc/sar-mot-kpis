// Static and fake-tool checks of the P8 PROD pipelines (cloudbuild-infra-prod.yaml,
// cloudbuild-prod.yaml) and scripts/check-release-commit.sh. Offline: js-yaml parses the YAML;
// inline step scripts run in bash against fake scripts/tools in temp dirs (/workspace is
// redirected to a temp dir). Nothing is run against GCP.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { expect } = require('chai');

const ROOT = path.join(__dirname, '..', '..');
const PROD = 'apigee-prod-511508';
const NONPROD = 'apigee-nonprod-511322';
const PROD_FILES = ['cloudbuild-infra-prod.yaml', 'cloudbuild-prod.yaml'];
const BUILTINS = ['PROJECT_ID', 'BUILD_ID', 'PROJECT_NUMBER', 'LOCATION', 'REPO_NAME', 'REPO_FULL_NAME',
  'BRANCH_NAME', 'TAG_NAME', 'REVISION_ID', 'COMMIT_SHA', 'SHORT_SHA', 'TRIGGER_NAME',
  'TRIGGER_BUILD_CONFIG_PATH', 'SERVICE_ACCOUNT_EMAIL', 'SERVICE_ACCOUNT'];
const GUARD_ENV = ['BUILD_ID=${BUILD_ID}', 'TARGET=prod'];
const SHA = 'abc1234';
const COMMIT = `${SHA}${'0'.repeat(33)}`;

const posix = (p) => p.replace(/\\/g, '/');
const load = (f) => yaml.load(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const stepText = (s) => [s.entrypoint || '', ...(s.args || []), ...(s.env || [])].join('\n');
const fileText = (doc) => doc.steps.map(stepText).join('\n');
const ids = (doc) => doc.steps.map((s) => s.id);
// The raw (unsubstituted) inline bash -c script of a step.
const script = (s) => s.args[s.args.indexOf('-c') + 1];
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const STRICT = process.env.REQUIRE_BASH_TESTS === '1';
function skipOrFail(ctx, why) {
  if (STRICT) {
    throw new Error(`REQUIRE_BASH_TESTS=1 but ${why}`);
  }
  console.log(`      (skipped: ${why})`);
  ctx.skip();
}

// Git Bash on Windows (never WSL's System32\bash.exe), plain bash elsewhere.
function findBash() {
  if (process.platform !== 'win32') {
    return 'bash';
  }
  const candidates = [
    process.env.GIT_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) || null;
}
const BASH = findBash();

function findPythonDir() {
  const probe = 'import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)';
  for (const cmd of ['python3', 'python', 'py']) {
    const r = spawnSync(cmd, ['-c', probe], { encoding: 'utf8' });
    if (r.status === 0) {
      const exe = spawnSync(cmd, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
      const p = (exe.stdout || '').trim();
      if (p) {
        return path.dirname(p);
      }
    }
  }
  return null;
}

// Inline `bash -c` script of a step, with Cloud Build substitutions applied and $$ unescaped.
function inlineScript(step, subs) {
  const a = step.args || [];
  const i = a.indexOf('-c');
  if (step.entrypoint !== 'bash' || i < 0) {
    return null;
  }
  return a[i + 1]
    .replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (m, k) => (k in subs ? subs[k] : 'SUB'))
    .replace(/\$\$/g, '$');
}

// Runs a step's inline script in <cwd> with /workspace/ redirected to <ws>.
function runStep(step, subs, cwd, ws) {
  const sc = inlineScript(step, subs).split('/workspace/').join(`${posix(ws)}/`);
  const r = spawnSync(BASH, ['-c', sc], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// Fake repo dir whose scripts/<name> (or infra/<name>) log "<name> <args>" to <dir>/calls and
// exit with the code in <dir>/rc_<name> (default 0); stdout comes from <dir>/out_<name> if present.
function fakeRepo(names) {
  const dir = tmpDir('p8b-repo-');
  names.forEach((n) => {
    const file = path.join(dir, n);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const base = path.basename(n);
    fs.writeFileSync(file, [
      '#!/usr/bin/env bash',
      `D="${posix(dir)}"`,
      `echo "${base} $*" >> "$D/calls"`,
      `[ -f "$D/out_${base}" ] && cat "$D/out_${base}"`,
      `exit "$(cat "$D/rc_${base}" 2>/dev/null || echo 0)"`
    ].join('\n') + '\n', { mode: 0o755 });
  });
  return dir;
}
const calls = (dir) => (fs.existsSync(path.join(dir, 'calls'))
  ? fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').filter(Boolean) : []);

// Scripts that refuse to run without BUILD_ID/TARGET=prod: they call infra_guard or prod_guard.
function guardedScripts() {
  const out = [];
  const scan = (dir, rel) => fs.readdirSync(dir).filter((f) => f.endsWith('.sh')).forEach((f) => {
    const code = fs.readFileSync(path.join(dir, f), 'utf8').split('\n')
      .filter((l) => !/^\s*#/.test(l)).join('\n');
    if (/^\s*(infra_guard|prod_guard) /m.test(code)) {
      out.push(`${rel}/${f}`);
    }
  });
  scan(path.join(ROOT, 'scripts'), 'scripts');
  scan(path.join(ROOT, 'infra'), 'infra');
  scan(path.join(ROOT, 'db'), 'db');
  return out;
}

describe('P8 prod pipelines (static + fake tools)', function () {
  // bash -n per inline script and fake runs spawn many processes (slow on Windows).
  this.timeout(120000);
  const docs = {};
  PROD_FILES.forEach((f) => { docs[f] = load(f); });

  it('every cloudbuild*.yaml except the two prod pipelines is free of the prod project', () => {
    const all = fs.readdirSync(ROOT).filter((f) => /^cloudbuild.*\.ya?ml$/.test(f)).sort();
    expect(all).to.include.members(PROD_FILES);
    all.filter((f) => !PROD_FILES.includes(f)).forEach((f) => {
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), f).to.not.include(PROD);
    });
  });

  it('the guarded-script scan finds the infra scripts, db/load.sh and the prod helpers', () => {
    const g = guardedScripts();
    ['infra/01-enable-apis.sh', 'infra/02-service-accounts-iam.sh', 'infra/03-cloudsql-private.sh',
      'infra/04-psc-endpoint-attachment.sh', 'infra/06-apigee-prod-product-app.sh', 'db/load.sh',
      'scripts/apply-integration-prod.sh', 'scripts/assert-integration-prod.sh', 'scripts/create-connection.sh',
      'scripts/deploy-debugmask-prod.sh', 'scripts/run-newman-prod.sh'].forEach((s) => expect(g, s).to.include(s));
  });

  PROD_FILES.forEach((f) => {
    describe(f, () => {
      const doc = docs[f];
      const text = fileText(doc);
      const raw = fs.readFileSync(path.join(ROOT, f), 'utf8');

      it('is valid YAML with steps, unique ids, CLOUD_LOGGING_ONLY and a timeout', () => {
        expect(doc.steps).to.be.an('array').that.is.not.empty;
        doc.steps.forEach((s) => {
          expect(s.id, JSON.stringify(s)).to.be.a('string');
          expect(s.name, s.id).to.be.a('string');
        });
        expect(new Set(ids(doc)).size).to.equal(doc.steps.length);
        expect(doc.options.logging).to.equal('CLOUD_LOGGING_ONLY');
        expect(doc.timeout).to.match(/^\d+s$/);
        expect(doc.steps[0].id).to.equal('guard-target');
      });

      it('sets no serviceAccount (it is set on the trigger) and uses only stock images', () => {
        expect(doc).to.not.have.property('serviceAccount');
        doc.steps.forEach((s) => expect(s.name, s.id).to.be.oneOf([
          'node:22', 'gcr.io/google.com/cloudsdktool/cloud-sdk:slim']));
      });

      it('every step passes BUILD_ID and TARGET=prod explicitly (guarded steps above all)', () => {
        doc.steps.forEach((s) => {
          expect(s.env, s.id).to.be.an('array');
          GUARD_ENV.forEach((e) => expect(s.env, s.id).to.include(e));
          expect(s.env.join('\n'), s.id).to.not.match(/TARGET=(?!prod$)/m);
        });
        expect(doc).to.not.have.nested.property('options.automapSubstitutions');
        const guarded = guardedScripts();
        let n = 0;
        doc.steps.forEach((s) => {
          guarded.filter((g) => stepText(s).includes(g)).forEach(() => {
            n += 1;
            GUARD_ENV.forEach((e) => expect(s.env, s.id).to.include(e));
          });
        });
        expect(n).to.be.above(0);
      });

      it('references only files that exist, and referenced scripts are executable in git', () => {
        const refs = new Set(text.match(/\b(?:scripts|tests|db|infra)\/[\w./-]+\.(?:sh|js|env)\b/g) || []);
        expect(refs.size).to.be.above(0);
        refs.forEach((r) => expect(fs.existsSync(path.join(ROOT, r)), r).to.equal(true));
        const shRefs = [...refs].filter((r) => r.endsWith('.sh'));
        const ls = spawnSync('git', ['ls-files', '-s', '--', ...shRefs], { cwd: ROOT, encoding: 'utf8' });
        const lines = ls.status === 0 ? ls.stdout.trim().split('\n').filter(Boolean) : [];
        if (lines.length === 0) {
          if (STRICT && fs.existsSync(path.join(ROOT, '.git'))) {
            throw new Error('REQUIRE_BASH_TESTS=1 but git ls-files returned nothing for the referenced scripts');
          }
          console.log(`      (WARNING: script modes not checked for ${f}: no git metadata)`);
          return;
        }
        expect(lines.length).to.equal(shRefs.length);
        lines.forEach((l) => expect(l.split(/\s+/)[0], l).to.equal('100755'));
      });

      it('defines every user substitution it uses and uses every one it defines', () => {
        const defined = Object.keys(doc.substitutions || {});
        const used = new Set((raw.match(/\$\{([A-Z_][A-Z0-9_]*)\}/g) || []).map((m) => m.slice(2, -1)));
        used.forEach((u) => {
          if (u.startsWith('_')) {
            expect(defined, u).to.include(u);
          } else {
            expect(BUILTINS, u).to.include(u);
          }
        });
        defined.forEach((d) => expect([...used], d).to.include(d));
      });

      it('escapes shell syntax as $$ (no bare $(, $VAR or ${var}/${VAR:-x} in step args)', () => {
        const defined = Object.keys(doc.substitutions || {});
        doc.steps.forEach((s) => {
          const t = stepText(s);
          expect(t, s.id).to.not.match(/(^|[^$])\$\(/);
          expect(t, s.id).to.not.match(/(^|[^$])\$[A-Za-z_]/);
          expect(t, s.id).to.not.match(/(^|[^$])\$\{(?![A-Z_][A-Z0-9_]*\})/);
          (t.match(/(^|[^$])\$\{([A-Z_][A-Z0-9_]*)\}/g) || []).forEach((m) => {
            const name = m.replace(/^[^$]?\$\{/, '').replace(/\}$/, '');
            expect(defined.concat(BUILTINS), `${s.id}: \${${name}}`).to.include(name);
          });
        });
      });

      it('holds no token or secret literals, no --verbose and no xtrace', () => {
        expect(raw).to.not.match(/ya29\.|AIza[0-9A-Za-z_-]{20,}|-----BEGIN|[A-Za-z0-9+/]{40,}={0,2}/);
        expect(raw).to.not.match(/password\s*[:=]|secret\s*[:=]/i);
        expect(raw).to.not.include('--verbose');
        expect(raw).to.not.match(/set -x|bash -x/);
        expect(text).to.not.match(/cat \/workspace\/\.token[^)]/);
        expect(text).to.not.match(/secrets versions access|:access\b/);
      });

      it('never uses the non-prod-only scripts or env file', () => {
        expect(text).to.not.match(/infra\/05-|infra\/env\/nonprod\.env|tests\/run-newman\.sh|scripts\/apply-integration\.sh|scripts\/assert-integration\.sh|scripts\/deploy-debugmask\.sh|stamp-commit|fi-deploy|fi-restore/);
      });

      it('inline scripts are valid bash', function () {
        if (!BASH) {
          skipOrFail(this, 'no bash was found');
        }
        doc.steps.forEach((s) => {
          const sc = inlineScript(s, doc.substitutions || {});
          if (sc !== null) {
            const r = spawnSync(BASH, ['-n', '-c', sc], { encoding: 'utf8' });
            expect(r.status, `${s.id}: ${r.stderr}`).to.equal(0);
          }
        });
      });
    });
  });

  describe('cloudbuild-infra-prod.yaml', () => {
    const doc = docs['cloudbuild-infra-prod.yaml'];

    it('defaults to prod and runs integrationcli, infra/01-04, create-connection, infra/06, then the 02 check', () => {
      expect(doc.substitutions).to.deep.equal({ _TARGET: 'prod' });
      expect(ids(doc)).to.deep.equal(['guard-target', 'install-integrationcli', 'infra-01-enable-apis',
        'infra-02-service-accounts-iam', 'infra-03-cloudsql-private', 'infra-04-psc-endpoint-attachment',
        'token-connection', 'create-connection-prod', 'infra-06-apigee-prod-product-app', 'check-infra-02']);
      const step = (id) => doc.steps[ids(doc).indexOf(id)];
      ['01-enable-apis', '02-service-accounts-iam', '03-cloudsql-private', '04-psc-endpoint-attachment',
        '06-apigee-prod-product-app'].forEach((n) => {
        const t = stepText(step(`infra-${n}`));
        const show = t.indexOf(`cat infra/${n}.sh`);
        expect(show, n).to.be.above(-1);
        expect(show, n).to.be.below(t.indexOf(`bash infra/${n}.sh infra/env/prod.env`));
      });
      expect(stepText(step('create-connection-prod'))).to.include('bash scripts/create-connection.sh prod');
      expect(step('create-connection-prod').name).to.equal('node:22');
      expect(stepText(step('token-connection'))).to.include('gcloud auth print-access-token > /workspace/.token');
      expect(step('install-integrationcli').args).to.deep.equal(['scripts/install-integrationcli.sh', '0.86.0', '/workspace/bin']);
    });

    it('documents that it is billable, needs approval and the human prerequisites', () => {
      const raw = fs.readFileSync(path.join(ROOT, 'cloudbuild-infra-prod.yaml'), 'utf8');
      expect(raw).to.match(/BILLABLE/);
      expect(raw).to.match(/--require-approval/);
      expect(raw).to.match(/Quick setup/);
      expect(raw).to.match(/cb-deploy-prod/);
      expect(raw).to.match(/cb-deploy-nonprod must hold NO role/);
    });

    it('the guard step refuses any _TARGET but prod', function () {
      if (!BASH) {
        skipOrFail(this, 'no bash was found');
      }
      const ws = tmpDir('p8b-ws-');
      const TRIG = 'sar-mot-kpis-infra-prod';
      ['nonprod', 'staging', 'dev', '', 'PROD'].forEach((t) => {
        const r = runStep(doc.steps[0], { _TARGET: t, BUILD_ID: 'b-1', TRIGGER_NAME: TRIG }, ROOT, ws);
        expect(r.code, t).to.equal(1);
        expect(r.err, t).to.match(/runs the PROD foundation only/);
      });
      // TRIGGER_NAME pin (mistake-proofing only, D67): empty under a plain builds submit.
      ['', 'sar-mot-kpis-prod', 'sar-mot-kpis-infra'].forEach((t) => {
        const r = runStep(doc.steps[0], { _TARGET: 'prod', BUILD_ID: 'b-1', TRIGGER_NAME: t }, ROOT, ws);
        expect(r.code, t).to.equal(1);
        expect(r.err, t).to.match(/Refusing TRIGGER_NAME=/);
      });
      const ok = runStep(doc.steps[0], { _TARGET: 'prod', BUILD_ID: 'b-1', TRIGGER_NAME: TRIG }, ROOT, ws);
      expect(ok.code, ok.err).to.equal(0);
      // L6: only the key names of prod.env reach the log, never a value such as the MOT email.
      expect(ok.out).to.match(/prod\.env keys: .*MOT_DEVELOPER_EMAIL/);
      expect(ok.out).to.not.match(/@|kpis_prod|sar-kpi-sql-prod/);
      expect(fs.readFileSync(path.join(ROOT, 'cloudbuild-infra-prod.yaml'), 'utf8')).to.not.match(/cat infra\/env\/prod\.env/);
    });

    it('infra/02 exit 3 is reported, later steps still run, and the final check fails; other codes fail at once', function () {
      if (!BASH) {
        skipOrFail(this, 'no bash was found');
      }
      const step02 = doc.steps[ids(doc).indexOf('infra-02-service-accounts-iam')];
      const check = doc.steps[ids(doc).indexOf('check-infra-02')];
      [[0, 0, 0], [3, 0, 1], [1, 1, 0], [2, 2, 0]].forEach(([rc, stepCode, checkCode]) => {
        const repo = fakeRepo(['infra/02-service-accounts-iam.sh']);
        fs.writeFileSync(path.join(repo, 'rc_02-service-accounts-iam.sh'), String(rc));
        const ws = tmpDir('p8b-ws-');
        const r = runStep(step02, {}, repo, ws);
        expect(r.code, `rc ${rc}`).to.equal(stepCode);
        expect(calls(repo)).to.deep.equal(['02-service-accounts-iam.sh infra/env/prod.env']);
        if (rc === 3) {
          expect(r.err).to.match(/INCOMPLETE \(exit 3\)/);
          expect(fs.existsSync(path.join(ws, 'infra02_incomplete'))).to.equal(true);
        }
        if (stepCode === 0) {
          const c = runStep(check, {}, repo, ws);
          expect(c.code, `check after rc ${rc}`).to.equal(checkCode);
        }
      });
    });
  });

  describe('cloudbuild-prod.yaml', () => {
    const doc = docs['cloudbuild-prod.yaml'];
    const order = ids(doc);
    const at = (id) => {
      const i = order.indexOf(id);
      expect(i, id).to.be.above(-1);
      return i;
    };
    const step = (id) => doc.steps[at(id)];
    const before = (a, b) => expect(at(a), `${a} before ${b}`).to.be.below(at(b));
    const SUBS = {
      _SOURCE_ORG: NONPROD, _SOURCE_ENV: 'staging', _TARGET_ORG: PROD, _TARGET_ENV: 'prod',
      _PROXY: 'sar-mot-kpis-v1', _REGION: 'us-central1', _TARGET: 'prod'
    };
    const RUN_SUBS = Object.assign({}, SUBS, { SHORT_SHA: SHA, COMMIT_SHA: COMMIT, BUILD_ID: 'b-1',
      TRIGGER_NAME: 'sar-mot-kpis-prod' });
    // Steps that change something in prod (the first one is the db load).
    const MUTATIONS = ['db-load-prod', 'apply-int-prod', 'copy-revision-prod', 'create-kvm-prod',
      'debugmask-prod', 'deploy-prod'];

    it('uses the fixed substitutions', () => {
      expect(doc.substitutions).to.deep.equal(SUBS);
    });

    it('the guard pins every substitution and needs SHORT_SHA/COMMIT_SHA from a trigger', function () {
      if (!BASH) {
        skipOrFail(this, 'no bash was found');
      }
      const ws = tmpDir('p8b-ws-');
      const g = (over) => runStep(doc.steps[0], Object.assign({}, RUN_SUBS, over), ROOT, ws);
      expect(g({}).code).to.equal(0);
      const bad = {
        _TARGET: 'nonprod', _SOURCE_ORG: PROD, _SOURCE_ENV: 'dev', _TARGET_ORG: NONPROD, _TARGET_ENV: 'staging',
        _PROXY: 'other', _REGION: 'europe-west1'
      };
      Object.entries(bad).forEach(([k, v]) => {
        const r = g({ [k]: v });
        expect(r.code, k).to.equal(1);
        expect(r.err, k).to.include(`REFUSED: ${k} must be`);
      });
      // TRIGGER_NAME pin (mistake-proofing only, D67): empty under a plain builds submit.
      ['', 'sar-mot-kpis-main', 'sar-mot-kpis-infra-prod'].forEach((t) => {
        const r = g({ TRIGGER_NAME: t });
        expect(r.code, t).to.equal(1);
        expect(r.err, t).to.include('REFUSED: TRIGGER_NAME must be sar-mot-kpis-prod');
      });
      expect(g({ SHORT_SHA: '' }).code).to.equal(1);
      expect(g({ SHORT_SHA: '' }).err).to.match(/run this pipeline from its trigger/);
      expect(g({ COMMIT_SHA: '' }).code).to.equal(1);
      expect(g({ COMMIT_SHA: `def5678${'0'.repeat(33)}` }).code).to.equal(1);
    });

    it('runs the plan order: source checks, record, db, integration, proxy, smoke, check, summary', () => {
      const seq = ['guard-target', 'find-staging-revision', 'check-commit', 'record-prev-prod', 'record-prev-int-prod',
        'db-load-prod', 'apply-int-prod', 'assert-int-prod', 'check-int-prod', 'token-proxy-prod',
        'copy-revision-prod', 'create-kvm-prod', 'debugmask-prod', 'deploy-prod', 'wait-prod', 'verify-sa-prod',
        'smoke-prod', 'check-prod', 'summary'];
      seq.slice(1).forEach((id, i) => before(seq[i], id));
      expect(order[order.length - 1]).to.equal('summary');
      ['install', 'token', 'install-integrationcli'].forEach((s) => before(s, 'find-staging-revision'));
      before('install', 'smoke-prod');
      before('install-integrationcli', 'apply-int-prod');
    });

    it('checks the commit before the first prod change; nothing before it changes anything', () => {
      MUTATIONS.forEach((m) => before('check-commit', m));
      before('record-prev-prod', 'db-load-prod');
      before('record-prev-int-prod', 'db-load-prod');
      const writes = /db\/load\.sh|apply-integration|copy-revision|create-versioned-kvm|deploy-|rollback|create-connection|infra\/0|run-newman/;
      doc.steps.slice(0, at('check-commit')).forEach((s) => {
        expect(stepText(s), s.id).to.not.match(writes);
      });
      // ... and every step up to the db load only reads.
      doc.steps.slice(0, at('db-load-prod')).forEach((s) => {
        expect(stepText(s), s.id).to.not.match(writes);
      });
      const check = stepText(step('check-commit'));
      expect(check).to.include('bash scripts/check-release-commit.sh ${_SOURCE_ORG} ${_PROXY} "$$(cat source_revision.txt)" ${SHORT_SHA} ${COMMIT_SHA} > source_description.txt || {');
      expect(check).to.match(/exit 1; \}/);
    });

    it('finds the staging revision fail-closed and requires it to be READY', () => {
      const t = stepText(step('find-staging-revision'));
      expect(t).to.include('bash scripts/get-deployed-revision.sh ${_SOURCE_ORG} ${_SOURCE_ENV} ${_PROXY} source_revision.txt || {');
      expect(t).to.include('[[ "$$REV" =~ ^[0-9]+$$ ]] || {');
      expect(t).to.include('bash scripts/wait-for-deployment.sh ${_SOURCE_ORG} ${_SOURCE_ENV} ${_PROXY} 60 "$$REV" || {');
      expect(step('record-prev-prod').args).to.deep.equal(['scripts/get-deployed-revision.sh', '${_TARGET_ORG}',
        '${_TARGET_ENV}', '${_PROXY}', 'prev_prod_revision.txt']);
      expect(step('record-prev-int-prod').args).to.deep.equal(['scripts/get-published-integration-version.sh',
        '${_TARGET_ORG}', '${_REGION}', 'sar-kpi-get-prod', 'prev_int_prod.txt']);
    });

    it('find-staging-revision stops on a read error, no deployment, or a revision that is not READY', function () {
      if (!BASH) {
        skipOrFail(this, 'no bash was found');
      }
      const s = step('find-staging-revision');
      const cases = [
        { rc: 1, rev: '', waitRc: 0, code: 1 },
        { rc: 0, rev: '', waitRc: 0, code: 1 },
        { rc: 0, rev: '7', waitRc: 1, code: 1 },
        { rc: 0, rev: '7', waitRc: 0, code: 0 }
      ];
      cases.forEach((c) => {
        const repo = fakeRepo(['scripts/get-deployed-revision.sh', 'scripts/wait-for-deployment.sh']);
        // The fake getter writes its 4th argument like the real one.
        fs.writeFileSync(path.join(repo, 'scripts/get-deployed-revision.sh'), [
          '#!/usr/bin/env bash', `D="${posix(repo)}"`, 'echo "get-deployed-revision.sh $*" >> "$D/calls"',
          `[ ${c.rc} = 0 ] && echo "${c.rev}" > "$4"`, `exit ${c.rc}`].join('\n') + '\n');
        fs.writeFileSync(path.join(repo, 'rc_wait-for-deployment.sh'), String(c.waitRc));
        const r = runStep(s, RUN_SUBS, repo, tmpDir('p8b-ws-'));
        expect(r.code, JSON.stringify(c)).to.equal(c.code);
        expect(calls(repo)[0]).to.equal(`get-deployed-revision.sh ${NONPROD} staging sar-mot-kpis-v1 source_revision.txt`);
        if (c.rev) {
          expect(calls(repo)[1]).to.equal(`wait-for-deployment.sh ${NONPROD} staging sar-mot-kpis-v1 60 7`);
        } else {
          expect(calls(repo).length).to.equal(1);
        }
      });
    });

    it('seeds kpis_prod with the prod env file after the commit check', () => {
      expect(step('db-load-prod').args).to.deep.equal(['db/load.sh', 'prod', 'infra/env/prod.env']);
    });

    it('applies and asserts the prod integration with the commit label; check-int-prod rolls back the integration only', () => {
      expect(step('apply-int-prod').env).to.include('SHORT_SHA=${SHORT_SHA}');
      expect(stepText(step('apply-int-prod'))).to.include('bash scripts/apply-integration-prod.sh ${SHORT_SHA} || {');
      expect(stepText(step('assert-int-prod'))).to.include('bash scripts/assert-integration-prod.sh ${SHORT_SHA} new_int_prod.txt || {');
      const check = stepText(step('check-int-prod'));
      expect(check).to.include('-f /workspace/int_prod_failed');
      expect(check).to.include('scripts/rollback-integration.sh ${_TARGET_ORG} ${_REGION} sar-kpi-get-prod "$$PREV" "$$FAILED"');
      expect(check).to.not.include('scripts/rollback.sh');
      expect(check).to.match(/exit 1\n\s*fi/);
    });

    it('promotes byte-for-byte: copy-revision from staging, no import, stamp, Maven or rebuild', () => {
      const copy = stepText(step('copy-revision-prod'));
      expect(copy).to.include('bash scripts/copy-revision.sh ${_SOURCE_ORG} "$$(cat source_revision.txt)" ${_TARGET_ORG} ${_PROXY}');
      expect(copy).to.include('cmp -s bundle_description.txt source_description.txt');
      // M3: the IMPORTED prod revision is read back from the prod org and compared.
      expect(copy).to.include('bash scripts/check-release-commit.sh ${_TARGET_ORG} ${_PROXY} "$$(cat imported_revision.txt)" ${SHORT_SHA} ${COMMIT_SHA} > imported_description.txt && cmp -s imported_description.txt source_description.txt;');
      const all = fileText(doc);
      expect(all).to.not.match(/stamp-commit|mvn |maven|action=import|-Pprod|-Pdev|npm run lint|apiproxies\//);
      expect(all.match(/scripts\/copy-revision\.sh/g)).to.have.length(1);
    });

    it('creates the prod KVMs with the same commit suffix before the deploy, which uses the prod runtime SA', () => {
      expect(stepText(step('create-kvm-prod'))).to.include('bash scripts/create-versioned-kvm.sh ${_TARGET_ORG} ${_TARGET_ENV} ${SHORT_SHA} ||');
      expect(stepText(step('debugmask-prod'))).to.include('bash scripts/deploy-debugmask-prod.sh ||');
      const deploy = stepText(step('deploy-prod'));
      expect(deploy).to.include(`bash scripts/deploy-revision.sh \${_TARGET_ORG} \${_TARGET_ENV} \${_PROXY} "$$(cat imported_revision.txt)" sa-kpi-proxy-runtime@${PROD}.iam.gserviceaccount.com ||`);
      expect(deploy.indexOf('touch /workspace/prod_proxy_touched')).to.be.above(-1);
      expect(deploy.indexOf('touch /workspace/prod_proxy_touched')).to.be.below(deploy.indexOf('scripts/deploy-revision.sh'));
      expect(stepText(step('wait-prod'))).to.include('scripts/wait-for-deployment.sh ${_TARGET_ORG} ${_TARGET_ENV} ${_PROXY} 600 "$$(cat imported_revision.txt)"');
      expect(stepText(step('verify-sa-prod'))).to.include('scripts/assert-proxy-runtime-sa.sh ${_TARGET_ORG} ${_TARGET_ENV} ${_PROXY} "$$(cat prod_revision.txt)"');
    });

    it('smoke runs only scripts/run-newman-prod.sh, without arguments, and never fails itself', () => {
      const t = stepText(step('smoke-prod'));
      expect(t).to.include('bash scripts/run-newman-prod.sh || {');
      expect(fileText(doc)).to.not.match(/newman run|run-newman\.sh/);
      expect(step('smoke-prod').name).to.equal('node:22');
    });

    it('refreshes the token before the integration, proxy and smoke phases', () => {
      ['token', 'token-int-prod', 'token-proxy-prod', 'token-smoke-prod'].forEach((id) => {
        expect(stepText(step(id)), id).to.include('gcloud auth print-access-token > /workspace/.token');
      });
      before('db-load-prod', 'token-int-prod');
      before('token-int-prod', 'apply-int-prod');
      before('check-int-prod', 'token-proxy-prod');
      before('token-proxy-prod', 'copy-revision-prod');
      before('verify-sa-prod', 'token-smoke-prod');
      before('token-smoke-prod', 'smoke-prod');
    });

    it('from the integration apply on, no step fails the build hard (I-1): flag, then skip', () => {
      const intWriters = doc.steps.slice(at('db-load-prod') + 1, at('check-int-prod'));
      expect(intWriters.map((s) => s.id)).to.deep.equal(['token-int-prod', 'apply-int-prod', 'assert-int-prod']);
      intWriters.forEach((s) => {
        expect(script(s).trim(), s.id).to.match(/\|\| \{ echo "[^"]+" >&2; touch \/workspace\/int_prod_failed; \}$/);
      });
      const proxyWriters = doc.steps.slice(at('check-int-prod') + 1, at('check-prod'));
      expect(proxyWriters.length).to.equal(9);
      proxyWriters.forEach((s) => {
        expect(script(s).split('\n')[0].trim(), s.id).to.equal(
          'if [ -f /workspace/prod_failed ]; then echo "Skipped: an earlier prod step failed."; exit 0; fi');
        expect(script(s).trim(), s.id).to.match(/\|\| \{ echo "[^"]+" >&2; touch \/workspace\/prod_failed; \}$/);
        // no other exit than the skip
        expect(script(s).split('\n').slice(1).join('\n'), s.id).to.not.match(/\bexit\b/);
      });
    });

    it('check-prod rolls back the proxy, then the integration, and exits 1', () => {
      const check = stepText(step('check-prod'));
      expect(check).to.include('-f /workspace/prod_failed');
      const proxy = check.indexOf('bash scripts/rollback.sh ${_TARGET_ORG} ${_TARGET_ENV} ${_PROXY} "$$(cat prev_prod_revision.txt)" "$$FAILED_REV"');
      const integ = check.indexOf('bash scripts/rollback-integration.sh ${_TARGET_ORG} ${_REGION} sar-kpi-get-prod "$$(cat prev_int_prod.txt)" "$$(cat new_int_prod.txt)"');
      expect(proxy).to.be.above(-1);
      expect(integ).to.be.above(proxy);
      expect(check).to.match(/exit 1\n\s*fi/);
    });

    describe('check-prod with fake rollback scripts', () => {
      const REPO_SCRIPTS = ['scripts/rollback.sh', 'scripts/rollback-integration.sh',
        'scripts/get-deployed-revision.sh', 'scripts/get-published-integration-version.sh'];
      function setup(files) {
        const repo = fakeRepo(REPO_SCRIPTS);
        const ws = tmpDir('p8b-ws-');
        Object.entries(files).forEach(([f, v]) => {
          const target = f.startsWith('/workspace/') ? path.join(ws, f.slice('/workspace/'.length)) : path.join(repo, f);
          fs.writeFileSync(target, v);
        });
        return { repo, ws };
      }
      const base = { 'prev_prod_revision.txt': '4\n', 'prev_int_prod.txt': '11\n', 'new_int_prod.txt': '12\n',
        'imported_revision.txt': '5\n' };

      it('passes and touches nothing without the flag', function () {
        if (!BASH) {
          skipOrFail(this, 'no bash was found');
        }
        const { repo, ws } = setup(base);
        const r = runStep(step('check-prod'), RUN_SUBS, repo, ws);
        expect(r.code).to.equal(0);
        expect(calls(repo)).to.deep.equal([]);
      });

      it('after a smoke failure: proxy to the previous revision first, then the integration', function () {
        if (!BASH) {
          skipOrFail(this, 'no bash was found');
        }
        const { repo, ws } = setup(Object.assign({}, base, { 'prod_revision.txt': '5\n',
          '/workspace/prod_failed': '', '/workspace/prod_proxy_touched': '' }));
        const r = runStep(step('check-prod'), RUN_SUBS, repo, ws);
        expect(r.code).to.equal(1);
        expect(calls(repo)).to.deep.equal([
          `rollback.sh ${PROD} prod sar-mot-kpis-v1 4 5`,
          `rollback-integration.sh ${PROD} us-central1 sar-kpi-get-prod 11 12`,
          `get-published-integration-version.sh ${PROD} us-central1 sar-kpi-get-prod int_prod_after_rollback.txt`]);
      });

      it('wait failed (no prod_revision.txt): the imported revision is the failed one; first prod run undeploys it', function () {
        if (!BASH) {
          skipOrFail(this, 'no bash was found');
        }
        const { repo, ws } = setup(Object.assign({}, base, { 'prev_prod_revision.txt': '\n', 'prev_int_prod.txt': '\n',
          '/workspace/prod_failed': '', '/workspace/prod_proxy_touched': '' }));
        const r = runStep(step('check-prod'), RUN_SUBS, repo, ws);
        expect(r.code).to.equal(1);
        expect(calls(repo).slice(0, 2)).to.deep.equal([
          `rollback.sh ${PROD} prod sar-mot-kpis-v1  5`,
          `rollback-integration.sh ${PROD} us-central1 sar-kpi-get-prod  12`]);
      });

      it('a failure before the deploy (copy/KVM/debugmask) rolls back the integration only', function () {
        if (!BASH) {
          skipOrFail(this, 'no bash was found');
        }
        const { repo, ws } = setup(Object.assign({}, base, { '/workspace/prod_failed': '' }));
        const r = runStep(step('check-prod'), RUN_SUBS, repo, ws);
        expect(r.code).to.equal(1);
        expect(r.out).to.match(/needs no rollback/);
        expect(calls(repo)[0]).to.equal(`rollback-integration.sh ${PROD} us-central1 sar-kpi-get-prod 11 12`);
        expect(calls(repo).filter((c) => c.startsWith('rollback.sh'))).to.deep.equal([]);
      });

      it('a failed proxy rollback still rolls back the integration and fails the build', function () {
        if (!BASH) {
          skipOrFail(this, 'no bash was found');
        }
        const { repo, ws } = setup(Object.assign({}, base, { 'prod_revision.txt': '5\n', 'rc_rollback.sh': '1',
          '/workspace/prod_failed': '', '/workspace/prod_proxy_touched': '' }));
        const r = runStep(step('check-prod'), RUN_SUBS, repo, ws);
        expect(r.code).to.equal(1);
        expect(r.err).to.match(/Proxy rollback FAILED: manual intervention required/);
        expect(calls(repo)[1]).to.equal(`rollback-integration.sh ${PROD} us-central1 sar-kpi-get-prod 11 12`);
      });
    });

    it('a skipped proxy step does not run its script', function () {
      if (!BASH) {
        skipOrFail(this, 'no bash was found');
      }
      const repo = fakeRepo(['scripts/copy-revision.sh', 'scripts/deploy-revision.sh', 'scripts/run-newman-prod.sh']);
      const ws = tmpDir('p8b-ws-');
      fs.writeFileSync(path.join(ws, 'prod_failed'), '');
      ['copy-revision-prod', 'deploy-prod', 'smoke-prod'].forEach((id) => {
        expect(runStep(step(id), RUN_SUBS, repo, ws).code, id).to.equal(0);
      });
      expect(calls(repo)).to.deep.equal([]);
      expect(fs.existsSync(path.join(ws, 'prod_proxy_touched'))).to.equal(false);
    });

    it('copy-revision-prod reads the IMPORTED prod revision back and flags a description mismatch (M3)', function () {
      if (!BASH) {
        skipOrFail(this, 'no bash was found');
      }
      const DESC = `sar-mot-kpis-v1 | commit ${SHA} | build b-9\n`;
      [
        { importedDesc: DESC, checkRc: 0, flag: false },
        { importedDesc: `sar-mot-kpis-v1 | commit ${SHA} | build other\n`, checkRc: 0, flag: true },
        { importedDesc: '', checkRc: 1, flag: true }
      ].forEach((c) => {
        const repo = fakeRepo(['scripts/copy-revision.sh', 'scripts/check-release-commit.sh']);
        const ws = tmpDir('p8b-ws-');
        // What the real copy-revision.sh leaves behind (cwd = repo).
        fs.writeFileSync(path.join(repo, 'source_revision.txt'), '7\n');
        fs.writeFileSync(path.join(repo, 'source_description.txt'), DESC);
        fs.writeFileSync(path.join(repo, 'bundle_description.txt'), DESC);
        fs.writeFileSync(path.join(repo, 'imported_revision.txt'), '3\n');
        fs.writeFileSync(path.join(repo, 'out_check-release-commit.sh'), c.importedDesc);
        fs.writeFileSync(path.join(repo, 'rc_check-release-commit.sh'), String(c.checkRc));
        const r = runStep(step('copy-revision-prod'), RUN_SUBS, repo, ws);
        expect(r.code, JSON.stringify(c)).to.equal(0);
        expect(calls(repo)).to.deep.equal([
          `copy-revision.sh ${NONPROD} 7 ${PROD} sar-mot-kpis-v1`,
          `check-release-commit.sh ${PROD} sar-mot-kpis-v1 3 ${SHA} ${COMMIT}`]);
        expect(fs.existsSync(path.join(ws, 'prod_failed')), JSON.stringify(c)).to.equal(c.flag);
      });
    });

    it('check-int-prod says "state unknown" when the post-failure version read fails (L1)', function () {
      if (!BASH) {
        skipOrFail(this, 'no bash was found');
      }
      const repo = fakeRepo(['scripts/get-published-integration-version.sh', 'scripts/rollback-integration.sh']);
      fs.writeFileSync(path.join(repo, 'rc_get-published-integration-version.sh'), '1');
      fs.writeFileSync(path.join(repo, 'prev_int_prod.txt'), '\n');
      const ws = tmpDir('p8b-ws-');
      fs.writeFileSync(path.join(ws, 'int_prod_failed'), '');
      const r = runStep(step('check-int-prod'), RUN_SUBS, repo, ws);
      expect(r.code).to.equal(1);
      expect(r.err).to.match(/state is UNKNOWN\. Manual intervention required/);
      expect(r.out).to.match(/Recorded: prev_int_prod=\[\]/);
    });

    it('a failing smoke run writes the flag and the step itself passes', function () {
      if (!BASH) {
        skipOrFail(this, 'no bash was found');
      }
      const repo = fakeRepo(['scripts/run-newman-prod.sh']);
      fs.writeFileSync(path.join(repo, 'rc_run-newman-prod.sh'), '1');
      const ws = tmpDir('p8b-ws-');
      const r = runStep(step('smoke-prod'), RUN_SUBS, repo, ws);
      expect(r.code).to.equal(0);
      expect(fs.existsSync(path.join(ws, 'prod_failed'))).to.equal(true);
      // no arguments ("<name> " with the trailing space trimmed)
      expect(calls(repo)).to.deep.equal(['run-newman-prod.sh']);
    });
  });

  describe('scripts/check-release-commit.sh (fake gcloud/curl, Python)', function () {
    const SCRIPT = posix(path.join(ROOT, 'scripts', 'check-release-commit.sh'));
    let PYDIR = null;
    before(function () {
      if (!BASH) {
        skipOrFail(this, 'no bash was found');
      }
      PYDIR = findPythonDir();
      if (!PYDIR) {
        skipOrFail(this, 'no Python 3 was found');
      }
    });

    // Fake gcloud (token or failure) and curl (writes FAKE_BODY to -o, prints FAKE_CODE for -w).
    function fakeBin(token) {
      const dir = tmpDir('p8b-bin-');
      const sh = (n, body) => fs.writeFileSync(path.join(dir, n), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      sh('gcloud', token ? `echo "${token}"` : 'exit 1');
      sh('curl', [
        'out=""; url=""',
        'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -w|-H) shift 2;; -*) shift;; *) url="$1"; shift;; esac; done',
        'echo "$url" >> "${0%/*}/curl_urls"',
        'if [ "${FAKE_NET:-0}" = 1 ]; then printf 000; echo "curl: (6) Could not resolve host" >&2; exit 6; fi',
        'printf "%s" "$FAKE_BODY" > "$out"',
        'printf "%s" "${FAKE_CODE:-200}"'
      ].join('\n'));
      return dir;
    }
    function runCheck(args, env, token) {
      const bin = fakeBin(token === undefined ? 'tok' : token);
      const e = Object.assign({}, process.env, { T_BIN: bin, T_PY: PYDIR, FAKE_BODY: '', FAKE_CODE: '200', FAKE_NET: '0' }, env);
      const prelude = [
        'tp() { if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf %s "$1"; fi; }',
        'export PATH="$(tp "$T_BIN"):$(tp "$T_PY"):/usr/bin:/bin"'
      ].join('\n');
      const r = spawnSync(BASH, ['-c', `${prelude}\nexec bash "$@"`, 'bash', SCRIPT].concat(args), { env: e, encoding: 'utf8' });
      const urls = path.join(bin, 'curl_urls');
      return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(),
        urls: fs.existsSync(urls) ? fs.readFileSync(urls, 'utf8').trim().split('\n') : [] };
    }
    const body = (desc) => JSON.stringify({ name: '7', description: desc });
    const ARGS = [NONPROD, 'sar-mot-kpis-v1', '7', SHA, COMMIT];

    it('passes for the matching stamp and prints the description', () => {
      const r = runCheck(ARGS, { FAKE_BODY: body(`sar-mot-kpis-v1 | commit ${SHA} | build b-9`) });
      expect(r.code, r.err).to.equal(0);
      expect(r.out).to.equal(`sar-mot-kpis-v1 | commit ${SHA} | build b-9`);
      expect(r.urls).to.deep.equal([`https://apigee.googleapis.com/v1/organizations/${NONPROD}/apis/sar-mot-kpis-v1/revisions/7`]);
    });

    it('fails on another commit, a longer/shorter stamp, or an unstamped description', () => {
      [`sar-mot-kpis-v1 | commit def5678 | build b-9`, `sar-mot-kpis-v1 | commit ${SHA}0 | build b-9`,
        `sar-mot-kpis-v1 | commit ${SHA.slice(0, 6)} | build b-9`, 'sar-mot-kpis-v1', '',
        `other-proxy | commit ${SHA} | build b-9`, `sar-mot-kpis-v1 | commit ${SHA} | build b 9`].forEach((d) => {
        const r = runCheck(ARGS, { FAKE_BODY: body(d) });
        expect(r.code, d).to.equal(1);
        expect(r.out, d).to.equal('');
      });
    });

    it('fails closed on HTTP errors, a network error, non-JSON and an empty token', () => {
      ['403', '404', '500'].forEach((c) => {
        expect(runCheck(ARGS, { FAKE_CODE: c, FAKE_BODY: '{"error":{}}' }).code, c).to.equal(1);
      });
      expect(runCheck(ARGS, { FAKE_NET: '1' }).code).to.equal(1);
      expect(runCheck(ARGS, { FAKE_BODY: 'not json' }).code).to.equal(1);
      expect(runCheck(ARGS, { FAKE_BODY: '[1]' }).code).to.equal(1);
      const t = runCheck(ARGS, {}, '');
      expect(t.code).to.equal(1);
      expect(t.urls).to.deep.equal([]);
    });

    it('refuses bad arguments before any call (exit 2)', () => {
      [[NONPROD, 'sar-mot-kpis-v1', '7', '', COMMIT], [NONPROD, 'sar-mot-kpis-v1', '7', SHA, ''],
        [NONPROD, 'sar-mot-kpis-v1', '7', SHA, `def5678${'0'.repeat(33)}`], [NONPROD, 'sar-mot-kpis-v1', 'x', SHA, COMMIT],
        [NONPROD, 'sar-mot-kpis-v1', '7', 'ABC1234', COMMIT], [NONPROD, 'sar-mot-kpis-v1', '7', SHA],
        ['', 'sar-mot-kpis-v1', '7', SHA, COMMIT]].forEach((a) => {
        const r = runCheck(a, { FAKE_BODY: body(`sar-mot-kpis-v1 | commit ${SHA} | build b-9`) });
        expect(r.code, JSON.stringify(a)).to.equal(2);
        expect(r.urls, JSON.stringify(a)).to.deep.equal([]);
      });
    });

    it('uses strict mode, set +x, a usage header, LF endings, no prod literal and passes bash -n', () => {
      const text = fs.readFileSync(path.join(ROOT, 'scripts', 'check-release-commit.sh'), 'utf8');
      expect(text).to.not.include('\r');
      expect(text.startsWith('#!/usr/bin/env bash\n')).to.equal(true);
      expect(text).to.match(/set -euo pipefail\nset \+x\n/);
      expect(text).to.match(/usage/);
      expect(text).to.not.include(PROD);
      expect(spawnSync(BASH, ['-n', SCRIPT], { encoding: 'utf8' }).status).to.equal(0);
    });
  });
});
