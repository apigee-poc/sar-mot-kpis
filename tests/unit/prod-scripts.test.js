// P8 prod guards and prod helper scripts, offline only: fake curl/gcloud/integrationcli shims on a
// controlled PATH; no network, no real gcloud (its bin directory is never on PATH).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { expect } = require('chai');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const INFRA = path.join(ROOT, 'infra');
const posix = (p) => p.replace(/\\/g, '/');
const PROD = 'apigee-prod-511508';
const NONPROD = 'apigee-nonprod-511322';
const PROD_SA = 'cb-deploy-prod@ci-cd-511313.iam.gserviceaccount.com';
const NONPROD_SA = 'cb-deploy-nonprod@ci-cd-511313.iam.gserviceaccount.com';
const NONPROD_TENANT = 'ef911070c468726ff-tp';

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
const PYDIR = BASH ? findPythonDir() : null;
const NODEDIR = path.dirname(process.execPath);

const STRICT = process.env.REQUIRE_BASH_TESTS === '1';
function skipOrFail(ctx, why) {
  if (STRICT) {
    throw new Error(`REQUIRE_BASH_TESTS=1 but ${why}`);
  }
  console.log(`      (skipped: ${why})`);
  ctx.skip();
}

const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
function shim(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

// Runs a bash snippet with PATH = <fakebin>[:<node dir>][:<python dir>]:/usr/bin:/bin, set
// inside bash. BUILD_ID and TARGET are cleared unless opts.env sets them.
function bashWithPath(snippet, args, opts) {
  const o = Object.assign({ fakebin: null, node: false, python: false, env: {} }, opts);
  const env = Object.assign({}, process.env, { BUILD_ID: '', TARGET: '', SHORT_SHA: '' }, o.env, {
    T_FAKEBIN: o.fakebin || '',
    T_NODEDIR: o.node ? NODEDIR : '',
    T_PYDIR: o.python && PYDIR ? PYDIR : ''
  });
  const prelude = [
    'tp() { if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf %s "$1"; fi; }',
    'NP=""',
    '[ -n "$T_FAKEBIN" ] && NP="$(tp "$T_FAKEBIN")"',
    '[ -n "$T_NODEDIR" ] && NP="$NP:$(tp "$T_NODEDIR")"',
    '[ -n "$T_PYDIR" ] && NP="$NP:$(tp "$T_PYDIR")"',
    'NP="$NP:/usr/bin:/bin"',
    'export PATH="${NP#:}"'
  ].join('\n');
  const r = spawnSync(BASH, ['-c', `${prelude}\n${snippet}`, 'bash'].concat(args || []), {
    env, encoding: 'utf8'
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const run = (file, args, opts) => bashWithPath('exec bash "$@"', [posix(file)].concat(args || []), opts);

// Shims that only record that they were called (must stay unused by refused invocations).
function markerBin() {
  const dir = tmpDir('p8-mark-');
  for (const n of ['curl', 'gcloud', 'integrationcli', 'node', 'npx', 'python', 'python3']) {
    shim(dir, n, `echo "${n}" >> "\${0%/*}/called"\nexit 1`);
  }
  return dir;
}
const called = (dir) => fs.existsSync(path.join(dir, 'called'));

// Fake gcloud (prints a token) and a routed fake curl. FAKE_ROUTES is a file of lines
// "<glob>|<http code>|<body file>"; the first glob matching the URL wins (no match: 404, {}).
// FAKE_CURL_NET=1 simulates a network error. integrationcli records its args and the -f
// path's content (FAKE_CLI_CAPTURE) and exits FAKE_CLI_RC (default 0).
function fakeBin(token) {
  const dir = tmpDir('p8-fake-');
  shim(dir, 'gcloud', token ? `echo "${token}"` : 'exit 1');
  shim(dir, 'curl', [
    'out=""; url=""; w=0; fail=0',
    'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -w) w=1; shift 2;; -H|-X|-d|--data-urlencode|--data-binary|-F) shift 2;; --fail|-f) fail=1; shift;; -*) shift;; *) url="$1"; shift;; esac; done',
    'echo "$url" >> "${0%/*}/curl_urls"',
    'if [ "${FAKE_CURL_NET:-0}" = 1 ]; then [ "$w" = 1 ] && printf 000; echo "curl: (6) Could not resolve host" >&2; exit 6; fi',
    'code=404; body=""',
    'if [ -n "${FAKE_ROUTES:-}" ]; then',
    '  while IFS="|" read -r glob c b; do',
    '    [ -z "$glob" ] && continue',
    '    case "$url" in $glob) code="$c"; body="$b"; break;; esac',
    '  done < "$FAKE_ROUTES"',
    'fi',
    'if [ -n "$out" ]; then if [ -n "$body" ]; then cat "$body" > "$out"; else echo "{}" > "$out"; fi; fi',
    'if [ -z "$out" ] && [ -n "$body" ]; then cat "$body"; fi',
    '[ "$w" = 1 ] && printf "%s" "$code"',
    'if [ "$fail" = 1 ] && [ "$code" -ge 400 ]; then exit 22; fi',
    'exit 0'
  ].join('\n'));
  shim(dir, 'integrationcli', [
    'cap="${FAKE_CLI_CAPTURE:-${0%/*}/cli_capture}"',
    'echo "ARGS: $*" > "$cap"',
    'f=""; prev=""',
    'for a in "$@"; do if [ "$prev" = "-f" ]; then f="$a"; fi; prev="$a"; done',
    'if [ -d "$f" ]; then cat "$f"/src/*.json >> "$cap"; elif [ -f "$f" ]; then cat "$f" >> "$cap"; fi',
    'exit "${FAKE_CLI_RC:-0}"'
  ].join('\n'));
  return dir;
}
function bodyFile(obj) {
  const f = path.join(tmpDir('p8-body-'), 'body.json');
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return posix(f);
}
function routes(list) {
  const f = path.join(tmpDir('p8-routes-'), 'routes.txt');
  fs.writeFileSync(f, list.map(([g, c, b]) => `${g}|${c}|${b || ''}`).join('\n') + '\n');
  return posix(f);
}
const runtimeConfig = (tenant) => bodyFile({
  name: `projects/${PROD}/locations/us-central1/runtimeConfig`,
  serviceDirectory: `projects/${tenant}/locations/us-central1/namespaces/connectors/services/runtime`,
  state: 'ACTIVE'
});
const CB = { BUILD_ID: 'b-123', TARGET: 'prod' };

describe('P8 prod guards and prod scripts', function () {
  this.timeout(60000);

  before(function () {
    if (!BASH) {
      skipOrFail(this, 'no bash was found');
    }
  });

  describe('infra/lib/guard.sh', () => {
    const LIB = posix(path.join(INFRA, 'lib', 'guard.sh'));
    function guard(project, sa, env) {
      return bashWithPath(`set -euo pipefail; PROJECT_ID="$1"; CB_DEPLOY_SA="$2"; source "${LIB}"; infra_guard t; echo "IS_PROD=$IS_PROD"`,
        [project, sa], { fakebin: markerBin(), env: env || {} });
    }

    it('prod project without BUILD_ID is refused (exit 2)', () => {
      const r = guard(PROD, PROD_SA, { TARGET: 'prod' });
      expect(r.code).to.equal(2);
      expect(r.err).to.match(/BUILD_ID is not set/);
    });

    it('prod project with BUILD_ID but no TARGET is refused', () => {
      const r = guard(PROD, PROD_SA, { BUILD_ID: 'b' });
      expect(r.code).to.equal(2);
      expect(r.err).to.match(/TARGET=prod is required/);
    });

    it('prod project with the non-prod build SA is refused', () => {
      const r = guard(PROD, NONPROD_SA, CB);
      expect(r.code).to.equal(2);
      expect(r.err).to.match(/CB_DEPLOY_SA must be/);
    });

    it('non-prod project with TARGET=prod is refused (mismatch)', () => {
      const r = guard(NONPROD, NONPROD_SA, CB);
      expect(r.code).to.equal(2);
      expect(r.err).to.match(/mismatch/);
    });

    it('non-prod project with the prod build SA is refused', () => {
      const r = guard(NONPROD, PROD_SA, {});
      expect(r.code).to.equal(2);
    });

    it('unknown or empty project is refused', () => {
      expect(guard('', NONPROD_SA, {}).code).to.equal(2);
      expect(guard('some-other-project', NONPROD_SA, {}).code).to.equal(2);
    });

    it('passes prod inside Cloud Build with TARGET=prod (IS_PROD=1)', () => {
      const r = guard(PROD, PROD_SA, CB);
      expect(r.code, r.err).to.equal(0);
      expect(r.out).to.equal('IS_PROD=1');
    });

    it('passes non-prod unchanged: no BUILD_ID needed (IS_PROD=0)', () => {
      const r = guard(NONPROD, NONPROD_SA, {});
      expect(r.code, r.err).to.equal(0);
      expect(r.out).to.equal('IS_PROD=0');
      expect(guard(NONPROD, NONPROD_SA, { BUILD_ID: 'b', TARGET: 'nonprod' }).out).to.equal('IS_PROD=0');
    });
  });

  describe('scripts/lib/prod-guard.sh', () => {
    const LIB = posix(path.join(SCRIPTS, 'lib', 'prod-guard.sh'));
    const guard = (target, env) => bashWithPath(`set -euo pipefail; source "${LIB}"; prod_guard "$1"; echo PASSED`,
      [target], { fakebin: markerBin(), env });

    it('refuses without BUILD_ID', () => {
      const r = guard(PROD, { TARGET: 'prod' });
      expect(r.code).to.equal(2);
      expect(r.err).to.match(/BUILD_ID is not set/);
    });
    it('refuses with BUILD_ID but no TARGET', () => {
      const r = guard(PROD, { BUILD_ID: 'b' });
      expect(r.code).to.equal(2);
      expect(r.err).to.match(/TARGET must be 'prod'/);
    });
    it('refuses a non-prod target project even inside Cloud Build with TARGET=prod', () => {
      const r = guard(NONPROD, CB);
      expect(r.code).to.equal(2);
      expect(r.err).to.match(/is not apigee-prod-511508/);
    });
    it('passes the correct combination', () => {
      const r = guard(PROD, CB);
      expect(r.code, r.err).to.equal(0);
      expect(r.out).to.equal('PASSED');
    });
  });

  describe('every prod script refuses outside Cloud Build before any tool call', () => {
    const cases = [
      ['apply-integration-prod.sh', ['a1b2c3d']],
      ['assert-integration-prod.sh', ['a1b2c3d']],
      ['deploy-debugmask-prod.sh', []],
      ['run-newman-prod.sh', []],
      ['create-connection.sh', ['prod']]
    ];
    const envs = [
      ['no BUILD_ID, TARGET=prod', { TARGET: 'prod' }],
      ['BUILD_ID, no TARGET', { BUILD_ID: 'b' }],
      ['BUILD_ID, TARGET=staging', { BUILD_ID: 'b', TARGET: 'staging' }],
      ['nothing set', {}]
    ];
    cases.forEach(([script, args]) => {
      envs.forEach(([label, env]) => {
        it(`${script} (${label})`, () => {
          const bin = markerBin();
          const r = run(path.join(SCRIPTS, script), args, { fakebin: bin, env });
          expect(r.code, r.err).to.equal(2);
          expect(r.err).to.match(/REFUSED/);
          expect(called(bin), 'a tool was called').to.equal(false);
        });
      });
    });

    [
      ['apply-integration-prod.sh', ['a1b2c3d', 'x'], /usage/],
      ['apply-integration-prod.sh', ['NOT-A-SHA'], /short_sha/],
      ['apply-integration-prod.sh', [], /short_sha/],
      ['assert-integration-prod.sh', [], /usage/],
      ['assert-integration-prod.sh', ['xyz'], /short_sha/],
      ['deploy-debugmask-prod.sh', ['prod'], /usage/],
      ['run-newman-prod.sh', ['--folder', 'Error rows'], /no arguments allowed/],
      ['run-newman-prod.sh', ['--env-var', 'baseUrl=https://evil.example'], /no arguments allowed/],
      ['create-connection.sh', [], /usage/],
      ['create-connection.sh', ['staging'], /usage/],
      ['create-connection.sh', ['dev'], /usage/]
    ].forEach(([script, args, msg]) => {
      it(`${script} ${JSON.stringify(args)} is refused (exit 2) inside Cloud Build too`, () => {
        const bin = markerBin();
        const r = run(path.join(SCRIPTS, script), args, { fakebin: bin, env: CB });
        expect(r.code).to.equal(2);
        expect(r.err).to.match(msg);
        expect(called(bin), 'a tool was called').to.equal(false);
      });
    });
  });

  describe('infra scripts and db/load.sh with the guard', () => {
    const prodEnv = posix(path.join(INFRA, 'env', 'prod.env'));
    const nonprodEnv = posix(path.join(INFRA, 'env', 'nonprod.env'));
    const infra = ['01-enable-apis.sh', '02-service-accounts-iam.sh', '03-cloudsql-private.sh',
      '04-psc-endpoint-attachment.sh', '05-apigee-products-apps.sh', '06-apigee-prod-product-app.sh'];

    infra.forEach((s) => {
      it(`${s} refuses prod.env outside Cloud Build before any tool call`, () => {
        const bin = markerBin();
        const r = run(path.join(INFRA, s), [prodEnv], { fakebin: bin, env: { TARGET: 'prod' } });
        expect(r.code).to.equal(2);
        expect(r.err).to.match(/REFUSED/);
        expect(called(bin)).to.equal(false);
      });

      it(`${s} refuses nonprod.env with TARGET=prod before any tool call`, () => {
        const bin = markerBin();
        const r = run(path.join(INFRA, s), [nonprodEnv], { fakebin: bin, env: CB });
        expect(r.code).to.equal(2);
        expect(r.err).to.match(/mismatch/);
        expect(called(bin)).to.equal(false);
      });
    });

    it('infra/05 still refuses prod.env inside Cloud Build (non-prod only)', () => {
      const bin = markerBin();
      const r = run(path.join(INFRA, '05-apigee-products-apps.sh'), [prodEnv], { fakebin: bin, env: CB });
      expect(r.code).to.not.equal(0);
      expect(r.err).to.match(/targets apigee-nonprod-511322 only/);
      expect(called(bin)).to.equal(false);
    });

    it('infra/06 refuses the non-prod env file (prod only) before any tool call', () => {
      const bin = markerBin();
      const r = run(path.join(INFRA, '06-apigee-prod-product-app.sh'), [nonprodEnv], { fakebin: bin });
      expect(r.code).to.equal(2);
      expect(r.err).to.match(/prod only/);
      expect(called(bin)).to.equal(false);
    });

    it('infra/06 defaults to prod.env and refuses it outside Cloud Build', () => {
      const bin = markerBin();
      const r = run(path.join(INFRA, '06-apigee-prod-product-app.sh'), [], { fakebin: bin });
      expect(r.code).to.equal(2);
      expect(r.err).to.match(/BUILD_ID is not set/);
      expect(called(bin)).to.equal(false);
    });

    // Recording gcloud: logs every call, answers just enough for infra/02 to run through.
    function recordingGcloud() {
      const dir = tmpDir('p8-rec-');
      shim(dir, 'gcloud', [
        'echo "gcloud $*" >> "${0%/*}/calls"',
        'case "$*" in',
        '  "projects describe"*) echo 123456;;',
        '  "projects get-iam-policy"*) echo roles/integrations.serviceAgent;;',
        'esac',
        'exit 0'
      ].join('\n'));
      return dir;
    }
    const callsOf = (dir) => fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n');
    const members = (calls) => calls.map((c) => (c.match(/--member=serviceAccount:(\S+)/) || [])[1]).filter(Boolean);
    const secretGrants = (calls, role) => calls
      .filter((c) => c.startsWith('gcloud secrets add-iam-policy-binding') && c.includes(`--role=${role}`))
      .map((c) => c.split(' ')[3]);

    it('infra/02 with prod.env grants only cb-deploy-prod, the Apigee roles and the smoke secrets', () => {
      const bin = recordingGcloud();
      const r = run(path.join(INFRA, '02-service-accounts-iam.sh'), [prodEnv], { fakebin: bin, env: CB });
      expect(r.code, r.err).to.equal(0);
      const calls = callsOf(bin);
      calls.forEach((c) => {
        if (c.includes('--project=')) {
          expect(c, c).to.include(`--project=${PROD}`);
        }
      });
      const cb = members(calls).filter((m) => m.startsWith('cb-deploy'));
      expect(cb.length).to.be.above(5);
      cb.forEach((m) => expect(m).to.equal(PROD_SA));
      expect(calls.join('\n')).to.not.include(NONPROD);
      ['roles/apigee.apiAdminV2', 'roles/apigee.environmentAdmin', 'roles/apigee.developerAdmin',
        'roles/integrations.integrationAdmin', 'roles/connectors.admin', 'roles/cloudsql.admin'].forEach((role) => {
        expect(calls.some((c) => c.startsWith(`gcloud projects add-iam-policy-binding ${PROD}`)
          && c.includes(`--member=serviceAccount:${PROD_SA}`) && c.includes(`--role=${role} `)), role).to.equal(true);
      });
      expect(calls.some((c) => c.includes('--member=serviceAccount:service-123456@gcp-sa-integrations.iam.gserviceaccount.com')
        && c.includes('--role=roles/connectors.invoker'))).to.equal(true);
      expect(calls.some((c) => c.startsWith(`gcloud iam service-accounts add-iam-policy-binding sa-kpi-proxy-runtime@${PROD}.iam.gserviceaccount.com`)
        && c.includes('--member=serviceAccount:service-123456@gcp-sa-apigee.iam.gserviceaccount.com')
        && c.includes('--role=roles/iam.serviceAccountTokenCreator'))).to.equal(true);
      ['sa-kpi-proxy-runtime', 'sa-kpi-connector'].forEach((sa) => {
        expect(calls.some((c) => c.startsWith(`gcloud iam service-accounts add-iam-policy-binding ${sa}@${PROD}.iam.gserviceaccount.com`)
          && c.includes(`--member=serviceAccount:${PROD_SA}`) && c.includes('--role=roles/iam.serviceAccountUser')), sa).to.equal(true);
      });
      expect(calls.some((c) => c.startsWith('gcloud storage buckets add-iam-policy-binding gs://apigee-prod-511508-sar-kpi-seed')
        && c.includes('--role=roles/storage.objectAdmin'))).to.equal(true);
      // The build SA reads only the smoke secrets (+ the DB secret's metadata), never the MOT app's.
      const accessor = secretGrants(calls, 'roles/secretmanager.secretAccessor')
        .filter((s, i, a) => a.indexOf(s) === i);
      expect(accessor).to.deep.equal(['sar-kpi-db-reader-password', 'sar-mot-smoke-app-api-key', 'sar-mot-smoke-app-api-secret']);
      expect(calls.filter((c) => c.includes('sar-kpi-db-reader-password') && c.includes('--role=roles/secretmanager.secretAccessor'))
        .every((c) => c.includes(`--member=serviceAccount:sa-kpi-connector@${PROD}.iam.gserviceaccount.com`))).to.equal(true);
      expect(secretGrants(calls, 'roles/secretmanager.viewer')).to.deep.equal(['sar-kpi-db-reader-password']);
      expect(calls.join('\n')).to.not.match(/sar-mot-app-api|sar-mot-poc-/);
    });

    it('infra/02 with nonprod.env ignores leaked prod switches (IS_PROD/NEWMAN_SECRETS in the environment)', () => {
      const bin = recordingGcloud();
      const r = run(path.join(INFRA, '02-service-accounts-iam.sh'), [nonprodEnv], {
        fakebin: bin, env: { IS_PROD: '1', NEWMAN_SECRETS: 'sar-mot-smoke-app-api-key' }
      });
      expect(r.code, r.err).to.equal(0);
      const calls = callsOf(bin);
      expect(calls.join('\n')).to.not.match(/roles\/apigee\.|secretmanager\.viewer|mot-smoke|apigee-prod-511508/);
      members(calls).filter((m) => m.startsWith('cb-deploy')).forEach((m) => expect(m).to.equal(NONPROD_SA));
      expect(secretGrants(calls, 'roles/secretmanager.secretAccessor').filter((s) => s.startsWith('sar-mot-')))
        .to.deep.equal(['sar-mot-poc-app-api-key', 'sar-mot-poc-app-api-secret', 'sar-mot-poc-other-app-api-key',
          'sar-mot-poc-other-app-api-secret']);
    });

    it('db/load.sh prod refuses outside Cloud Build, and a mismatched env/env file', () => {
      const load = path.join(ROOT, 'db', 'load.sh');
      [
        [['prod'], {}],
        [['prod', nonprodEnv], {}],
        [['dev', prodEnv], CB],
        [['dev'], CB]
      ].forEach(([args, env]) => {
        const bin = markerBin();
        const r = run(load, args, { fakebin: bin, env });
        expect(r.code, JSON.stringify(args)).to.equal(2);
        expect(r.err).to.match(/REFUSED/);
        expect(called(bin)).to.equal(false);
      });
    });
  });

  describe('apply-integration-prod.sh tenant resolution (fake curl/integrationcli, real node)', () => {
    const APPLY = path.join(SCRIPTS, 'apply-integration-prod.sh');
    function apply(rcBody, code) {
      const bin = fakeBin('fake-token-xyz');
      const r = run(APPLY, ['a1b2c3d'], {
        fakebin: bin, node: true,
        env: Object.assign({}, CB, { FAKE_ROUTES: routes([['*/runtimeConfig', code || '200', rcBody]]) })
      });
      const capFile = path.join(bin, 'cli_capture');
      return Object.assign(r, { cap: fs.existsSync(capFile) ? fs.readFileSync(capFile, 'utf8') : null });
    }

    it('refuses the non-prod tenant and never runs integrationcli', () => {
      const r = apply(runtimeConfig(NONPROD_TENANT));
      expect(r.code).to.equal(1);
      expect(r.err).to.match(/non-prod Connectors tenant/);
      expect(r.cap).to.equal(null);
    });

    it('refuses a serviceDirectory of another shape', () => {
      const r = apply(bodyFile({ serviceDirectory: 'projects/x-tp/locations/europe-west1/namespaces/connectors/services/runtime' }));
      expect(r.code).to.equal(1);
      expect(r.err).to.match(/unexpected serviceDirectory/);
      expect(r.cap).to.equal(null);
    });

    it('refuses when runtimeConfig has no serviceDirectory', () => {
      const r = apply(bodyFile({ state: 'ACTIVE' }));
      expect(r.code).to.equal(1);
      expect(r.err).to.match(/no serviceDirectory/);
      expect(r.cap).to.equal(null);
    });

    ['403', '500'].forEach((code) => {
      it(`fails closed on runtimeConfig HTTP ${code}`, () => {
        const r = apply(bodyFile({ error: { code: Number(code) } }), code);
        expect(r.code).to.equal(1);
        expect(r.err).to.include(`HTTP ${code}`);
        expect(r.cap).to.equal(null);
        expect(r.err).to.not.include('fake-token-xyz');
      });
    });

    it('resolves the tenant, stamps userLabel and runs apply with the D20 flags against prod', () => {
      const r = apply(runtimeConfig('abc123def456-tp'));
      expect(r.code, r.err).to.equal(0);
      expect(r.cap).to.match(/^ARGS: integrations apply -f \S+ --skip-connectors=true --wait=true --run-tests=true -p apigee-prod-511508 -r us-central1 -t fake-token-xyz\n/);
      expect(r.cap).to.not.match(/ -e /);
      const src = JSON.parse(r.cap.slice(r.cap.indexOf('\n') + 1));
      expect(src.userLabel).to.equal('a1b2c3d');
      const conn = JSON.parse(src.taskConfigs.find((t) => t.taskId === '2').parameters.config.value.jsonValue).connection;
      expect(conn.serviceName).to.equal('projects/abc123def456-tp/locations/us-central1/namespaces/connectors/services/runtime');
      expect(conn.connectionName).to.equal('projects/apigee-prod-511508/locations/us-central1/connections/sar-kpi-db-prod');
      expect(r.cap).to.not.include('__PROD_');
      expect(`${r.out}\n${r.err}`).to.not.include('fake-token-xyz');
      // The committed source is unchanged.
      expect(fs.readFileSync(path.join(ROOT, 'integration', 'prod', 'src', 'sar-kpi-get-prod.json'), 'utf8'))
        .to.include('__PROD_CONNECTORS_TENANT_PROJECT__');
    });
  });

  describe('create-connection.sh (fake curl/integrationcli, real node)', () => {
    const CREATE = path.join(SCRIPTS, 'create-connection.sh');
    const CONN = '*/connections/sar-kpi-db-prod';
    const EA = '*/endpointAttachments/sar-kpi-sql-prod-ea*';
    const SV = '*/secrets/sar-kpi-db-reader-password/versions/latest';
    const svBody = () => bodyFile({ name: `projects/123/secrets/sar-kpi-db-reader-password/versions/3`, state: 'ENABLED' });
    function create(list) {
      const bin = fakeBin('fake-token-xyz');
      const r = run(CREATE, ['prod'], { fakebin: bin, node: true, env: Object.assign({}, CB, { FAKE_ROUTES: routes(list), FAKE_CLI_RC: '7' }) });
      const capFile = path.join(bin, 'cli_capture');
      return Object.assign(r, { cap: fs.existsSync(capFile) ? fs.readFileSync(capFile, 'utf8') : null });
    }

    it('an ACTIVE connection is left alone (exit 0, no create)', () => {
      const r = create([[CONN, '200', bodyFile({ status: { state: 'ACTIVE' } })]]);
      expect(r.code, r.err).to.equal(0);
      expect(r.out).to.match(/already exists and is ACTIVE/);
      expect(r.cap).to.equal(null);
    });

    it('a connection in another state fails without re-creating it', () => {
      const r = create([[CONN, '200', bodyFile({ status: { state: 'ERROR' } })]]);
      expect(r.code).to.equal(1);
      expect(r.cap).to.equal(null);
    });

    it('fails closed on a 403 reading the connection', () => {
      const r = create([[CONN, '403', bodyFile({ error: { code: 403 } })]]);
      expect(r.code).to.equal(1);
      expect(r.err).to.include('HTTP 403');
      expect(r.cap).to.equal(null);
    });

    it('refuses an endpoint attachment that is not ACCEPTED', () => {
      const r = create([[CONN, '404', bodyFile({})], [EA, '200', bodyFile({ state: 'PENDING', endpointIp: '10.1.2.3' })]]);
      expect(r.code).to.equal(1);
      expect(r.err).to.match(/not ACCEPTED/);
      expect(r.cap).to.equal(null);
    });

    it('refuses an endpoint attachment without an IPv4 endpointIp', () => {
      const r = create([[CONN, '404', bodyFile({})], [EA, '200', bodyFile({ state: 'ACCEPTED' })]]);
      expect(r.code).to.equal(1);
      expect(r.err).to.match(/no IPv4 endpointIp/);
      expect(r.cap).to.equal(null);
    });

    it('refuses a DB secret without an ENABLED version', () => {
      const r = create([[CONN, '404', bodyFile({})], [EA, '200', bodyFile({ state: 'ACCEPTED', endpointIp: '10.1.2.3' })],
        [SV, '200', bodyFile({ name: 'projects/1/secrets/s/versions/2', state: 'DISABLED' })]]);
      expect(r.code).to.equal(1);
      expect(r.err).to.match(/no ENABLED latest version/);
      expect(r.cap).to.equal(null);
    });

    it('creates from a resolved temp copy (IP + secret version) and propagates a create failure', () => {
      const r = create([[CONN, '404', bodyFile({})], [EA, '200', bodyFile({ state: 'ACCEPTED', endpointIp: '10.1.2.3' })],
        [SV, '200', svBody()]]);
      expect(r.code).to.equal(7);
      expect(r.cap).to.match(/^ARGS: connectors create -n sar-kpi-db-prod -f \S+ -p apigee-prod-511508 -r us-central1 -t fake-token-xyz --wait=true\n/);
      const j = JSON.parse(r.cap.slice(r.cap.indexOf('\n') + 1));
      expect(j.destinationConfigs[0].destinations[0]).to.deep.equal({ host: '10.1.2.3', port: 5432 });
      expect(j.authConfig.userPassword.password.secretVersion)
        .to.equal('projects/apigee-prod-511508/secrets/sar-kpi-db-reader-password/versions/3');
      expect(j.serviceAccount).to.equal('sa-kpi-connector@apigee-prod-511508.iam.gserviceaccount.com');
      expect(`${r.out}\n${r.err}`).to.not.include('fake-token-xyz');
    });
  });

  describe('assert-integration-prod.sh (fake curl, Python)', function () {
    before(function () {
      if (!PYDIR) {
        skipOrFail(this, 'no Python 3 was found');
      }
    });
    const PREFIX = `projects/${PROD}/locations/us-central1/integrations/sar-kpi-get-prod/versions/`;
    const LIST = { integrationVersions: [{ name: `${PREFIX}v-new`, state: 'ACTIVE', updateTime: '2026-11-01T00:00:00Z' }] };
    function version(mutate) {
      const text = fs.readFileSync(path.join(ROOT, 'integration', 'prod', 'src', 'sar-kpi-get-prod.json'), 'utf8')
        .split('__PROD_CONNECTORS_TENANT_PROJECT__').join('abc123def456-tp');
      const v = JSON.parse(text);
      v.name = `${PREFIX}v-new`;
      v.state = 'ACTIVE';
      v.userLabel = 'a1b2c3d';
      if (mutate) {
        mutate(v);
      }
      return v;
    }
    const connector = (v) => v.taskConfigs.find((t) => t.task === 'GenericConnectorTask');
    function assertRun(v, sha) {
      return run(path.join(SCRIPTS, 'assert-integration-prod.sh'), [sha || 'a1b2c3d'], {
        fakebin: fakeBin('fake-token-xyz'), python: true,
        env: Object.assign({}, CB, { FAKE_ROUTES: routes([['*/versions', '200', bodyFile(LIST)], ['*/versions/v-new', '200', bodyFile(v)]]) })
      });
    }

    it('passes for the resolved prod src with the expected label', () => {
      const r = assertRun(version());
      expect(r.code, r.err).to.equal(0);
      expect(r.out).to.equal('v-new');
      expect(r.err).to.not.include('fake-token-xyz');
    });

    it('fails on a wrong userLabel', () => {
      const r = assertRun(version(), 'ffffff0');
      expect(r.code).to.equal(1);
      expect(r.err).to.match(/userLabel is 'a1b2c3d', expected 'ffffff0'/);
    });

    it('fails on an unresolved tenant placeholder', () => {
      const r = assertRun(version((v) => {
        const p = connector(v).parameters.config.value;
        p.jsonValue = p.jsonValue.replace('abc123def456-tp', '__PROD_CONNECTORS_TENANT_PROJECT__');
      }));
      expect(r.code).to.equal(1);
      expect(r.err).to.match(/serviceName/);
      expect(r.err).to.match(/__PROD_/);
    });

    it('fails on the non-prod tenant or a non-prod connection', () => {
      const r1 = assertRun(version((v) => {
        const p = connector(v).parameters.config.value;
        p.jsonValue = p.jsonValue.replace('abc123def456-tp', NONPROD_TENANT);
      }));
      expect(r1.code).to.equal(1);
      expect(r1.err).to.include(NONPROD_TENANT);
      const r2 = assertRun(version((v) => {
        const p = connector(v).parameters.config.value;
        p.jsonValue = p.jsonValue.replace(`projects/${PROD}/locations/us-central1/connections/sar-kpi-db-prod`,
          `projects/${NONPROD}/locations/us-central1/connections/sar-kpi-db-staging`);
      }));
      expect(r2.code).to.equal(1);
      expect(r2.err).to.match(/connectionName is/);
    });

    it('fails on the staging trigger', () => {
      const r = assertRun(version((v) => { v.triggerConfigs[0].triggerId = 'api_trigger/sar-kpi-get-staging'; }));
      expect(r.code).to.equal(1);
      expect(r.err).to.match(/triggerId 'api_trigger\/sar-kpi-get-staging'/);
    });

    it('fails when there is no ACTIVE version', () => {
      const r = run(path.join(SCRIPTS, 'assert-integration-prod.sh'), ['a1b2c3d'], {
        fakebin: fakeBin('t'), python: true,
        env: Object.assign({}, CB, { FAKE_ROUTES: routes([['*/versions', '200', bodyFile({})]]) })
      });
      expect(r.code).to.equal(1);
      expect(r.err).to.match(/no ACTIVE version/);
    });
  });

  describe('prod scripts fail closed on an empty token (no network call)', () => {
    [
      ['apply-integration-prod.sh', ['a1b2c3d']],
      ['assert-integration-prod.sh', ['a1b2c3d']],
      ['deploy-debugmask-prod.sh', []],
      ['create-connection.sh', ['prod']]
    ].forEach(([script, args]) => {
      it(`${script}: no gcloud token and no /workspace/.token -> exit 1`, function () {
        if (fs.existsSync('/workspace/.token')) {
          this.skip();
        }
        const bin = fakeBin(null);
        const r = run(path.join(SCRIPTS, script), args, { fakebin: bin, node: true, python: true, env: CB });
        expect(r.code, r.err).to.equal(1);
        expect(r.err).to.match(/access token/);
        expect(fs.existsSync(path.join(bin, 'curl_urls')), 'curl was called').to.equal(false);
        expect(fs.existsSync(path.join(bin, 'cli_capture')), 'integrationcli was called').to.equal(false);
      });
    });

    it('run-newman-prod.sh stops when a smoke secret cannot be read (newman never runs)', () => {
      const bin = fakeBin(null);
      shim(bin, 'npx', 'echo "npx $*" >> "${0%/*}/npx_calls"; exit 0');
      const r = run(path.join(SCRIPTS, 'run-newman-prod.sh'), [], { fakebin: bin, node: true, env: CB });
      expect(r.code).to.not.equal(0);
      expect(fs.existsSync(path.join(bin, 'npx_calls'))).to.equal(false);
    });
  });

  describe('prod helpers with fake tools (happy paths)', () => {
    it('run-newman-prod.sh runs only "Happy paths" with the prod env file and never prints the credentials', () => {
      const bin = tmpDir('p8-newman-');
      shim(bin, 'gcloud', [
        'echo "gcloud $*" >> "${0%/*}/gcloud_calls"',
        'case "$*" in',
        '  *"--secret=sar-mot-smoke-app-api-key "*) printf %s SMOKEKEY123;;',
        '  *"--secret=sar-mot-smoke-app-api-secret "*) printf %s SMOKESECRET456;;',
        '  *) exit 1;;',
        'esac'
      ].join('\n'));
      shim(bin, 'npx', 'for a in "$@"; do printf "%s\\n" "$a"; done > "${0%/*}/npx_args"; exit 0');
      const r = run(path.join(SCRIPTS, 'run-newman-prod.sh'), [], { fakebin: bin, node: true, env: CB });
      expect(r.code, r.err).to.equal(0);
      const gcalls = fs.readFileSync(path.join(bin, 'gcloud_calls'), 'utf8');
      expect(gcalls).to.include(`--project=${PROD}`);
      const args = fs.readFileSync(path.join(bin, 'npx_args'), 'utf8').trim().split('\n');
      expect(args).to.deep.equal(['--no-install', 'newman', 'run', 'tests/sar-mot-kpis.postman_collection.json',
        '-e', 'tests/environments/prod.postman_environment.json', '--folder', 'Happy paths',
        '--env-var', 'apiKey=SMOKEKEY123', '--env-var', 'apiSecret=SMOKESECRET456',
        '--reporters', 'cli,junit', '--reporter-junit-export', 'reports/newman-prod-smoke.xml']);
      expect(`${r.out}\n${r.err}`).to.not.match(/SMOKEKEY123|SMOKESECRET456/);
    });

    it('deploy-debugmask-prod.sh PATCHes the prod env mask and checks every variable came back', () => {
      const mask = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'main', 'apigee', 'environments', 'prod', 'debugmask.json'), 'utf8'));
      const ok = fakeBin('fake-token-xyz');
      const r = run(path.join(SCRIPTS, 'deploy-debugmask-prod.sh'), [], {
        fakebin: ok, node: true,
        env: Object.assign({}, CB, { FAKE_ROUTES: routes([['*/debugmask*', '200', bodyFile({ variables: mask.variables })]]) })
      });
      expect(r.code, r.err).to.equal(0);
      expect(r.out).to.equal(`Debug mask deployed to prod: ${mask.variables.length} variables`);
      expect(fs.readFileSync(path.join(ok, 'curl_urls'), 'utf8').trim())
        .to.equal(`https://apigee.googleapis.com/v1/organizations/${PROD}/environments/prod/debugmask?updateMask=variables`);
      const partial = fakeBin('fake-token-xyz');
      const r2 = run(path.join(SCRIPTS, 'deploy-debugmask-prod.sh'), [], {
        fakebin: partial, node: true,
        env: Object.assign({}, CB, { FAKE_ROUTES: routes([['*/debugmask*', '200', bodyFile({ variables: mask.variables.slice(1) })]]) })
      });
      expect(r2.code).to.equal(1);
      expect(`${r2.out}\n${r2.err}`).to.not.include('fake-token-xyz');
    });

    it('get-deployed-revision.sh takes the prod org explicitly (unchanged script, fails closed)', function () {
      if (!PYDIR) {
        skipOrFail(this, 'no Python 3 was found');
      }
      const getter = path.join(SCRIPTS, 'get-deployed-revision.sh');
      const bin = fakeBin('t');
      const r = run(getter, [PROD, 'prod', 'sar-mot-kpis-v1'], {
        fakebin: bin, python: true,
        env: { FAKE_ROUTES: routes([['*/deployments', '200', bodyFile({ deployments: [{ revision: '4' }, { revision: '7' }] })]]) }
      });
      expect(r.code, r.err).to.equal(0);
      expect(r.out).to.equal('7');
      expect(fs.readFileSync(path.join(bin, 'curl_urls'), 'utf8').trim())
        .to.equal(`https://apigee.googleapis.com/v1/organizations/${PROD}/environments/prod/apis/sar-mot-kpis-v1/deployments`);
      const r403 = run(getter, [PROD, 'prod', 'sar-mot-kpis-v1'], {
        fakebin: fakeBin('t'), python: true, env: { FAKE_ROUTES: routes([['*/deployments', '403', bodyFile({})]]) }
      });
      expect(r403.code).to.equal(1);
    });
  });

  describe('static checks', () => {
    const PROD_SCRIPTS = ['apply-integration-prod.sh', 'assert-integration-prod.sh', 'deploy-debugmask-prod.sh',
      'run-newman-prod.sh', 'create-connection.sh'];
    const ALL = PROD_SCRIPTS.map((f) => `scripts/${f}`).concat([
      'scripts/lib/prod-guard.sh', 'scripts/lib/connectors-tenant.sh', 'infra/lib/guard.sh',
      'infra/06-apigee-prod-product-app.sh']);

    it('prod scripts use strict mode, set +x, a usage header, LF endings and pass bash -n', () => {
      ALL.forEach((f) => {
        const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
        expect(text, f).to.not.include('\r');
        expect(text.startsWith('#!/usr/bin/env bash\n'), f).to.equal(true);
        if (!f.includes('/lib/')) {
          expect(text, f).to.match(/set -euo pipefail\n(#[^\n]*\n)?set \+x\n/);
          expect(text, f).to.match(/usage/i);
        }
        const r = spawnSync(BASH, ['-n', posix(path.join(ROOT, f))], { encoding: 'utf8' });
        expect(r.status, `${f}: ${r.stderr}`).to.equal(0);
      });
    });

    it('prod scripts call the guard before any token, gcloud, curl or Python', () => {
      PROD_SCRIPTS.forEach((f) => {
        // Code only: comment lines may name the tools.
        const text = fs.readFileSync(path.join(SCRIPTS, f), 'utf8').split('\n')
          .filter((l) => !/^\s*#/.test(l)).join('\n');
        const g = text.indexOf('prod_guard "');
        expect(g, f).to.be.above(-1);
        ['gcloud auth', 'curl ', 'lib/python.sh"', 'TOKEN="$('].forEach((tool) => {
          const i = text.indexOf(tool);
          if (i > -1) {
            expect(i, `${f}: ${tool}`).to.be.above(g);
          }
        });
      });
    });

    it('new scripts are mode 100755 in git', () => {
      const ls = spawnSync('git', ['ls-files', '-s', '--', ...ALL.filter((f) => !f.includes('/lib/')), 'infra/lib/guard.sh'],
        { cwd: ROOT, encoding: 'utf8' });
      const lines = ls.status === 0 ? ls.stdout.trim().split('\n').filter(Boolean) : [];
      if (lines.length === 0 && !fs.existsSync(path.join(ROOT, '.git'))) {
        console.log('      (WARNING: script modes not checked: no git metadata)');
        return;
      }
      expect(lines.length).to.equal(ALL.filter((f) => !f.includes('/lib/')).length + 1);
      lines.forEach((l) => expect(l.split(/\s+/)[0], l).to.equal('100755'));
    });

    it('prod.env defines every nonprod.env key, targets prod and holds no secret', () => {
      const keys = (f) => {
        const out = {};
        fs.readFileSync(path.join(INFRA, 'env', f), 'utf8').split('\n').forEach((l) => {
          const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
          if (m) {
            out[m[1]] = m[2];
          }
        });
        return out;
      };
      const np = keys('nonprod.env');
      const p = keys('prod.env');
      Object.keys(np).forEach((k) => expect(p, k).to.have.property(k));
      expect(p.PROJECT_ID).to.equal(`"${PROD}"`);
      expect(p.REGION).to.equal('"us-central1"');
      expect(p.CI_CD_PROJECT_ID).to.equal('"ci-cd-511313"');
      expect(p.CB_DEPLOY_SA).to.equal(`"${PROD_SA}"`);
      expect(p.SQL_INSTANCE).to.equal('"sar-kpi-sql-prod"');
      expect(p.DB_PROD).to.equal('"kpis_prod"');
      expect(p.DB_DEV).to.equal('""');
      expect(p.DB_STAGING).to.equal('""');
      expect(p.SEED_BUCKET).to.equal('"apigee-prod-511508-sar-kpi-seed"');
      expect(p.PSC_ENDPOINT_ATTACHMENT).to.equal('"sar-kpi-sql-prod-ea"');
      expect(p.CONNECTION_PROD).to.equal('"sar-kpi-db-prod"');
      expect(p.NEWMAN_SECRETS).to.equal('"sar-mot-smoke-app-api-key sar-mot-smoke-app-api-secret"');
      const raw = fs.readFileSync(path.join(INFRA, 'env', 'prod.env'), 'utf8');
      expect(raw).to.not.include('\r');
      expect(raw.split('\n').filter((l) => !l.startsWith('#')).join('\n'))
        .to.not.match(/nonprod|kpis_dev|kpis_staging|cb-deploy-nonprod/i);
      Object.keys(p).forEach((k) => expect(k).to.not.match(/PASSWORD|TOKEN|CREDENTIAL/));
      expect(raw).to.not.match(/ya29\.|AIza|BEGIN [A-Z ]*PRIVATE KEY/);
    });

    it('infra/02 and infra/04 switch their prod-only steps on IS_PROD, never on an env-file variable', () => {
      const t02 = fs.readFileSync(path.join(INFRA, '02-service-accounts-iam.sh'), 'utf8');
      const t04 = fs.readFileSync(path.join(INFRA, '04-psc-endpoint-attachment.sh'), 'utf8');
      expect(t02.split('if [[ "${IS_PROD}" == "1" ]]; then').length - 1).to.equal(3);
      expect(t04.split('if [[ "${IS_PROD}" == "1" ]]; then').length - 1).to.equal(2);
      [t02, t04].forEach((t) => expect(t).to.not.match(/GRANT_APIGEE_DEPLOY_ROLES|PSC_ALLOW_CONNECTORS_TENANT/));
      expect(t02).to.not.match(/sar-mot-app-api|mot-smoke/);
      ['nonprod.env', 'prod.env'].forEach((f) => {
        const text = fs.readFileSync(path.join(INFRA, 'env', f), 'utf8');
        expect(text, f).to.not.match(/GRANT_APIGEE_DEPLOY_ROLES|PSC_ALLOW_CONNECTORS_TENANT/);
        // An env file that set these would satisfy the guard by itself.
        expect(text, f).to.not.match(/^\s*(export\s+)?(TARGET|BUILD_ID|IS_PROD)=/m);
      });
    });

    it('infra/06 grants the build SA only the smoke secrets, never the MOT handover secrets', () => {
      const text = fs.readFileSync(path.join(INFRA, '06-apigee-prod-product-app.sh'), 'utf8');
      const grant = text.slice(text.indexOf('# --- Smoke secret access'), text.indexOf('echo "SUCCESS'));
      expect(grant).to.include('for secret in "${SECRET_SMOKE_KEY}" "${SECRET_SMOKE_SECRET}"; do');
      expect(grant).to.not.match(/SECRET_MOT_/);
      expect(text).to.match(/"environments": \[env\]/);
      expect(text).to.include('"/kpis/**"');
      expect(text).to.not.match(/echo[^\n]*\$\{?BODY/);
    });

    it('run-newman-prod.sh runs only the Happy paths folder against the prod host', () => {
      const text = fs.readFileSync(path.join(SCRIPTS, 'run-newman-prod.sh'), 'utf8');
      expect(text).to.include('readonly FOLDER="Happy paths"');
      expect(text).to.include('readonly BASE_URL="https://prod.35.201.86.122.nip.io"');
      expect((text.match(/--folder/g) || []).length).to.equal(1);
      expect(text).to.not.match(/echo[^\n]*\$\{?(API_KEY|API_SECRET|token)\b/);
      const env = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'environments', 'prod.postman_environment.json'), 'utf8'));
      expect(env.values.find((v) => v.key === 'baseUrl').value).to.equal('https://prod.35.201.86.122.nip.io');
    });

    it('non-prod scripts, infra, db and pipelines never contain the prod project (except the infra/05 guard)', () => {
      const allowed = new Set(PROD_SCRIPTS.map((f) => `scripts/${f}`).concat([
        'scripts/lib/prod-guard.sh', 'infra/lib/guard.sh', 'infra/06-apigee-prod-product-app.sh']));
      const files = []
        .concat(fs.readdirSync(SCRIPTS).filter((f) => f.endsWith('.sh')).map((f) => `scripts/${f}`))
        .concat(fs.readdirSync(path.join(SCRIPTS, 'lib')).map((f) => `scripts/lib/${f}`))
        .concat(fs.readdirSync(INFRA).filter((f) => f.endsWith('.sh')).map((f) => `infra/${f}`))
        .concat(['db/load.sh', 'tests/run-newman.sh', 'infra/env/nonprod.env'])
        .concat(['cloudbuild-pr.yaml', 'cloudbuild-main.yaml', 'cloudbuild-infra.yaml']);
      files.filter((f) => !allowed.has(f)).forEach((f) => {
        const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').filter((l) => l.includes(PROD));
        if (f === 'infra/05-apigee-products-apps.sh') {
          expect(lines, f).to.deep.equal(['PROD_PROJECT="apigee-prod-511508"']);
        } else {
          expect(lines, f).to.deep.equal([]);
        }
      });
    });
  });
});
