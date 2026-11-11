// Argument allowlist of tests/run-newman.sh. Runs the script with RUN_NEWMAN_VALIDATE_ONLY=1,
// which exits right after validation: no gcloud, no newman, no network.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { expect } = require('chai');

const gen = require('../tools/build-collection');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'tests', 'run-newman.sh');
const FI = {
  fi06: 'FI-06 SpikeArrest 429',
  fi07: 'FI-07 Quota 429',
  fi13: 'FI-13 Integration failure 500',
  fi16: 'FI-16 Unmapped fault 500'
};

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

function run(args) {
  const env = Object.assign({}, process.env, { RUN_NEWMAN_VALIDATE_ONLY: '1' });
  // A PATH without gcloud would not matter: validation exits before any gcloud call.
  const r = spawnSync(BASH, [SCRIPT.replace(/\\/g, '/')].concat(args), { env, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

describe('tests/run-newman.sh argument allowlist', function () {
  before(function () {
    if (!BASH) {
      this.skip();
    }
  });

  const accepted = [
    [['dev'], 'VALID env=dev'],
    [['staging'], 'VALID env=staging'],
    [['dev', '--folder', 'Happy paths', '--folder=Error rows', '--bail'],
      'VALID env=dev [--folder] [Happy paths] [--folder] [Error rows] [--bail]'],
    [['dev', '--folder', FI.fi06, '--env-var', 'faultScenario=fi06'],
      `VALID env=dev [--folder] [${FI.fi06}] [--env-var] [faultScenario=fi06]`],
    [['dev', '--env-var=faultScenario=fi16b', `--folder=${FI.fi16}`],
      `VALID env=dev [--folder] [${FI.fi16}] [--env-var] [faultScenario=fi16b]`]
  ];
  accepted.forEach(([args, expected]) => {
    it(`accepts ${JSON.stringify(args)}`, () => {
      const r = run(args);
      expect(r.err).to.equal('');
      expect(r.code).to.equal(0);
      expect(r.out).to.equal(expected);
    });
  });

  const refused = [
    [['prod'], /prod from a workstation/],
    [['local'], /local emulator/],
    [[], /usage/],
    [['dev', '-e', 'x.json'], /'-e' is not allowed/],
    [['dev', '--environment', 'x.json'], /'--environment' is not allowed/],
    [['dev', '--env-var', 'baseUrl=http://example.invalid'], /only faultScenario/],
    [['dev', '--env-var', 'apiKey=x'], /only faultScenario/],
    [['dev', '--global-var', 'baseUrl=x'], /'--global-var' is not allowed/],
    [['dev', '--export-environment', 'out.json'], /'--export-environment' is not allowed/],
    [['dev', '--export-globals=out.json'], /'--export-globals' is not allowed/],
    [['dev', '-r', 'json'], /'-r' is not allowed/],
    [['dev', '--reporters', 'json'], /'--reporters' is not allowed/],
    [['dev', '--verbose'], /'--verbose' is not allowed/],
    [['dev', '--insecure'], /'--insecure' is not allowed/],
    [['dev', '--ssl-client-cert', 'c.pem'], /'--ssl-client-cert' is not allowed/],
    [['dev', 'stray-value'], /non-option argument/],
    [['dev', '--folder'], /needs a folder name/],
    [['dev', '--folder', 'nope'], /unknown folder/],
    [['dev', '--folder', gen.FOLDERS.faults, '--env-var', 'faultScenario=fi06'], /parent fault-injection folder/],
    [['dev', '--folder', FI.fi06], /needs --env-var faultScenario=<fi06>/],
    [['dev', '--folder', FI.fi06, '--env-var', 'faultScenario=fi07'], /needs --env-var faultScenario=<fi06>/],
    [['dev', '--env-var', 'faultScenario=fi06'], /exactly one matching FI-xx folder/],
    [['dev', '--folder', 'Error rows', '--env-var', 'faultScenario=fi06'], /exactly one matching FI-xx folder/],
    [['dev', '--folder', FI.fi06, '--folder', 'Happy paths', '--env-var', 'faultScenario=fi06'],
      /exactly one matching FI-xx folder/],
    [['dev', '--folder', FI.fi06, '--env-var', 'faultScenario=fi99'], /unknown faultScenario/],
    [['staging', '--folder', FI.fi13, '--env-var', 'faultScenario=fi13'], /dev only/]
  ];
  refused.forEach(([args, message]) => {
    it(`refuses ${JSON.stringify(args)}`, () => {
      const r = run(args);
      expect(r.code).to.equal(2);
      expect(r.out).to.equal('');
      expect(r.err).to.match(message);
    });
  });

  it('never echoes the value of a refused --env-var', () => {
    const r = run(['dev', '--env-var', 'apiSecret=do-not-print-me']);
    expect(r.err).to.not.include('do-not-print-me');
  });
});

describe('tests/run-newman.sh static checks', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');

  it('passes only the validated NEWMAN_ARGS to newman, never "$@"', () => {
    expect(text).to.not.include('"$@"');
    expect(text).to.include('${NEWMAN_ARGS[@]+"${NEWMAN_ARGS[@]}"}');
  });

  it('KNOWN_FOLDERS equals the collection folders that can be run', () => {
    const block = /KNOWN_FOLDERS=\(\n([\s\S]*?)\n\)/.exec(text.replace(/\r\n/g, '\n'))[1];
    const known = block.split('\n').map((l) => l.trim().replace(/^"(.*)"$/, '$1'));
    const collection = JSON.parse(fs.readFileSync(gen.OUTPUT_FILE, 'utf8'));
    const runnable = [];
    collection.item.forEach((folder) => {
      if (folder.name === gen.FOLDERS.faults) {
        folder.item.forEach((sub) => runnable.push(sub.name));
      } else {
        runnable.push(folder.name);
      }
    });
    expect(known).to.deep.equal(runnable);
  });

  it('the validation hook exits before the first gcloud call', () => {
    expect(text.indexOf('RUN_NEWMAN_VALIDATE_ONLY')).to.be.below(text.indexOf('gcloud secrets'));
  });
});

describe('package.json Newman scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  it('has no prod or local Newman script (AGENTS.md rule 2, no emulator)', () => {
    expect(pkg.scripts).to.not.have.any.keys('test:prod', 'test:local');
    Object.values(pkg.scripts).forEach((s) => expect(s).to.not.match(/prod\.postman_environment|newman run/));
  });

  it('test:dev and test:staging use the runner', () => {
    expect(pkg.scripts['test:dev']).to.equal('bash tests/run-newman.sh dev');
    expect(pkg.scripts['test:staging']).to.equal('bash tests/run-newman.sh staging');
  });
});
