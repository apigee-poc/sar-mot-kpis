// P7 pipeline helper scripts, offline only: fake python/gcloud/curl/integrationcli shims on a
// controlled PATH; no network, no real gcloud (its bin directory is never on PATH).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { expect } = require('chai');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const BUNDLE = path.join(ROOT, 'src', 'main', 'apigee', 'apiproxies', 'sar-mot-kpis-v1', 'apiproxy');
const posix = (p) => p.replace(/\\/g, '/');

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

// Directory of a real Python 3 (for the scripts that parse JSON), or null. Probed from node.
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

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function shim(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

// Runs a bash snippet with PATH = <fakebin>[:<python dir>][:/usr/bin:/bin], set inside bash
// (PATH is never built in node: Windows drive letters and Path/PATH keys would break it).
function bashWithPath(snippet, args, opts) {
  const o = Object.assign({ fakebin: null, python: false, system: true, env: {} }, opts);
  const env = Object.assign({}, process.env, o.env, {
    T_FAKEBIN: o.fakebin || '',
    T_PYDIR: o.python && PYDIR ? PYDIR : ''
  });
  const prelude = [
    'tp() { if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf %s "$1"; fi; }',
    'NP=""',
    '[ -n "$T_FAKEBIN" ] && NP="$(tp "$T_FAKEBIN")"',
    '[ -n "$T_PYDIR" ] && NP="$NP:$(tp "$T_PYDIR")"',
    o.system ? 'NP="$NP:/usr/bin:/bin"' : ':',
    'export PATH="${NP#:}"'
  ].join('\n');
  const r = spawnSync(BASH, ['-c', `${prelude}\n${snippet}`, 'bash'].concat(args || []), {
    env, encoding: 'utf8'
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function runScript(name, args, opts) {
  return bashWithPath('exec bash "$@"', [posix(path.join(SCRIPTS, name))].concat(args), opts);
}

// Shims that only record that they were called (must stay unused by refused invocations).
function markerBin() {
  const dir = tmpDir('p7-mark-');
  for (const n of ['curl', 'gcloud', 'integrationcli', 'node', 'python', 'python3', 'unzip']) {
    shim(dir, n, `echo "${n}" >> "\${0%/*}/called"\nexit 1`);
  }
  return dir;
}
const called = (dir) => fs.existsSync(path.join(dir, 'called'));

// REQUIRE_BASH_TESTS=1 (set in cloudbuild-pr.yaml): a missing prerequisite FAILS instead of
// skipping, so the fail-closed script tests cannot silently guard nothing in CI (P7 review M-3).
const STRICT = process.env.REQUIRE_BASH_TESTS === '1';
function skipOrFail(ctx, why) {
  if (STRICT) {
    throw new Error(`REQUIRE_BASH_TESTS=1 but ${why}`);
  }
  console.log(`      (skipped: ${why})`);
  ctx.skip();
}

// Fake gcloud (prints the token, or fails when token is empty) and fake curl.
// FAKE_CURL_LIST: body for URLs ending in /versions; FAKE_CURL_GET: body for any other URL.
// FAKE_CURL_CODE (default 200); FAKE_CURL_NET=1 simulates a network error.
function curlBin(token) {
  const dir = tmpDir('p7-curl-');
  shim(dir, 'gcloud', token ? `echo "${token}"` : 'exit 1');
  shim(dir, 'curl', [
    'out=""; url=""; fail=0; w=0',
    'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -w) w=1; shift 2;; -H|-X|-d|--data-urlencode|--data-binary|-F) shift 2;; --fail|--fail-with-body|-f) fail=1; shift;; -*) shift;; *) url="$1"; shift;; esac; done',
    'if [ "${FAKE_CURL_NET:-0}" = 1 ]; then [ "$w" = 1 ] && printf 000; echo "curl: (6) Could not resolve host" >&2; exit 6; fi',
    'case "$url" in */versions) body="${FAKE_CURL_LIST:-}";; *) body="${FAKE_CURL_GET:-}";; esac',
    'code="${FAKE_CURL_CODE:-200}"',
    'if [ -n "$out" ] && [ -n "$body" ]; then cat "$body" > "$out"; fi',
    'if [ -z "$out" ] && [ -n "$body" ]; then cat "$body"; fi',
    '[ "$w" = 1 ] && printf "%s" "$code"',
    'if [ "$fail" = 1 ] && [ "$code" -ge 400 ]; then echo "curl: (22) The requested URL returned error: $code" >&2; exit 22; fi',
    'exit 0'
  ].join('\n'));
  return dir;
}
function bodyFile(obj) {
  const f = path.join(tmpDir('p7-body-'), 'body.json');
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return posix(f);
}

describe('P7 pipeline scripts', function () {
  this.timeout(30000);

  before(function () {
    if (!BASH) {
      skipOrFail(this, 'no bash was found');
    }
  });

  describe('scripts/lib/python.sh', () => {
    const LIB = posix(path.join(SCRIPTS, 'lib', 'python.sh'));
    const STUB = 'echo "Python was not found; run without arguments to install from the Microsoft Store" >&2\nexit 9009';
    const PY2 = 'echo "Python 2.7.18" >&2\nexit 1';
    const PY3 = 'exit 0';

    function select(shims) {
      const dir = tmpDir('p7-py-');
      Object.keys(shims).forEach((n) => shim(dir, n, shims[n]));
      // PATH = the shims only, so no real python/gcloud can be picked.
      return bashWithPath(`set -e; source "${LIB}"; echo "PY=$PY"`, [], { fakebin: dir, system: false });
    }

    it('picks python3 when it is a working Python 3', () => {
      const r = select({ python3: PY3, python: PY3 });
      expect(r.code).to.equal(0);
      expect(r.out).to.equal('PY=python3');
    });

    it('skips the Windows Store stub and picks python', () => {
      const r = select({ python3: STUB, python: PY3 });
      expect(r.code).to.equal(0);
      expect(r.out).to.equal('PY=python');
    });

    it('skips a Python 2 python and falls back to gcloud\'s bundled Python 3', () => {
      const r = select({ python3: STUB, python: PY2, pyg: PY3, gcloud: 'echo "${0%/*}/pyg"' });
      expect(r.code).to.equal(0);
      expect(r.out).to.match(/^PY=.*\/pyg$/);
    });

    it('fails clearly when gcloud\'s Python is Python 2 as well', () => {
      const r = select({ python3: STUB, python: PY2, pyg: PY2, gcloud: 'echo "${0%/*}/pyg"' });
      expect(r.code).to.not.equal(0);
      expect(r.out).to.equal('');
      expect(r.err).to.match(/no working Python 3 found/);
    });

    it('fails clearly when there is no Python and no gcloud', () => {
      const r = select({ python3: STUB, python: PY2 });
      expect(r.code).to.not.equal(0);
      expect(r.err).to.match(/no working Python 3 found/);
    });

    it('replaces every inline probe in the scripts that parse JSON', () => {
      ['get-deployed-revision.sh', 'create-versioned-kvm.sh', 'wait-for-deployment.sh', 'copy-revision.sh',
        'get-published-integration-version.sh', 'rollback-integration.sh'].forEach((f) => {
        const text = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
        expect(text, f).to.include('source "$(dirname "${BASH_SOURCE[0]}")/lib/python.sh"');
        expect(text, f).to.not.match(/-c 'pass'|command -v python3/);
      });
    });
  });

  describe('scripts/stamp-commit.sh', () => {
    const SHA = 'a1b2c3d';
    let work;

    // These tests copy the repo bundle; on an already stamped tree (pipeline step 1 ran) they
    // cannot exercise the stamping, so they are skipped (the PR pipeline runs them unstamped).
    before(function () {
      const cfg = fs.readFileSync(path.join(BUNDLE, 'policies', 'KVM-GetConfig.xml'), 'utf8');
      if (!cfg.includes('mapIdentifier="sar-mot-kpis-config-__KVM_VERSION__"')) {
        skipOrFail(this, 'the repo bundle is already stamped');
      }
    });

    beforeEach(() => {
      work = tmpDir('p7-stamp-');
      fs.cpSync(BUNDLE, path.join(work, 'apiproxy'), { recursive: true });
    });

    const bundle = () => posix(path.join(work, 'apiproxy'));
    const read = (rel) => fs.readFileSync(path.join(work, 'apiproxy', rel), 'utf8');
    function changedFiles() {
      const out = [];
      (function walk(rel) {
        fs.readdirSync(path.join(BUNDLE, rel), { withFileTypes: true }).forEach((d) => {
          const r = path.join(rel, d.name);
          if (d.isDirectory()) {
            walk(r);
          } else if (fs.readFileSync(path.join(BUNDLE, r), 'utf8') !== read(r)) {
            out.push(posix(r));
          }
        });
      }(''));
      return out.sort();
    }

    it('stamps the description and exactly the two KVM policies, leaving no placeholder', () => {
      const r = runScript('stamp-commit.sh', [SHA, 'build-123', bundle()]);
      expect(r.code, r.err).to.equal(0);
      expect(r.out).to.include('(2 policy files changed)');
      expect(changedFiles()).to.deep.equal([
        'policies/KVM-GetConfig.xml', 'policies/KVM-GetErrorMessage.xml', 'sar-mot-kpis-v1.xml'
      ]);
      expect(read('sar-mot-kpis-v1.xml')).to.include(
        '\n  <Description>sar-mot-kpis-v1 | commit a1b2c3d | build build-123</Description>\n');
      expect(read('policies/KVM-GetConfig.xml')).to.include('mapIdentifier="sar-mot-kpis-config-a1b2c3d"');
      expect(read('policies/KVM-GetErrorMessage.xml')).to.include('mapIdentifier="sar-mot-kpis-errors-a1b2c3d"');
      changedFiles().forEach((f) => expect(read(f)).to.not.include('__KVM_VERSION__'));
    });

    it('is a no-op on a re-run with the same SHA and fails with a different SHA', () => {
      expect(runScript('stamp-commit.sh', [SHA, 'b1', bundle()]).code).to.equal(0);
      const again = runScript('stamp-commit.sh', [SHA, 'b1', bundle()]);
      expect(again.code, again.err).to.equal(0);
      expect(again.out).to.include('(0 policy files changed)');
      const other = runScript('stamp-commit.sh', ['ffffff0', 'b1', bundle()]);
      expect(other.code).to.equal(1);
      expect(other.err).to.match(/mapIdentifier is not sar-mot-kpis-config-ffffff0/);
    });

    it('fails when another policy file holds the placeholder', () => {
      fs.writeFileSync(path.join(work, 'apiproxy', 'policies', 'KVM-Extra.xml'),
        '<KeyValueMapOperations mapIdentifier="x-__KVM_VERSION__"/>\n');
      const r = runScript('stamp-commit.sh', [SHA, 'b1', bundle()]);
      expect(r.code).to.equal(1);
      expect(r.err).to.match(/placeholder files are/);
    });

    [[['A1B2C3D', 'b1'], /short_sha/], [['a1b2c3', 'b1'], /short_sha/], [['a1b2c3d', 'b 1'], /build_id/],
      [['a1b2c3d'], /usage/]].forEach(([args, msg]) => {
      it(`refuses ${JSON.stringify(args)}`, () => {
        const r = runScript('stamp-commit.sh', args.concat(args.length === 2 ? [bundle()] : []));
        expect(r.code).to.equal(2);
        expect(r.err).to.match(msg);
      });
    });
  });

  describe('argument refusals happen before any network/tool call', () => {
    const cases = [
      ['apply-integration.sh', ['prod', 'a1b2c3d'], /Refusing prod/],
      ['apply-integration.sh', ['test', 'a1b2c3d'], /usage/],
      ['apply-integration.sh', ['apigee-prod-511508', 'a1b2c3d'], /usage/],
      ['apply-integration.sh', [], /usage/],
      ['apply-integration.sh', ['dev'], /short_sha/],
      ['apply-integration.sh', ['dev', 'not-a-sha'], /short_sha/],
      ['assert-integration.sh', ['prod', 'a1b2c3d'], /Refusing prod/],
      ['assert-integration.sh', ['qa', 'a1b2c3d'], /usage/],
      ['assert-integration.sh', ['dev'], /usage/],
      ['assert-integration.sh', ['staging', 'XYZ'], /short_sha/],
      ['deploy-debugmask.sh', ['prod'], /Refusing prod/],
      ['deploy-debugmask.sh', ['local'], /usage/],
      ['deploy-debugmask.sh', [], /usage/],
      ['deploy-debugmask.sh', ['dev', 'extra'], /usage/],
      ['install-integrationcli.sh', ['latest'], /version must look like/],
      ['install-integrationcli.sh', ['0.87.0'], /no pinned SHA-256/]
    ];
    cases.forEach(([script, args, msg]) => {
      it(`${script} ${JSON.stringify(args)}`, () => {
        const bin = markerBin();
        const r = runScript(script, args, { fakebin: bin, env: { SHORT_SHA: '' } });
        expect(r.code).to.equal(2);
        expect(r.err).to.match(msg);
        expect(called(bin), 'a tool was called').to.equal(false);
      });
    });

    it('apply-integration.sh takes SHORT_SHA from the environment', () => {
      const bin = markerBin();
      const r = runScript('apply-integration.sh', ['prod'], { fakebin: bin, env: { SHORT_SHA: 'a1b2c3d' } });
      expect(r.code).to.equal(2);
      expect(r.err).to.match(/Refusing prod/);
    });

    it('scripts hard-code the non-prod project and never mention the prod project', () => {
      ['apply-integration.sh', 'assert-integration.sh', 'deploy-debugmask.sh'].forEach((f) => {
        const text = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
        expect(text, f).to.include('"apigee-nonprod-511322"');
        expect(text, f).to.not.include('apigee-prod-511508');
      });
    });
  });

  describe('scripts/rollback.sh with a fake curl (M-10)', () => {
    function rb(code, prev, failed) {
      return runScript('rollback.sh', ['org', 'dev', 'proxy', prev, failed],
        { fakebin: curlBin('fake-token-xyz'), env: { FAKE_CURL_CODE: code, FAKE_CURL_GET: bodyFile({}) } });
    }

    it('undeploy success prints SUCCESS, exit 0', () => {
      const r = rb('200', '', '7');
      expect(r.code, r.err).to.equal(0);
      expect(r.out).to.include('SUCCESS: Failed revision 7 has been undeployed');
    });

    ['403', '500'].forEach((code) => {
      it(`undeploy HTTP ${code} exits non-zero without SUCCESS`, () => {
        const r = rb(code, '', '7');
        expect(r.code).to.equal(1);
        expect(r.out).to.not.include('SUCCESS');
        expect(r.err).to.include(`HTTP ${code}`);
        expect(r.err).to.not.include('fake-token-xyz');
      });
    });

    it('undeploy network error exits non-zero without SUCCESS', () => {
      const r = runScript('rollback.sh', ['org', 'dev', 'proxy', '', '7'],
        { fakebin: curlBin('t'), env: { FAKE_CURL_NET: '1' } });
      expect(r.code).to.equal(1);
      expect(r.out).to.not.include('SUCCESS');
    });

    it('fails when neither revision is known', () => {
      const r = rb('200', '', '');
      expect(r.code).to.equal(1);
      expect(r.out).to.not.include('SUCCESS');
      expect(r.err).to.match(/nothing can be rolled back/);
    });

    it('a failing redeploy of the previous revision exits non-zero without SUCCESS', () => {
      const r = rb('500', '6', '7');
      expect(r.code).to.not.equal(0);
      expect(r.out).to.not.include('SUCCESS');
    });
  });

  describe('Python-backed scripts with a fake curl', function () {
    before(function () {
      if (!PYDIR) {
        skipOrFail(this, 'no Python 3 was found');
      }
    });

    describe('get-deployed-revision.sh fails closed (I-4)', () => {
      function dep(env, token) {
        return runScript('get-deployed-revision.sh', ['org', 'dev', 'proxy'],
          { fakebin: curlBin(token === undefined ? 'fake-token-xyz' : token), python: true, env });
      }

      it('200 with deployments prints the highest revision', () => {
        const r = dep({ FAKE_CURL_GET: bodyFile({ deployments: [{ revision: '6' }, { revision: '12' }] }) });
        expect(r.code, r.err).to.equal(0);
        expect(r.out).to.equal('12');
        expect(r.err).to.not.include('fake-token-xyz');
      });

      it('writes the revision to the optional output file', () => {
        const out = path.join(tmpDir('p7-out-'), 'r.txt');
        const r = runScript('get-deployed-revision.sh', ['org', 'dev', 'proxy', posix(out)], {
          fakebin: curlBin('t'), python: true, env: { FAKE_CURL_GET: bodyFile({ deployments: [{ revision: '3' }] }) }
        });
        expect(r.code, r.err).to.equal(0);
        expect(r.out).to.equal('');
        expect(fs.readFileSync(out, 'utf8').trim()).to.equal('3');
      });

      it('200 without deployments prints an empty string, exit 0', () => {
        const r = dep({ FAKE_CURL_GET: bodyFile({}) });
        expect(r.code, r.err).to.equal(0);
        expect(r.out).to.equal('');
      });

      it('404 prints an empty string, exit 0', () => {
        const r = dep({ FAKE_CURL_CODE: '404', FAKE_CURL_GET: bodyFile({ error: { code: 404 } }) });
        expect(r.code, r.err).to.equal(0);
        expect(r.out).to.equal('');
      });

      ['401', '403', '500', '503'].forEach((code) => {
        it(`HTTP ${code} exits non-zero and writes no output file`, () => {
          const out = path.join(tmpDir('p7-out-'), 'r.txt');
          const r = runScript('get-deployed-revision.sh', ['org', 'dev', 'proxy', posix(out)], {
            fakebin: curlBin('t'), python: true,
            env: { FAKE_CURL_CODE: code, FAKE_CURL_GET: bodyFile({ error: { code: Number(code) } }) }
          });
          expect(r.code).to.equal(1);
          expect(r.err).to.include(`HTTP ${code}`);
          expect(fs.existsSync(out)).to.equal(false);
        });
      });

      it('a network error exits non-zero', () => {
        const r = dep({ FAKE_CURL_NET: '1' });
        expect(r.code).to.equal(1);
        expect(r.err).to.match(/network error/);
      });

      it('a 200 body that is not JSON exits non-zero', () => {
        const r = dep({ FAKE_CURL_GET: bodyFile('<html>oops</html>') });
        expect(r.code).to.equal(1);
        expect(r.err).to.match(/could not parse/);
      });

      it('an empty token exits non-zero', function () {
        if (fs.existsSync('/workspace/.token')) {
          this.skip();
        }
        const r = dep({ FAKE_CURL_GET: bodyFile({}) }, '');
        expect(r.code).to.equal(1);
        expect(r.err).to.match(/access token/);
      });
    });

    const PREFIX = 'projects/p/locations/us-central1/integrations/i/versions/';
    const LIST = {
      integrationVersions: [
        { name: `${PREFIX}old`, state: 'ACTIVE', updateTime: '2026-01-01T00:00:00Z' },
        { name: `${PREFIX}new-id`, state: 'ACTIVE', updateTime: '2026-11-01T00:00:00Z' },
        { name: `${PREFIX}draft`, state: 'DRAFT', updateTime: '2026-12-01T00:00:00Z' }
      ]
    };

    describe('get-published-integration-version.sh fails closed', () => {
      function get(env, token) {
        return runScript('get-published-integration-version.sh', ['p', 'us-central1', 'i'],
          { fakebin: curlBin(token === undefined ? 'fake-token-xyz' : token), python: true, env });
      }

      it('200 with ACTIVE versions prints the newest ACTIVE id', () => {
        const r = get({ FAKE_CURL_LIST: bodyFile(LIST) });
        expect(r.code, r.err).to.equal(0);
        expect(r.out).to.equal('new-id');
        expect(r.err).to.not.include('fake-token-xyz');
      });

      it('writes the id to the optional output file', () => {
        const out = path.join(tmpDir('p7-out-'), 'v.txt');
        const r = runScript('get-published-integration-version.sh', ['p', 'us-central1', 'i', posix(out)],
          { fakebin: curlBin('t'), python: true, env: { FAKE_CURL_LIST: bodyFile(LIST) } });
        expect(r.code, r.err).to.equal(0);
        expect(r.out).to.equal('');
        expect(fs.readFileSync(out, 'utf8').trim()).to.equal('new-id');
      });

      it('200 without an ACTIVE version prints an empty string, exit 0', () => {
        const r = get({ FAKE_CURL_LIST: bodyFile({ integrationVersions: [{ name: `${PREFIX}d`, state: 'DRAFT' }] }) });
        expect(r.code, r.err).to.equal(0);
        expect(r.out).to.equal('');
        expect(r.err).to.match(/none/);
      });

      it('200 with an empty object prints an empty string, exit 0', () => {
        const r = get({ FAKE_CURL_LIST: bodyFile({}) });
        expect(r.code, r.err).to.equal(0);
        expect(r.out).to.equal('');
      });

      it('404 prints an empty string, exit 0', () => {
        const r = get({ FAKE_CURL_CODE: '404', FAKE_CURL_LIST: bodyFile({ error: { code: 404 } }) });
        expect(r.code, r.err).to.equal(0);
        expect(r.out).to.equal('');
      });

      ['401', '403', '429', '500', '503'].forEach((code) => {
        it(`HTTP ${code} exits non-zero`, () => {
          const r = get({ FAKE_CURL_CODE: code, FAKE_CURL_LIST: bodyFile({ error: { code: Number(code) } }) });
          expect(r.code).to.equal(1);
          expect(r.out).to.equal('');
          expect(r.err).to.include(`HTTP ${code}`);
        });
      });

      it('a network error exits non-zero', () => {
        const r = get({ FAKE_CURL_NET: '1' });
        expect(r.code).to.equal(1);
        expect(r.err).to.match(/network error/);
      });

      it('a 200 body that is not JSON exits non-zero', () => {
        const r = get({ FAKE_CURL_LIST: bodyFile('<html>oops</html>') });
        expect(r.code).to.equal(1);
        expect(r.err).to.match(/could not parse/);
      });

      it('an empty token exits non-zero before curl', function () {
        // The scripts fall back to /workspace/.token, which holds a real token in Cloud Build.
        if (fs.existsSync('/workspace/.token')) {
          this.skip();
        }
        const r = get({ FAKE_CURL_LIST: bodyFile(LIST) }, '');
        expect(r.code).to.equal(1);
        expect(r.err).to.match(/access token/);
      });
    });

    describe('assert-integration.sh', () => {
      function version(env, mutate) {
        const v = JSON.parse(fs.readFileSync(
          path.join(ROOT, 'integration', env, 'src', `sar-kpi-get-${env}.json`), 'utf8'));
        v.name = `${PREFIX}new-id`;
        v.state = 'ACTIVE';
        v.userLabel = 'a1b2c3d';
        if (mutate) {
          mutate(v);
        }
        return v;
      }
      function assertRun(env, v, sha) {
        return runScript('assert-integration.sh', [env, sha || 'a1b2c3d'], {
          fakebin: curlBin('fake-token-xyz'), python: true,
          env: { FAKE_CURL_LIST: bodyFile(LIST), FAKE_CURL_GET: bodyFile(v) }
        });
      }
      const connector = (v) => v.taskConfigs.find((t) => t.task === 'GenericConnectorTask');

      ['dev', 'staging'].forEach((env) => {
        it(`passes for the repo's ${env} src with the expected label`, () => {
          const r = assertRun(env, version(env));
          expect(r.code, r.err).to.equal(0);
          expect(r.out).to.equal('new-id');
          expect(r.err).to.not.include('fake-token-xyz');
        });
      });

      it('fails on a wrong userLabel', () => {
        const r = assertRun('dev', version('dev'), 'ffffff0');
        expect(r.code).to.equal(1);
        expect(r.err).to.match(/userLabel is 'a1b2c3d', expected 'ffffff0'/);
      });

      it('fails when dev points at the staging connection', () => {
        const r = assertRun('dev', version('dev', (v) => {
          const p = connector(v).parameters.config.value;
          p.jsonValue = p.jsonValue.replace('sar-kpi-db-dev', 'sar-kpi-db-staging');
        }));
        expect(r.code).to.equal(1);
        expect(r.err).to.match(/connectionName is .*sar-kpi-db-staging/);
        expect(r.err).to.match(/references the staging connection/);
      });

      it('fails on the other env\'s trigger', () => {
        const r = assertRun('staging', version('staging', (v) => {
          v.triggerConfigs[0].triggerId = 'api_trigger/sar-kpi-get-dev';
        }));
        expect(r.code).to.equal(1);
        expect(r.err).to.match(/triggerId 'api_trigger\/sar-kpi-get-dev'/);
      });

      it('fails when there is no ACTIVE version', () => {
        const r = runScript('assert-integration.sh', ['dev', 'a1b2c3d'], {
          fakebin: curlBin('t'), python: true, env: { FAKE_CURL_LIST: bodyFile({}) }
        });
        expect(r.code).to.equal(1);
        expect(r.err).to.match(/no ACTIVE version/);
      });

      it('fails when the version GET is not 200', () => {
        const r = runScript('assert-integration.sh', ['dev', 'a1b2c3d'], {
          fakebin: curlBin('t'), python: true,
          env: { FAKE_CURL_LIST: bodyFile(LIST), FAKE_CURL_CODE: '403' }
        });
        expect(r.code).to.equal(1);
        expect(r.err).to.match(/HTTP 403/);
      });
    });
  });

  describe('static checks', () => {
    const NEW = ['lib/python.sh', 'stamp-commit.sh', 'install-integrationcli.sh', 'apply-integration.sh',
      'assert-integration.sh', 'deploy-debugmask.sh', 'get-published-integration-version.sh'];

    it('new scripts use bash strict mode, LF endings and pass bash -n', () => {
      NEW.forEach((f) => {
        const text = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
        expect(text, f).to.not.include('\r');
        expect(text.startsWith('#!/usr/bin/env bash\n'), f).to.equal(true);
        if (f !== 'lib/python.sh') {
          expect(text, f).to.include('set -euo pipefail\nset +x\n');
        }
        const r = spawnSync(BASH, ['-n', posix(path.join(SCRIPTS, f))], { encoding: 'utf8' });
        expect(r.status, `${f}: ${r.stderr}`).to.equal(0);
      });
    });

    it('install-integrationcli.sh pins the 0.86.0 Linux x86_64 digest', () => {
      const text = fs.readFileSync(path.join(SCRIPTS, 'install-integrationcli.sh'), 'utf8');
      expect(text).to.include('0.86.0) PINNED="52fd27ff2c1ef5c2b5bb62613be84628991d0c12d7a0c532bab015b7f0d6367f"');
      expect(text).to.include('integrationcli_Linux_x86_64');
      expect(text).to.include('checksums.txt');
    });

    it('apply-integration.sh runs integrationcli with the D20/D23 flags and no -e', () => {
      const text = fs.readFileSync(path.join(SCRIPTS, 'apply-integration.sh'), 'utf8');
      expect(text).to.include('integrations apply -f "${APPLY_DIR}"');
      expect(text).to.include('--skip-connectors=true --wait=true --run-tests=true');
      const call = text.slice(text.indexOf('"${CLI}" integrations apply'), text.indexOf('RC="${PIPESTATUS[0]}"'));
      expect(call).to.include('-p "${PROJECT}" -r "${REGION}" -t "${TOKEN}"');
      expect(call).to.not.match(/\s-e\s/);
      expect(call).to.not.match(/--userlabel|--user-label/);
      expect(text).to.include('RC="${PIPESTATUS[0]}"');
    });

    it('tests/run-newman.sh reads secrets via REST only below the validation hook and never echoes them', () => {
      const text = fs.readFileSync(path.join(ROOT, 'tests', 'run-newman.sh'), 'utf8');
      const hook = text.indexOf('RUN_NEWMAN_VALIDATE_ONLY');
      expect(hook).to.be.below(text.indexOf('secretmanager.googleapis.com'));
      expect(hook).to.be.below(text.indexOf('/workspace/.token'));
      expect(text).to.not.match(/echo[^\n]*\$(API_KEY|API_SECRET|OTHER_API_KEY|OTHER_API_SECRET|token)\b/);
      expect(text).to.not.match(/echo[^\n]*\$\{?(API_KEY|API_SECRET|token)/);
    });

    it('infra/02 checks the integrations service agent without aborting and grants the Newman secrets', () => {
      const text = fs.readFileSync(path.join(ROOT, 'infra', '02-service-accounts-iam.sh'), 'utf8');
      const check = text.indexOf('gcloud projects get-iam-policy');
      const grant = text.indexOf('--role="roles/connectors.invoker"');
      expect(check).to.be.above(-1);
      expect(check).to.be.below(grant);
      expect(text).to.match(/if ! gcloud projects add-iam-policy-binding[^\n]*\n[^\n]*INTEGRATIONS_SERVICE_AGENT/);
      ['sar-mot-poc-app-api-key', 'sar-mot-poc-app-api-secret', 'sar-mot-poc-other-app-api-key',
        'sar-mot-poc-other-app-api-secret'].forEach((s) => expect(text).to.include(s));
      expect(text.indexOf('exit 3')).to.be.above(text.indexOf('sar-mot-poc-other-app-api-secret'));
      expect(text).to.not.include('apigee-prod-511508');
    });
  });
});
