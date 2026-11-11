// Static checks of the ProxyEndpoint conditions and fault handling (D33-D36, D41).
// Inputs are validated in JS-ValidateRequestInputs, which ALWAYS sets "true"/"false"
// flags. (The dev "missing X-Request-Id gives 401" defect turned out to be the platform
// injecting the header, D35; the always-set flag design stays as the safe pattern.)
// Rules enforced here:
//   1. No condition reads request.* (header, queryparam, querystring, verb, path, uri, url):
//      inputs are captured in the PreFlow (D34, D36).
//   2. Every flag a condition compares with "true" is always set (JS String(...) or a
//      "false" default in AM-SetTraceAndTimestamp).
//   3. No condition compares a possibly-missing variable with null
//      (only the debug-only `response.content != null`).
//   4. Fault handling: every RF-* sets custom.proxyFault and custom.errorCode; the
//      response-flow RFs pin custom.statusOverride; the FaultRules are mutually exclusive.
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { BUNDLE, jscSource, JSC_DIR } = require('./helpers/jsc');

const PROXY = path.join(BUNDLE, 'proxies', 'default.xml');

function decode(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function conditionsOf(xml) {
  const noComments = xml.replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  const re = /<Condition>([\s\S]*?)<\/Condition>/g;
  let m = re.exec(noComments);
  while (m) {
    out.push(decode(m[1].trim()));
    m = re.exec(noComments);
  }
  return out;
}

const REGEX_OP = '(?:JavaRegex|~~|Matches|Like|~(?![~/]))';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readsRequestInput(condition) {
  return /request\.(?:header|queryparam)\.|request\.querystring/.test(condition);
}

// D36: after SIR/IntegrationEndpoint the request message is the outbound integration
// call, so request.verb / request.path / request.uri / request.url change meaning in the
// response phase. Conditions must use custom.requestVerb (captured in the PreFlow).
function readsMutableRequestLine(condition) {
  return /\brequest\.(?:verb|path|uri|url)\b/.test(condition);
}

function flagsComparedWithTrue(condition) {
  const out = [];
  const re = /([A-Za-z0-9_.-]+)\s*!?=\s*"true"/g;
  let m = re.exec(condition);
  while (m) {
    out.push(m[1]);
    m = re.exec(condition);
  }
  return out;
}

describe('proxy conditions: no missing-variable trap (D33, D34)', () => {
  describe('the scanner itself works', () => {
    it('flags conditions that read request inputs', () => {
      expect(readsRequestInput('request.header.X-Request-Id = null')).to.equal(true);
      expect(readsRequestInput('!(request.queryparam.year JavaRegex "20[0-9]{2}")')).to.equal(true);
      expect(readsRequestInput('request.querystring JavaRegex "(.*&)?quarter=(&.*)?"')).to.equal(true);
      expect(readsRequestInput('custom.requestIdValid != "true"')).to.equal(false);
      expect(readsRequestInput('request.verb != "GET"')).to.equal(false);
    });
    it('finds flags compared with "true"', () => {
      expect(flagsComparedWithTrue('(custom.integrationCalled = "true") and (custom.proxyFault != "true")'))
        .to.deep.equal(['custom.integrationCalled', 'custom.proxyFault']);
    });
  });

  const conditions = conditionsOf(fs.readFileSync(PROXY, 'utf8'));

  it('finds the conditions', () => {
    expect(conditions.length).to.be.greaterThan(10);
  });

  it('no condition reads request.header / request.queryparam / request.querystring', () => {
    expect(conditions.filter(readsRequestInput)).to.deep.equal([]);
  });

  describe('inbound verb capture (D36)', () => {
    it('the scanner flags request.verb / path / uri / url', () => {
      expect(readsMutableRequestLine('(proxy.pathsuffix MatchesPath "/x") and (request.verb = "GET")')).to.equal(true);
      expect(readsMutableRequestLine('request.path = "/a"')).to.equal(true);
      expect(readsMutableRequestLine('request.uri ~~ ".*"')).to.equal(true);
      expect(readsMutableRequestLine('custom.requestVerb != "GET"')).to.equal(false);
      expect(readsMutableRequestLine('request.verbose = "x"')).to.equal(false);
    });

    it('no condition references request.verb / request.path / request.uri / request.url', () => {
      expect(conditions.filter(readsMutableRequestLine)).to.deep.equal([]);
    });

    it('AM-SetTraceAndTimestamp (first PreFlow step) captures request.verb into custom.requestVerb', () => {
      const am = fs.readFileSync(path.join(BUNDLE, 'policies', 'AM-SetTraceAndTimestamp.xml'), 'utf8');
      expect(am).to.match(/<Name>custom\.requestVerb<\/Name>\s*<Ref>request\.verb<\/Ref>/);
      const xml = fs.readFileSync(PROXY, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      const preflow = xml.slice(xml.indexOf('<PreFlow'), xml.indexOf('</PreFlow>'));
      const firstStep = /<Step>\s*<Name>([^<]+)<\/Name>/.exec(preflow);
      expect(firstStep && firstStep[1]).to.equal('AM-SetTraceAndTimestamp');
    });

    it('request.verb is read only at the capture point (no other policy or resource reads it)', () => {
      const policiesDir = path.join(BUNDLE, 'policies');
      const readers = fs.readdirSync(policiesDir)
        .filter((f) => /request\.verb\b/.test(fs.readFileSync(path.join(policiesDir, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '')));
      expect(readers).to.deep.equal(['AM-SetTraceAndTimestamp.xml']);
      fs.readdirSync(JSC_DIR).filter((f) => f.endsWith('.js')).forEach((f) => {
        expect(jscSource(f), f).to.not.match(/["']request\.verb["']/);
      });
    });

    it('the routing flows use custom.requestVerb with the catalog semantics (404 / 405)', () => {
      expect(conditions).to.include('(proxy.pathsuffix MatchesPath "/kpis/total_freight") and (custom.requestVerb = "GET")');
      expect(conditions).to.include('(proxy.pathsuffix MatchesPath "/kpis/total_freight") and (custom.requestVerb != "GET")');
      const xml = fs.readFileSync(PROXY, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      const notFound = xml.slice(xml.indexOf('<Flow name="NotFound">'), xml.indexOf('</Flows>'));
      expect(notFound).to.not.contain('<Condition>'); // unconditional catch-all, last
    });
  });

  it('no condition compares a possibly-missing variable with null', () => {
    const bad = conditions.filter((c) => /(?:=|!=)\s*null\b/.test(c) && c !== 'response.content != null');
    expect(bad).to.deep.equal([]);
  });

  it('every flag compared with "true" is always set (JS String(...) or AM-SetTraceAndTimestamp default)', () => {
    const jsFiles = fs.readdirSync(JSC_DIR).filter((f) => f.endsWith('.js'));
    const trace = fs.readFileSync(path.join(BUNDLE, 'policies', 'AM-SetTraceAndTimestamp.xml'), 'utf8');
    const bad = [];
    conditions.forEach((c) => flagsComparedWithTrue(c).forEach((flag) => {
      const setByJs = jsFiles.some((f) => new RegExp(`setVariable\\(\\s*"${escapeRe(flag)}",\\s*String\\(`).test(jscSource(f)));
      const defaulted = new RegExp(`<Name>${escapeRe(flag)}</Name>\\s*<Value>false</Value>`).test(trace);
      if (!setByJs && !defaulted) bad.push(flag);
    }));
    expect(bad).to.deep.equal([]);
  });

  it('catalog rows 1, 9 and 12 test the JS-ValidateRequestInputs flags', () => {
    expect(conditions).to.include('custom.requestIdValid != "true"');
    expect(conditions).to.include('custom.operatorIdValid != "true"');
    expect(conditions).to.include('custom.yearValid != "true"');
    expect(conditions).to.include('custom.quarterValid != "true"');
  });

  it('keeps the catalog order: request id < VerifyAPIKey < timestamp < operator id; params in the flow', () => {
    const xml = fs.readFileSync(PROXY, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const at = (s) => {
      const i = xml.indexOf(s);
      expect(i, s).to.be.greaterThan(-1);
      return i;
    };
    const inputs = at('<Name>JS-ValidateRequestInputs</Name>');
    const reqId = at('custom.requestIdValid != "true"');
    const va = at('<Name>VA-VerifyApiKey</Name>');
    const secret = at('custom.secretValid != "true"');
    const quota = at('<Name>Q-ImposeQuota</Name>');
    const ts = at('custom.timestampValid != "true"');
    const op = at('custom.operatorIdValid != "true"');
    const flows = at('<Flows>');
    const year = at('custom.yearValid != "true"');
    const quarter = at('custom.quarterValid != "true"');
    expect(inputs).to.be.lessThan(reqId);
    expect(reqId).to.be.lessThan(va);
    expect(va).to.be.lessThan(secret);
    expect(secret).to.be.lessThan(quota);
    expect(quota).to.be.lessThan(ts);
    expect(ts).to.be.lessThan(op);
    expect(op).to.be.lessThan(flows);
    expect(flows).to.be.lessThan(year);
    expect(year).to.be.lessThan(quarter);
  });

  it('the default trace ID is a generated UUID, not messageid (D33)', () => {
    const am = fs.readFileSync(path.join(BUNDLE, 'policies', 'AM-SetTraceAndTimestamp.xml'), 'utf8');
    expect(am).to.match(/<Name>custom\.traceId<\/Name>\s*<Template>\{createUuid\(\)\}<\/Template>/);
  });

  describe('fault handling invariants (final review I1, I2, M4)', () => {
    const POLICIES = path.join(BUNDLE, 'policies');
    const strip = (xml) => xml.replace(/<!--[\s\S]*?-->/g, '');
    const rfFiles = fs.readdirSync(POLICIES).filter((f) => /^RF-.*\.xml$/.test(f));
    const assigns = (xml, name) => {
      const m = new RegExp(`<AssignVariable>\\s*<Name>${escapeRe(name)}</Name>\\s*<Value>([^<]*)</Value>`).exec(xml);
      return m ? m[1] : null;
    };

    it('every RF-* sets custom.proxyFault = "true" and a custom.errorCode (so integration-fault never relabels it)', () => {
      expect(rfFiles.length).to.be.greaterThan(5);
      rfFiles.forEach((f) => {
        const xml = strip(fs.readFileSync(path.join(POLICIES, f), 'utf8'));
        expect(assigns(xml, 'custom.proxyFault'), f).to.equal('true');
        expect(assigns(xml, 'custom.errorCode'), f).to.match(/^ERR-/);
      });
    });

    it('the response-flow RFs also pin their status with custom.statusOverride', () => {
      [['RF-GatewayTimeout.xml', '504'], ['RF-IntegrationError.xml', '500'], ['RF-BadGateway.xml', '502']].forEach(([f, st]) => {
        const xml = strip(fs.readFileSync(path.join(POLICIES, f), 'utf8'));
        expect(assigns(xml, 'custom.statusOverride'), f).to.equal(st);
        expect(xml, f).to.contain(`<StatusCode>${st}</StatusCode>`);
      });
    });

    it('RF-GatewayTimeout (503/504 response) runs before RF-IntegrationError', () => {
      const xml = strip(fs.readFileSync(PROXY, 'utf8'));
      expect(conditions).to.include('(response.status.code = 503) or (response.status.code = 504)');
      expect(xml.indexOf('<Name>RF-GatewayTimeout</Name>')).to.be.greaterThan(-1);
      expect(xml.indexOf('<Name>RF-GatewayTimeout</Name>')).to.be.lessThan(xml.indexOf('<Name>RF-IntegrationError</Name>'));
    });

    it('integration-fault: AM-SetIntegrationError unconditionally, then AM-SetTimeoutError overwrites on timeout names or 503/504', () => {
      const xml = strip(fs.readFileSync(PROXY, 'utf8'));
      const rule = /<FaultRule name="integration-fault">([\s\S]*?)<\/FaultRule>/.exec(xml)[1];
      const steps = [];
      const re = /<Step>\s*<Name>([^<]+)<\/Name>(?:\s*<Condition>([^<]*)<\/Condition>)?\s*<\/Step>/g;
      let m = re.exec(rule);
      while (m) {
        steps.push([m[1], m[2] ? decode(m[2]) : null]);
        m = re.exec(rule);
      }
      expect(steps).to.deep.equal([
        ['AM-SetIntegrationError', null],
        ['AM-SetTimeoutError', '(fault.name = "GatewayTimeout") or (fault.name = "ServiceUnavailable")'],
        ['AM-SetTimeoutError', '(error.status.code = 503) or (error.status.code = 504)']
      ]);
    });

    it('the FaultRules are mutually exclusive (pre-call fault names vs integrationCalled = "true")', () => {
      const xml = strip(fs.readFileSync(PROXY, 'utf8'));
      const rules = [];
      const re = /<FaultRule name="([^"]+)">([\s\S]*?)<\/FaultRule>/g;
      let m = re.exec(xml);
      while (m) {
        const cond = /<Condition>([^<]*)<\/Condition>\s*$/.exec(m[2].trim());
        rules.push({ name: m[1], cond: cond ? decode(cond[1]) : '' });
        m = re.exec(xml);
      }
      expect(rules.map((r) => r.name)).to.deep.equal(['invalid-key-for-resource', 'inactive-owner', 'rate-limit', 'integration-fault']);
      const names = {};
      rules.filter((r) => r.name !== 'integration-fault').forEach((r) => {
        // Only fault.name equality tests, OR-ed together; each name in exactly one rule.
        const stripped = r.cond.replace(/\(fault\.name = "[A-Za-z_-]+"\)|fault\.name = "[A-Za-z_-]+"|\s+or\s+/g, '');
        expect(stripped, r.name).to.equal('');
        (r.cond.match(/"([A-Za-z_-]+)"/g) || []).forEach((n) => {
          expect(names[n], `${n} in two FaultRules`).to.equal(undefined);
          names[n] = r.name;
        });
      });
      // These faults come from VerifyAPIKey / SpikeArrest / Quota, all before AM-SetIntegrationCalled,
      // so custom.integrationCalled is still "false" when they fire.
      expect(Object.keys(names).sort()).to.deep.equal([
        '"CompanyStatusNotActive"', '"InvalidApiKeyForGivenResource"', '"QuotaViolation"',
        '"SpikeArrestViolation"', '"consumer_key_missing_api_product_association"'
      ].sort());
      const integ = rules.find((r) => r.name === 'integration-fault');
      expect(integ.cond).to.equal('(custom.integrationCalled = "true") and (custom.proxyFault != "true")');
      const flow = xml;
      expect(flow.indexOf('<Name>Q-ImposeQuota</Name>')).to.be.lessThan(flow.indexOf('<Name>AM-SetIntegrationCalled</Name>'));
      expect(flow.indexOf('<Name>SIR-SetIntegrationRequest</Name>')).to.be.lessThan(flow.indexOf('<Name>AM-SetIntegrationCalled</Name>'));
      const trace = fs.readFileSync(path.join(POLICIES, 'AM-SetTraceAndTimestamp.xml'), 'utf8');
      expect(trace).to.match(/<Name>custom\.integrationCalled<\/Name>\s*<Value>false<\/Value>/);
    });
  });
});
