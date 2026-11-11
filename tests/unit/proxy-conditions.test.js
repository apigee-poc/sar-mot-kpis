// Static scan of the ProxyEndpoint conditions for the "missing variable" trap
// (D33, D34). In dev, three attempts to test a missing X-Request-Id in XML did not
// fire, so the request went on to VerifyAPIKey and got 401 instead of 400:
//   - `request.header.X-Request-Id = null` and `!(... JavaRegex ...)` (revision 1);
//   - AssignVariable <Ref> + <Value> sentinel, then a regex on the copy (revision 2).
// The inputs are therefore validated in JS-ValidateRequestInputs, which ALWAYS sets
// "true"/"false" flags. Rules enforced here:
//   1. No condition reads request.header.*, request.queryparam.* or request.querystring.
//   2. A regex test (JavaRegex / ~~ / Matches / ~) on request.header/queryparam would
//      need explicit `= null` and `= ""` guards (kept as a scanner rule for future edits).
//   3. Every flag a condition compares with "true" is set by a JS resource with
//      String(...), so it always exists.
//   4. No condition compares a possibly-missing variable with null
//      (only the debug-only `response.content != null`).
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

function unguardedRequestRegex(condition) {
  const findings = [];
  const re = new RegExp(`(request\\.(?:header|queryparam)\\.[A-Za-z0-9_.-]+)\\s+${REGEX_OP}\\s`, 'g');
  let m = re.exec(condition);
  while (m) {
    const v = escapeRe(m[1]);
    const hasNull = new RegExp(`${v}\\s*(?:=|==|Equals|Is)\\s*null`, 'i').test(condition);
    const hasEmpty = new RegExp(`${v}\\s*(?:=|==|Equals|Is)\\s*""`, 'i').test(condition);
    if (!hasNull || !hasEmpty) findings.push(m[1]);
    m = re.exec(condition);
  }
  return findings;
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
    it('flags an unguarded regex on a header (revision 1 condition)', () => {
      expect(unguardedRequestRegex('!(request.header.X-Request-Id JavaRegex "[0-9]+")'))
        .to.deep.equal(['request.header.X-Request-Id']);
      expect(unguardedRequestRegex(
        '(request.header.X-Operator-Id = null) or !(request.header.X-Operator-Id JavaRegex "[12][0-9]{9}")'
      )).to.deep.equal(['request.header.X-Operator-Id']);
      expect(unguardedRequestRegex(
        '(request.header.A = null) or (request.header.A = "") or !(request.header.A JavaRegex "x")'
      )).to.deep.equal([]);
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

  it('no regex test on request.header / request.queryparam lacks explicit null and empty guards', () => {
    const bad = [];
    conditions.forEach((c) => unguardedRequestRegex(c).forEach((v) => bad.push(`${v} in: ${c}`)));
    expect(bad).to.deep.equal([]);
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

  it('AM-CaptureRequestInputs and its copies are gone (D34)', () => {
    expect(fs.existsSync(path.join(BUNDLE, 'policies', 'AM-CaptureRequestInputs.xml'))).to.equal(false);
    const all = fs.readdirSync(path.join(BUNDLE, 'policies'))
      .map((f) => fs.readFileSync(path.join(BUNDLE, 'policies', f), 'utf8'))
      .concat([fs.readFileSync(PROXY, 'utf8'), fs.readFileSync(path.join(BUNDLE, 'sar-mot-kpis-v1.xml'), 'utf8')])
      .join('\n');
    expect(all).to.not.match(/custom\.input\.|private\.input\.|AM-CaptureRequestInputs/);
  });
});
