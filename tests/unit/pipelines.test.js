// Static checks of the Cloud Build pipelines (P7). Offline: parses the YAML with js-yaml and
// checks structure, ordering, escaping and safety invariants. Nothing is run against GCP.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { expect } = require('chai');

const ROOT = path.join(__dirname, '..', '..');
const FILES = ['cloudbuild-pr.yaml', 'cloudbuild-main.yaml', 'cloudbuild-infra.yaml'];
const BUILTINS = ['PROJECT_ID', 'BUILD_ID', 'PROJECT_NUMBER', 'LOCATION', 'REPO_NAME', 'REPO_FULL_NAME',
  'BRANCH_NAME', 'TAG_NAME', 'REVISION_ID', 'COMMIT_SHA', 'SHORT_SHA', 'TRIGGER_NAME',
  'TRIGGER_BUILD_CONFIG_PATH', 'SERVICE_ACCOUNT_EMAIL', 'SERVICE_ACCOUNT'];

const load = (f) => yaml.load(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const stepText = (s) => [s.entrypoint || '', ...(s.args || []), ...(s.env || [])].join('\n');
const fileText = (doc) => doc.steps.map(stepText).join('\n');
const ids = (doc) => doc.steps.map((s) => s.id);

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

describe('Cloud Build pipelines (static)', function () {
  // bash -n per inline script spawns many processes (slow on Windows).
  this.timeout(60000);
  const docs = {};
  FILES.forEach((f) => { docs[f] = load(f); });

  FILES.forEach((f) => {
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
      });

      it('sets no serviceAccount (it is set on the trigger) and uses only stock images', () => {
        expect(doc).to.not.have.property('serviceAccount');
        doc.steps.forEach((s) => expect(s.name, s.id).to.be.oneOf([
          'node:22', 'maven:3.9.9-eclipse-temurin-17', 'gcr.io/google.com/cloudsdktool/cloud-sdk:slim']));
      });

      it('references only files that exist, and referenced scripts are executable in git', () => {
        const refs = new Set(text.match(/\b(?:scripts|tests|db|infra)\/[\w./-]+\.(?:sh|js)\b/g) || []);
        expect(refs.size).to.be.above(0);
        refs.forEach((r) => expect(fs.existsSync(path.join(ROOT, r)), r).to.equal(true));
        const shRefs = [...refs].filter((r) => r.endsWith('.sh'));
        if (shRefs.length === 0) {
          return;
        }
        const ls = spawnSync('git', ['ls-files', '-s', '--', ...shRefs],
          { cwd: ROOT, encoding: 'utf8' });
        const lines = ls.status === 0 ? ls.stdout.trim().split('\n').filter(Boolean) : [];
        // Skipped where there is no git metadata (e.g. a Cloud Build source without .git).
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

      it('escapes shell syntax as $$ (no bare $( or $VAR in step args)', () => {
        doc.steps.forEach((s) => {
          const t = stepText(s);
          expect(t, s.id).to.not.match(/(^|[^$])\$\(/);
          expect(t, s.id).to.not.match(/(^|[^$])\$[A-Za-z_]/);
        });
      });

      it('holds no token or secret literals, no prod project and no --verbose', () => {
        expect(raw).to.not.match(/ya29\.|AIza[0-9A-Za-z_-]{20,}|-----BEGIN|[A-Za-z0-9+/]{40,}={0,2}/);
        expect(raw).to.not.include('apigee-prod-511508');
        expect(raw).to.not.match(/_TARGET:\s*prod/);
        expect(raw).to.not.include('--verbose');
        expect(raw).to.not.match(/set -x|bash -x/);
        expect(text).to.not.match(/cat \/workspace\/\.token[^)]/);
      });

      it('inline scripts are valid bash', function () {
        const bash = findBash();
        if (!bash) {
          this.skip();
        }
        doc.steps.forEach((s) => {
          const sc = inlineScript(s, doc.substitutions || {});
          if (sc !== null) {
            const r = spawnSync(bash, ['-n', '-c', sc], { encoding: 'utf8' });
            expect(r.status, `${s.id}: ${r.stderr}`).to.equal(0);
          }
        });
      });
    });
  });

  describe('cloudbuild-pr.yaml', () => {
    const doc = docs['cloudbuild-pr.yaml'];
    const text = fileText(doc);

    it('runs install, lint, unit tests, OAS lint, collection check and Maven package in order', () => {
      expect(ids(doc)).to.deep.equal(['install', 'lint', 'unit-tests', 'oas-lint', 'collection-check', 'package']);
      expect(stepText(doc.steps[3])).to.match(/@redocly\/cli@\d+\.\d+\.\d+\nlint\napi\/sar-mot-kpis-oas\.yaml/);
      expect(doc.steps[4].args).to.deep.equal(['tests/tools/build-collection.js', '--check']);
      expect(doc.steps[5].args).to.include('package');
    });

    it('has no cloud access: no gcloud, token, deploy or stamping', () => {
      expect(text).to.not.match(/gcloud|\.token|install -P|deploy|stamp-commit|integrationcli|run-newman/);
    });
  });

  describe('cloudbuild-main.yaml', () => {
    const doc = docs['cloudbuild-main.yaml'];
    const order = ids(doc);
    const at = (id) => {
      const i = order.indexOf(id);
      expect(i, id).to.be.above(-1);
      return i;
    };
    const step = (id) => doc.steps[at(id)];
    const before = (a, b) => expect(at(a), `${a} before ${b}`).to.be.below(at(b));

    it('uses the fixed substitutions', () => {
      expect(doc.substitutions).to.deep.equal({
        _ORG: 'apigee-nonprod-511322', _PROXY: 'sar-mot-kpis-v1', _REGION: 'us-central1'
      });
    });

    it('lints and unit-tests the unstamped tree, then stamps before any KVM or deploy', () => {
      before('install', 'lint');
      before('lint', 'stamp-commit');
      before('unit-tests', 'stamp-commit');
      ['create-kvm-dev', 'deploy-dev', 'create-kvm-staging', 'promote-staging'].forEach((s) => before('stamp-commit', s));
      expect(step('stamp-commit').args).to.deep.equal(['scripts/stamp-commit.sh', '${SHORT_SHA}', '${BUILD_ID}']);
    });

    it('writes the token before the first step that reads it', () => {
      const first = doc.steps.findIndex((s) => stepText(s).includes('/workspace/.token')
        && !stepText(s).includes('gcloud auth print-access-token >'));
      expect(at('token')).to.be.below(first === -1 ? Infinity : first);
      ['apply-int-dev', 'debugmask-dev', 'deploy-dev', 'test-dev'].forEach((s) => before('token', s));
    });

    ['dev', 'staging'].forEach((env) => {
      describe(`${env} sequence`, () => {
        const proxyStep = env === 'dev' ? 'deploy-dev' : 'promote-staging';

        it('records the previous versions before changing anything', () => {
          before(`db-load-${env}`, `apply-int-${env}`);
          before(`record-prev-int-${env}`, `apply-int-${env}`);
          before(`record-prev-${env}`, proxyStep);
          before(`create-kvm-${env}`, proxyStep);
          expect(step(`record-prev-int-${env}`).args).to.deep.equal([
            'scripts/get-published-integration-version.sh', '${_ORG}', '${_REGION}', `sar-kpi-get-${env}`,
            `prev_int_${env}.txt`]);
        });

        it('applies, asserts and checks the integration before the proxy', () => {
          before('install-integrationcli', `apply-int-${env}`);
          before(`apply-int-${env}`, `assert-int-${env}`);
          before(`assert-int-${env}`, `check-int-${env}`);
          before(`check-int-${env}`, `debugmask-${env}`);
          before(`debugmask-${env}`, proxyStep);
          expect(step(`apply-int-${env}`).env).to.deep.equal(['SHORT_SHA=${SHORT_SHA}']);
          expect(stepText(step(`apply-int-${env}`))).to.include(`touch /workspace/int_${env}_failed`);
          expect(stepText(step(`assert-int-${env}`))).to.include(
            `scripts/assert-integration.sh ${env} \${SHORT_SHA} new_int_${env}.txt`);
          const check = stepText(step(`check-int-${env}`));
          expect(check).to.include(`-f /workspace/int_${env}_failed`);
          expect(check).to.include('scripts/rollback-integration.sh');
          expect(check).to.match(/exit 1\n\s*fi/);
        });

        it('deploys, waits, verifies the runtime SA, tests, then checks', () => {
          before(proxyStep, `wait-${env}`);
          before(`wait-${env}`, `verify-sa-${env}`);
          before(`verify-sa-${env}`, `test-${env}`);
          before(`test-${env}`, `check-${env}-test`);
          expect(stepText(step(`verify-sa-${env}`))).to.include('scripts/assert-proxy-runtime-sa.sh');
        });

        it('the test step records a flag and never fails; the check step rolls back proxy, then integration', () => {
          const test = stepText(step(`test-${env}`));
          expect(test).to.include(`bash tests/run-newman.sh ${env} || {`);
          expect(test).to.include(`touch /workspace/${env}_test_failed; }`);
          const check = stepText(step(`check-${env}-test`));
          expect(check).to.include(`-f /workspace/${env}_test_failed`);
          const proxy = check.indexOf(`scripts/rollback.sh \${_ORG} ${env} `);
          const integ = check.indexOf(`scripts/rollback-integration.sh \${_ORG} \${_REGION} sar-kpi-get-${env} `);
          expect(proxy).to.be.above(-1);
          expect(integ).to.be.above(proxy);
          expect(check.indexOf('get-published-integration-version.sh')).to.be.above(integ);
          expect(check).to.match(/exit 1\n\s*fi/);
          // A check step only rolls back its own env.
          const other = env === 'dev' ? 'staging' : 'dev';
          check.split('\n').filter((l) => l.includes('scripts/')).forEach((l) => expect(l).to.not.include(other));
        });
      });
    });

    it('runs every staging step strictly after check-dev-test', () => {
      const gate = at('check-dev-test');
      doc.steps.forEach((s, i) => {
        if (s.id.includes('staging')) {
          expect(i, s.id).to.be.above(gate);
        }
      });
      before('check-staging-test', 'summary');
      expect(order[order.length - 1]).to.equal('summary');
    });

    it('promotes the dev revision to staging with deploy-revision.sh (no new import or Maven build)', () => {
      const promote = stepText(step('promote-staging'));
      expect(promote).to.include('scripts/deploy-revision.sh ${_ORG} staging ${_PROXY} "$$(cat dev_revision.txt)"');
      doc.steps.slice(at('check-dev-test')).forEach((s) => {
        expect(s.name, s.id).to.not.match(/^maven/);
        expect(stepText(s), s.id).to.not.match(/mvn |action=import|copy-revision/);
      });
      expect(stepText(step('wait-staging'))).to.include('"$$(cat dev_revision.txt)"');
    });

    it('deploys dev with Maven -Pdev and the shared token, nothing with -Pprod', () => {
      const deploy = stepText(step('deploy-dev'));
      expect(deploy).to.include('clean install -Pdev "-Dbearer=$$(cat /workspace/.token)"');
      expect(fileText(doc)).to.not.match(/-Pprod|-P prod/);
    });

    it('runs Newman only through tests/run-newman.sh for dev and staging', () => {
      const text = fileText(doc);
      expect(text).to.not.match(/newman run/);
      expect((text.match(/tests\/run-newman\.sh \w+/g) || []).sort()).to.deep.equal([
        'tests/run-newman.sh dev', 'tests/run-newman.sh staging']);
    });
  });

  describe('cloudbuild-infra.yaml', () => {
    const doc = docs['cloudbuild-infra.yaml'];

    it('defaults to nonprod and runs infra/01..05 in order, each printed first', () => {
      expect(doc.substitutions).to.deep.equal({ _TARGET: 'nonprod' });
      expect(doc.steps[0].id).to.equal('guard-target');
      const scripts = fs.readdirSync(path.join(ROOT, 'infra')).filter((f) => /^0\d-.*\.sh$/.test(f)).sort();
      const steps = doc.steps.slice(1);
      expect(steps.map((s) => s.id)).to.deep.equal(scripts.map((f) => `infra-${f.replace(/\.sh$/, '')}`));
      steps.forEach((s, i) => {
        const t = stepText(s);
        expect(t.indexOf(`cat infra/${scripts[i]}`), s.id).to.be.above(-1);
        expect(t.indexOf(`cat infra/${scripts[i]}`)).to.be.below(t.indexOf(`bash infra/${scripts[i]} "infra/env/\${_TARGET}.env"`));
      });
    });

    it('the guard step refuses _TARGET=prod (and anything but nonprod) and accepts nonprod', function () {
      const bash = findBash();
      if (!bash) {
        this.skip();
      }
      const run = (target) => spawnSync(bash, ['-c', inlineScript(doc.steps[0], { _TARGET: target })],
        { cwd: ROOT, encoding: 'utf8' });
      const prod = run('prod');
      expect(prod.status).to.equal(1);
      expect(prod.stderr).to.match(/approved prod trigger in P8/);
      expect(run('staging').status).to.equal(1);
      expect(run('nonprod').status).to.equal(0);
    });
  });
});
