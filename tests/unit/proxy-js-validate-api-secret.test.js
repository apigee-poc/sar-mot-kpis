const { expect } = require('chai');
const { load, runInApigee } = require('./helpers/jsc');

const { secretsMatch } = load('validateApiSecret.js');

describe('proxy JS: validateApiSecret (ERR-401-SECRET)', () => {
  describe('secretsMatch', () => {
    it('accepts identical secrets', () => {
      expect(secretsMatch('s3cr3t-Value_123', 's3cr3t-Value_123')).to.equal(true);
    });
    it('is case-sensitive', () => {
      expect(secretsMatch('Secret', 'secret')).to.equal(false);
    });
    it('rejects a difference in the last character', () => {
      expect(secretsMatch('abcdefgh', 'abcdefgi')).to.equal(false);
    });
    it('rejects a difference in the first character', () => {
      expect(secretsMatch('xbcdefgh', 'abcdefgh')).to.equal(false);
    });
    it('rejects when provided is a prefix of expected (shorter)', () => {
      expect(secretsMatch('abcdefg', 'abcdefgh')).to.equal(false);
    });
    it('rejects when provided is longer than expected', () => {
      expect(secretsMatch('abcdefgh', 'abcdefg')).to.equal(false);
      expect(secretsMatch('abcdefgh-extra', 'abcdefgh')).to.equal(false);
    });
    it('does not treat trailing NUL padding as equal (length is compared too)', () => {
      expect(secretsMatch('abc', 'abc\u0000')).to.equal(false);
      expect(secretsMatch('abc\u0000', 'abc')).to.equal(false);
    });
    it('does not trim whitespace', () => {
      expect(secretsMatch('abc ', 'abc')).to.equal(false);
      expect(secretsMatch(' abc', 'abc')).to.equal(false);
    });
    [
      ['provided undefined', undefined, 'abc'],
      ['provided null', null, 'abc'],
      ['provided empty', '', 'abc'],
      ['expected undefined', 'abc', undefined],
      ['expected null', 'abc', null],
      ['expected empty', 'abc', ''],
      ['both empty', '', ''],
      ['both null', null, null],
      ['both undefined', undefined, undefined]
    ].forEach(([name, a, b]) => {
      it(`rejects ${name}`, () => {
        expect(secretsMatch(a, b)).to.equal(false);
      });
    });
    it('compares non-ASCII (UTF-16 code unit) secrets', () => {
      expect(secretsMatch('sécrèt-ش', 'sécrèt-ش')).to.equal(true);
      expect(secretsMatch('sécrèt-ش', 'sécrèt-ص')).to.equal(false);
      expect(secretsMatch('é', 'e')).to.equal(false);
    });
    it('compares astral characters (surrogate pairs)', () => {
      expect(secretsMatch('k😀', 'k😀')).to.equal(true);
      expect(secretsMatch('k😀', 'k😁')).to.equal(false);
    });
    it('coerces non-string values to text', () => {
      expect(secretsMatch(12345, '12345')).to.equal(true);
      expect(secretsMatch(12345, 12346)).to.equal(false);
    });
    it('compares long secrets in full (differing only in the last char)', () => {
      const base = 'a'.repeat(4096);
      expect(secretsMatch(`${base}x`, `${base}x`)).to.equal(true);
      expect(secretsMatch(`${base}x`, `${base}y`)).to.equal(false);
    });
    // The compare has no early exit (XOR accumulate over the longer length). That is a
    // timing property and is not measured here; only the result is checked above.
  });

  describe('as run in Apigee (flag contract)', () => {
    const run = (provided, expected) => runInApigee('validateApiSecret.js', {
      'request.header.X-API-Secret': provided,
      'verifyapikey.VA-VerifyApiKey.client_secret': expected
    });

    it('sets custom.secretValid to "true" on match and sets nothing else', () => {
      expect(run('abc', 'abc')).to.deep.equal({ 'custom.secretValid': 'true' });
    });
    it('sets "false" on mismatch (flow raises when != "true")', () => {
      expect(run('abc', 'abd')).to.deep.equal({ 'custom.secretValid': 'false' });
    });
    it('sets "false" when the header is absent (unresolved variable is null)', () => {
      expect(run(null, 'abc')).to.deep.equal({ 'custom.secretValid': 'false' });
    });
    it('sets "false" when the app has no client secret', () => {
      expect(run('abc', null)).to.deep.equal({ 'custom.secretValid': 'false' });
    });
    it('never copies the secret into any variable name or value', () => {
      const set = run('very-secret-value', 'very-secret-value');
      expect(JSON.stringify(set)).to.not.contain('very-secret-value');
    });
  });
});
