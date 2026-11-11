// Static scan of the ProxyEndpoint step conditions for the "missing variable" trap
// (D33): in dev, a step whose condition tested a missing X-Request-Id header was
// skipped, so the request went on to VerifyAPIKey and got 401 instead of 400.
// Rules enforced here:
//   1. A regex test (JavaRegex / ~~ / Matches / ~) on request.header.* or
//      request.queryparam.* must carry explicit `= null` and `= ""` guards for the
//      same variable in the same condition.
//   2. A NEGATED regex test (!(x JavaRegex ...)) may only target a variable that
//      AM-CaptureRequestInputs always assigns (Ref + <Value> sentinel).
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { BUNDLE } = require('./helpers/jsc');

const PROXY = path.join(BUNDLE, 'proxies', 'default.xml');
const CAPTURE = path.join(BUNDLE, 'policies', 'AM-CaptureRequestInputs.xml');

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

// Rule 1: request.header/queryparam regex tests need null and empty guards.
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

// Rule 2: negated regex tests only on always-defined variables.
function negatedRegexTargets(condition) {
  const out = [];
  const re = new RegExp(`!\\s*\\(\\s*([A-Za-z0-9_.-]+)\\s+${REGEX_OP}\\s`, 'g');
  let m = re.exec(condition);
  while (m) {
    out.push(m[1]);
    m = re.exec(condition);
  }
  return out;
}

function alwaysDefinedInputs() {
  const xml = fs.readFileSync(CAPTURE, 'utf8');
  const out = [];
  const re = /<AssignVariable>\s*<Name>([^<]+)<\/Name>\s*<Ref>[^<]+<\/Ref>\s*<Value>[^<]+<\/Value>\s*<\/AssignVariable>/g;
  let m = re.exec(xml);
  while (m) {
    out.push(m[1].trim());
    m = re.exec(xml);
  }
  return out;
}

describe('proxy conditions: no missing-variable trap (D33)', () => {
  describe('the scanner itself works', () => {
    it('flags a regex on a header without guards', () => {
      expect(unguardedRequestRegex('!(request.header.X-Request-Id JavaRegex "[0-9]+")'))
        .to.deep.equal(['request.header.X-Request-Id']);
      expect(unguardedRequestRegex('request.queryparam.year ~~ "20[0-9]{2}"'))
        .to.deep.equal(['request.queryparam.year']);
    });
    it('flags a regex with only a null guard (empty missing)', () => {
      expect(unguardedRequestRegex(
        '(request.header.X-Operator-Id = null) or !(request.header.X-Operator-Id JavaRegex "[12][0-9]{9}")'
      )).to.deep.equal(['request.header.X-Operator-Id']);
    });
    it('accepts a regex with null and empty guards', () => {
      expect(unguardedRequestRegex(
        '(request.header.A = null) or (request.header.A = "") or !(request.header.A JavaRegex "x")'
      )).to.deep.equal([]);
    });
    it('ignores regex tests on other variables', () => {
      expect(unguardedRequestRegex('request.querystring JavaRegex "(.*&)?quarter=(&.*)?"')).to.deep.equal([]);
      expect(unguardedRequestRegex('proxy.pathsuffix MatchesPath "/kpis/total_freight"')).to.deep.equal([]);
    });
    it('finds negated regex targets', () => {
      expect(negatedRegexTargets('(a != "x") and !(custom.input.quarter JavaRegex "[1-4]")'))
        .to.deep.equal(['custom.input.quarter']);
    });
  });

  const conditions = conditionsOf(fs.readFileSync(PROXY, 'utf8'));
  const allowed = alwaysDefinedInputs();

  it('finds the step conditions and the captured inputs', () => {
    expect(conditions.length).to.be.greaterThan(10);
    expect(allowed).to.include.members([
      'custom.input.requestId',
      'private.input.operatorId',
      'custom.input.year',
      'custom.input.quarter'
    ]);
  });

  it('no regex test on request.header / request.queryparam lacks explicit null and empty guards', () => {
    const bad = [];
    conditions.forEach((c) => unguardedRequestRegex(c).forEach((v) => bad.push(`${v} in: ${c}`)));
    expect(bad).to.deep.equal([]);
  });

  it('every negated regex test targets a variable AM-CaptureRequestInputs always assigns', () => {
    const bad = [];
    conditions.forEach((c) => negatedRegexTargets(c).forEach((v) => {
      if (allowed.indexOf(v) === -1) bad.push(`${v} in: ${c}`);
    }));
    expect(bad).to.deep.equal([]);
  });

  it('the header checks of catalog rows 1, 9 and 12 use the captured inputs', () => {
    expect(conditions).to.include('!(custom.input.requestId JavaRegex "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")');
    expect(conditions).to.include('!(private.input.operatorId JavaRegex "[12][0-9]{9}")');
    expect(conditions).to.include('!(custom.input.year JavaRegex "20[0-9]{2}")');
    expect(conditions).to.include('(custom.input.quarter != "__absent__") and !(custom.input.quarter JavaRegex "[1-4]")');
  });

  it('no condition compares a possibly-missing variable with null', () => {
    const bad = conditions.filter((c) => /(?:=|!=)\s*null\b/.test(c) && !/response\.content != null/.test(c));
    expect(bad).to.deep.equal([]);
  });

  it('the default trace ID is a generated UUID, not messageid (D33)', () => {
    const am = fs.readFileSync(path.join(BUNDLE, 'policies', 'AM-SetTraceAndTimestamp.xml'), 'utf8');
    expect(am).to.match(/<Name>custom\.traceId<\/Name>\s*<Template>\{createUuid\(\)\}<\/Template>/);
  });
});
