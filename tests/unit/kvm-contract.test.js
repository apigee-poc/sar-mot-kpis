// Consistency check between the proxy bundle, the environment KVM files, the error catalog and
// the debug masks. Pure file reads: no network, no cloud.
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const ROOT = path.join(__dirname, '..', '..');
const ENV_DIR = path.join(ROOT, 'src', 'main', 'apigee', 'environments');
const PROXY_DIR = path.join(ROOT, 'src', 'main', 'apigee', 'apiproxies', 'sar-mot-kpis-v1', 'apiproxy');
const ENVS = ['local', 'dev', 'staging', 'prod'];

// Faults of the IntegrationEndpoint that the proxy maps to ERR-504-TIMEOUT itself (they have no
// KVM key of their own).
const INTEGRATION_FAULTS = ['GatewayTimeout', 'ServiceUnavailable'];

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function readJson(file) {
  return JSON.parse(read(file));
}

function listFiles(dir, ext) {
  let out = [];
  fs.readdirSync(dir).forEach((name) => {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      out = out.concat(listFiles(full, ext));
    } else if (name.endsWith(ext)) {
      out.push(full);
    }
  });
  return out;
}

function sorted(list) {
  return list.slice().sort();
}

function unique(list) {
  return list.filter((v, i) => list.indexOf(v) === i);
}

function kvmFile(env, name) {
  return path.join(ENV_DIR, env, 'kvms', `${name}.json`);
}

function entryNames(def) {
  return def.entries.map((e) => e.name);
}

