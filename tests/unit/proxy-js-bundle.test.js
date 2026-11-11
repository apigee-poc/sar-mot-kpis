const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { BUNDLE, JSC_DIR, jscSource } = require('./helpers/jsc');

const POLICIES_DIR = path.join(BUNDLE, 'policies');

// Source with comments and string/regex-free noise removed, so the scan only sees code.
function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\'"])\/\/.*$/gm, '$1')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

// Constructs Rhino (Apigee's JavaScript engine, ES5) cannot parse.
const FORBIDDEN = [
  ['const declaration', /\bconst\s/],
  ['let declaration', /\blet\s/],
  ['arrow function', /=>/],
  ['template literal', /`/],
  ['class', /\bclass\s/],
  ['async', /\basync\b/],
  ['await', /\bawait\b/],
  ['spread / rest', /\.\.\./],
  ['generator function', /function\s*\*|\byield\b/],
  ['import / export statement', /^\s*(?:import|export)\s/m],
  ['optional chaining / nullish', /\?\.|\?\?/],
  ['exponent operator', /\*\*/],
  ['default parameter value', /function\s*\w*\s*\([^)]*=[^)]*\)/]
];

describe('proxy JS bundle: Rhino (ES5) compatibility and wiring', () => {
  const files = fs.readdirSync(JSC_DIR).filter((f) => f.endsWith('.js'));

  it('finds the six JavaScript resources', () => {
    expect(files.sort()).to.deep.equal([
      'checkKpiAllowed.js',
      'setIntegrationParams.js',
      'validateApiSecret.js',
      'validateIntegrationOutput.js',
      'validateRequestInputs.js',
      'validateRequestTimestamp.js'
    ]);
  });

  describe('the scan itself works', () => {
    const detects = (code) => FORBIDDEN.filter(([, re]) => re.test(stripCommentsAndStrings(code))).map(([n]) => n);
    it('flags ES6+ constructs', () => {
      expect(detects('const a = 1;')).to.include('const declaration');
      expect(detects('let a = 1;')).to.include('let declaration');
      expect(detects('var f = (a) => a;')).to.include('arrow function');
      expect(detects('var s = `x${1}`;')).to.include('template literal');
      expect(detects('class A {}')).to.include('class');
      expect(detects('async function f() {}')).to.include('async');
      expect(detects('f(...args);')).to.include('spread / rest');
      expect(detects('var a = b?.c;')).to.include('optional chaining / nullish');
    });
    it('ignores comments and strings', () => {
      expect(detects('// const x = () => `y`\nvar a = "let b => `c`"; /* class A {} ... */')).to.deep.equal([]);
    });
  });

  files.forEach((file) => {
    describe(file, () => {
      const code = stripCommentsAndStrings(jscSource(file));

      FORBIDDEN.forEach(([name, re]) => {
        it(`has no ${name}`, () => {
          expect(re.test(code), `${name} found in ${file}`).to.equal(false);
        });
      });

      it('has the Apigee and mocha guards (typeof context / typeof module)', () => {
        const src = jscSource(file);
        expect(src).to.match(/typeof context !== "undefined"/);
        expect(src).to.match(/typeof module !== "undefined" && module\.exports/);
      });

      it('parses as a plain script (no module syntax)', () => {
        // eslint-disable-next-line no-new-func
        expect(() => new Function(jscSource(file))).to.not.throw();
      });
    });
  });

  describe('policy -> resource wiring', () => {
    const policyFiles = fs.readdirSync(POLICIES_DIR).filter((f) => f.endsWith('.xml'));
    const refs = [];
    policyFiles.forEach((f) => {
      const xml = fs.readFileSync(path.join(POLICIES_DIR, f), 'utf8');
      const re = /<ResourceURL>\s*jsc:\/\/([^<\s]+)\s*<\/ResourceURL>/g;
      let m = re.exec(xml);
      while (m) {
        refs.push({ policy: f, resource: m[1] });
        m = re.exec(xml);
      }
    });

    it('finds a jsc:// ResourceURL in each JS-* policy', () => {
      const jsPolicies = policyFiles.filter((f) => f.startsWith('JS-'));
      expect(jsPolicies).to.have.length(6);
      jsPolicies.forEach((f) => {
        expect(refs.filter((r) => r.policy === f), f).to.have.length(1);
      });
    });

    it('every <ResourceURL>jsc://...</ResourceURL> points at an existing file', () => {
      expect(refs.length).to.be.greaterThan(0);
      refs.forEach((r) => {
        expect(fs.existsSync(path.join(JSC_DIR, r.resource)), `${r.policy} -> jsc://${r.resource}`).to.equal(true);
      });
    });

    it('every resource file is referenced by exactly one policy', () => {
      files.forEach((f) => {
        expect(refs.filter((r) => r.resource === f).map((r) => r.policy), f).to.have.length(1);
      });
    });

    it('no policy uses a Javascript <ResourceURL> outside jsc://', () => {
      policyFiles.forEach((f) => {
        const xml = fs.readFileSync(path.join(POLICIES_DIR, f), 'utf8');
        const all = xml.match(/<ResourceURL>[^<]*<\/ResourceURL>/g) || [];
        all.forEach((u) => expect(u, f).to.match(/<ResourceURL>jsc:\/\//));
      });
    });

    it('the manifest <Resources> lists every JS file', () => {
      const manifest = fs.readFileSync(path.join(BUNDLE, 'sar-mot-kpis-v1.xml'), 'utf8');
      const listed = (manifest.match(/<Resource>jsc:\/\/[^<]+<\/Resource>/g) || [])
        .map((r) => r.replace(/<\/?Resource>|jsc:\/\//g, ''))
        .sort();
      expect(listed).to.deep.equal(files.slice().sort());
    });

    it('JS policies declare the flag names the flow conditions test', () => {
      const flow = fs.readFileSync(path.join(BUNDLE, 'proxies', 'default.xml'), 'utf8');
      [
        'custom.secretValid',
        'custom.timestampValid',
        'custom.kpiAllowed',
        'custom.outputValid',
        'custom.requestIdValid',
        'custom.operatorIdValid',
        'custom.yearValid',
        'custom.quarterValid'
      ].forEach((flag) => {
        expect(flow, flag).to.contain(`${flag} != "true"`);
        const owner = files.find((f) => jscSource(f).includes(`"${flag}"`));
        expect(owner, `a resource sets ${flag}`).to.be.a('string');
      });
    });

    it('SIR refs the digit-string variables set by setIntegrationParams (type="integer" kept, D35)', () => {
      const sir = fs.readFileSync(path.join(POLICIES_DIR, 'SIR-SetIntegrationRequest.xml'), 'utf8');
      expect(sir).to.contain('ref="kpi.year"');
      expect(sir).to.contain('ref="kpi.quarter"');
      expect(jscSource('setIntegrationParams.js')).to.contain('"kpi.year"').and.to.contain('"kpi.quarter"');
      expect(fs.readFileSync(path.join(POLICIES_DIR, 'AM-BuildKpiResponse.xml'), 'utf8')).to.contain('{kpi.recordsJson}');
      expect(jscSource('validateIntegrationOutput.js')).to.contain('"kpi.recordsJson"');
    });
  });

  describe('rate-limit identifiers are never the API key (D37)', () => {
    const policyFiles = fs.readdirSync(POLICIES_DIR).filter((f) => f.endsWith('.xml'));
    const strip = (xml) => xml.replace(/<!--[\s\S]*?-->/g, '');

    it('no policy uses client_id (or the key header) as an <Identifier>', () => {
      let count = 0;
      policyFiles.forEach((f) => {
        const xml = strip(fs.readFileSync(path.join(POLICIES_DIR, f), 'utf8'));
        const ids = xml.match(/<Identifier\b[^>]*>(?:[^<]*<\/Identifier>)?/g) || [];
        ids.forEach((id) => {
          count += 1;
          expect(id, f).to.not.match(/client_id|x-api-key|apikey|client_secret/i);
        });
      });
      expect(count, 'identifiers found').to.be.greaterThan(0);
    });

    it('SpikeArrest and Quota both identify the app by custom.rateIdentifier', () => {
      ['SA-SpikeArrest.xml', 'Q-ImposeQuota.xml'].forEach((f) => {
        const xml = strip(fs.readFileSync(path.join(POLICIES_DIR, f), 'utf8'));
        expect(xml, f).to.match(/<Identifier ref="custom\.rateIdentifier"\s*\/>/);
      });
    });

    it('AM-SetRateIdentifier builds it from developer email + app name, not from any credential', () => {
      const xml = strip(fs.readFileSync(path.join(POLICIES_DIR, 'AM-SetRateIdentifier.xml'), 'utf8'));
      const m = /<Name>custom\.rateIdentifier<\/Name>\s*<Template>([^<]+)<\/Template>/.exec(xml);
      expect(m, 'template').to.not.equal(null);
      expect(m[1]).to.equal('{verifyapikey.VA-VerifyApiKey.developer.email}/{verifyapikey.VA-VerifyApiKey.developer.app.name}');
      // 'verifyapikey' is the policy prefix; look for credentials and the unstable ID variables.
      expect(m[1]).to.not.match(/client_id|client_secret|request\.|developer\.id\}|app\.id\}/i);
    });

    it('AM-SetRateIdentifier runs after the key/secret checks and before SpikeArrest and Quota', () => {
      const flow = strip(fs.readFileSync(path.join(BUNDLE, 'proxies', 'default.xml'), 'utf8'));
      const at = (n) => flow.indexOf(`<Name>${n}</Name>`);
      expect(at('RF-InvalidSecret')).to.be.greaterThan(-1);
      expect(at('RF-InvalidSecret')).to.be.lessThan(at('AM-SetRateIdentifier'));
      expect(at('AM-SetRateIdentifier')).to.be.lessThan(at('SA-SpikeArrest'));
      expect(at('SA-SpikeArrest')).to.be.lessThan(at('Q-ImposeQuota'));
    });
  });
});