// Rows of the catalog table: lookup keys (column 3, possibly several) and the message (column 5).
function catalogRows() {
  const rows = [];
  read(path.join(ROOT, 'docs', 'ERROR-CATALOG.md')).split(/\r?\n/).forEach((line) => {
    const m = /^\| (\d+) \| .* \| (`[^|]+`) \| \*{0,2}(\d{3})\*{0,2}[^|]* \| (.*) \|$/.exec(line);
    if (m) {
      rows.push({
        row: Number(m[1]),
        keys: m[2].split(',').map((k) => k.trim().replace(/`/g, '')),
        status: Number(m[3]),
        message: m[4]
      });
    }
  });
  return rows;
}

// Every ERR-... lookup key that appears in the proxy bundle (policies, flows, resources).
function proxyErrorKeys() {
  const keys = [];
  listFiles(PROXY_DIR, '.xml').concat(listFiles(PROXY_DIR, '.js')).forEach((file) => {
    (read(file).match(/ERR-[0-9A-Z]+(?:-[0-9A-Z]+)*/g) || []).forEach((k) => keys.push(k));
  });
  return unique(keys);
}

// Keys read by KVM-GetConfig.
function configParameters() {
  const xml = read(path.join(PROXY_DIR, 'policies', 'KVM-GetConfig.xml'));
  const out = [];
  const re = /<Parameter>([^<]+)<\/Parameter>/g;
  let m = re.exec(xml);
  while (m) {
    out.push(m[1]);
    m = re.exec(xml);
  }
  return out;
}

// Name of the VerifyAPIKey policy, taken from the bundle (the policy file whose root element is
// VerifyAPIKey), so a rename of the policy cannot silently break the debug-mask expectations.
function verifyApiKeyPolicyName() {
  const dir = path.join(PROXY_DIR, 'policies');
  const names = fs.readdirSync(dir).filter((file) => {
    const xml = read(path.join(dir, file)).replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
    return /^\s*<VerifyAPIKey[\s>]/.test(xml);
  }).map((file) => file.replace(/\.xml$/, ''));
  expect(names, 'exactly one VerifyAPIKey policy').to.have.length(1);
  return names[0];
}

// mapIdentifier of a KVM policy minus the pipeline-stamped version suffix.
function mapBaseName(policy) {
  const xml = read(path.join(PROXY_DIR, 'policies', `${policy}.xml`));
  const m = /mapIdentifier="([^"]+)-__KVM_VERSION__"/.exec(xml);
  expect(m, `${policy} mapIdentifier`).to.not.equal(null);
  return m[1];
}

// Every config.<name> variable used anywhere in the proxy (except the KVM policy that sets them).
function configVariablesUsed() {
  const used = [];
  listFiles(PROXY_DIR, '.xml').concat(listFiles(PROXY_DIR, '.js')).forEach((file) => {
    (read(file).match(/\bconfig\.[A-Za-z]+/g) || []).forEach((v) => used.push(v.slice('config.'.length)));
  });
  return unique(used);
}

describe('environment KVM files and proxy contract', () => {
  const catalog = catalogRows();
  const catalogKeys = [];
  catalog.forEach((r) => r.keys.forEach((k) => catalogKeys.push(k)));

  it('parses the catalog (16 rows, 19 lookup keys)', () => {
    expect(catalog).to.have.length(16);
    expect(catalogKeys).to.have.length(19);
  });

  ENVS.forEach((env) => {
    describe(`environment ${env}`, () => {
      it('has exactly the two KVM definition files, both valid JSON', () => {
        const files = fs.readdirSync(path.join(ENV_DIR, env, 'kvms')).sort();
        expect(files).to.deep.equal(['sar-mot-kpis-config.json', 'sar-mot-kpis-errors.json']);
        files.forEach((f) => {
          const def = readJson(path.join(ENV_DIR, env, 'kvms', f));
          expect(def.name).to.equal(f.replace(/\.json$/, ''));
          expect(def.encrypted).to.equal(true);
          expect(def.entries).to.be.an('array');
          def.entries.forEach((e) => {
            expect(Object.keys(e).sort()).to.deep.equal(['name', 'value']);
            expect(e.value, `${f}:${e.name}`).to.be.a('string').and.not.equal('');
          });
          expect(unique(entryNames(def))).to.have.length(def.entries.length);
        });
      });

      it('KVM file names equal the policy mapIdentifier base names', () => {
        expect(mapBaseName('KVM-GetConfig')).to.equal(readJson(kvmFile(env, 'sar-mot-kpis-config')).name);
        expect(mapBaseName('KVM-GetErrorMessage')).to.equal(readJson(kvmFile(env, 'sar-mot-kpis-errors')).name);
      });

      it('error keys equal the lookup keys of the catalog and cover every key the proxy uses', () => {
        const errors = readJson(kvmFile(env, 'sar-mot-kpis-errors'));
        const keys = entryNames(errors);
        expect(keys).to.have.length(19);
        expect(sorted(keys)).to.deep.equal(sorted(catalogKeys));
        proxyErrorKeys().forEach((k) => {
          expect(keys, `proxy references ${k}`).to.include(k);
        });
        // Fault names the proxy branches on must have a message, except the integration faults
        // that the proxy remaps to ERR-504-TIMEOUT.
        const flow = read(path.join(PROXY_DIR, 'proxies', 'default.xml'));
        const re = /fault\.name = "([A-Za-z_-]+)"/g;
        let m = re.exec(flow);
        while (m) {
          if (INTEGRATION_FAULTS.indexOf(m[1]) < 0) {
            expect(keys, `FaultRule on ${m[1]}`).to.include(m[1]);
          }
          m = re.exec(flow);
        }
      });

      it('error messages are the verbatim catalog texts', () => {
        const errors = readJson(kvmFile(env, 'sar-mot-kpis-errors'));
        const byKey = {};
        errors.entries.forEach((e) => {
          byKey[e.name] = e.value;
        });
        catalog.forEach((r) => {
          r.keys.forEach((k) => {
            expect(byKey[k], `row ${r.row} / ${k}`).to.equal(r.message);
          });
        });
        // Rows 2-4 share one message on purpose: never reveal whether key or secret was wrong.
        const shared = byKey['FailedToResolveAPIKey'];
        ['InvalidApiKey', 'ApiKeyNotApproved', 'DeveloperStatusNotActive',
          'invalid_client-app_not_approved', 'ERR-401-SECRET'].forEach((k) => {
          expect(byKey[k]).to.equal(shared);
        });
        // No characters that would need escaping in the JSON envelope.
        errors.entries.forEach((e) => {
          expect(e.value, e.name).to.not.match(/["\\\r\n]/);
        });
      });

      it('config keys equal the keys KVM-GetConfig reads, and the proxy uses no other config.*', () => {
        const config = readJson(kvmFile(env, 'sar-mot-kpis-config'));
        const keys = entryNames(config);
        const params = configParameters();
        expect(params).to.have.length(11);
        expect(sorted(keys)).to.deep.equal(sorted(params));
        configVariablesUsed().forEach((v) => {
          expect(keys, `proxy uses config.${v}`).to.include(v);
        });
      });

      it('config values are well formed and per environment', () => {
        const config = readJson(kvmFile(env, 'sar-mot-kpis-config'));
        const v = {};
        config.entries.forEach((e) => {
          v[e.name] = e.value;
        });
        const target = env === 'local' ? 'dev' : env;
        expect(v.integrationName).to.equal(`sar-kpi-get-${target}`);
        expect(v.triggerName).to.equal(`api_trigger/sar-kpi-get-${target}`);
        expect(v.projectId).to.equal(env === 'prod' ? 'apigee-prod-511508' : 'apigee-nonprod-511322');
        expect(v.region).to.equal('us-central1');
        expect(v.spikeArrestRate).to.match(/^[1-9][0-9]*(ps|pm)$/);
        expect(v.quotaLimit).to.match(/^[1-9][0-9]*$/);
        expect(v.quotaInterval).to.match(/^[1-9][0-9]*$/);
        expect(v.quotaTimeUnit).to.be.oneOf(['minute', 'hour', 'day', 'month']);
        expect(v.maxClockSkewSeconds).to.match(/^[0-9]+$/);
        expect(v.allowedKpis).to.equal('total_freight');
        expect(v.commit).to.equal('__KVM_VERSION__');
      });

      it('debugmask.json masks the credentials headers, the client id and the client secret', () => {
        const mask = readJson(path.join(ENV_DIR, env, 'debugmask.json'));
        ['namespaces', 'faultJSONPaths', 'faultXPaths', 'requestJSONPaths', 'requestXPaths',
          'responseJSONPaths', 'responseXPaths', 'variables'].forEach((k) => {
          expect(mask, k).to.have.property(k);
        });
        const va = verifyApiKeyPolicyName();
        const lower = mask.variables.map((x) => x.toLowerCase());
        [
          'request.header.x-api-key',
          'request.header.x-api-secret',
          'request.header.x-operator-id',
          `verifyapikey.${va.toLowerCase()}.client_id`,
          `verifyapikey.${va.toLowerCase()}.client_secret`
        ].forEach((name) => {
          expect(lower, name).to.include(name);
        });
        // Both spellings are listed because the docs do not say whether the match is case-sensitive.
        expect(mask.variables).to.include.members([
          'request.header.X-API-Key', 'request.header.X-API-Secret', 'request.header.X-Operator-Id',
          `verifyapikey.${va}.client_id`, `verifyapikey.${va}.client_secret`
        ]);
      });
    });
  });

  it('error messages of the catalog rows that the OAS documents appear in the OAS', () => {
    const oas = read(path.join(ROOT, 'api', 'sar-mot-kpis-oas.yaml'));
    // Rows 1, 8 and 9 (header validation) are catalog-only; the rest are exact OAS example texts.
    catalog.filter((r) => [1, 8, 9].indexOf(r.row) < 0).forEach((r) => {
      expect(oas, `row ${r.row}`).to.include(r.message);
    });
  });

  it('contains no secret-looking values in any environment file', () => {
    const files = [];
    ENVS.forEach((env) => {
      listFiles(path.join(ENV_DIR, env), '.json').forEach((f) => files.push(f));
    });
    expect(files.length).to.be.at.least(ENVS.length * 3);
    const patterns = [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /AIza[0-9A-Za-z_-]{35}/,
      /ya29\.[0-9A-Za-z_-]{20,}/,
      /"private_key"/,
      /"(?:password|secret|apikey|api_key|client_secret|consumerSecret|consumerKey)"\s*:/i,
      /\b[A-Za-z0-9]{32,}\b/
    ];
    files.forEach((f) => {
      const text = read(f);
      patterns.forEach((p) => {
        expect(p.test(text), `${path.relative(ROOT, f)} matches ${p}`).to.equal(false);
      });
    });
  });
});
