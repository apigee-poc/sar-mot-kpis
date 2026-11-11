const { expect } = require('chai');
const { load, runInApigee, jscSource } = require('./helpers/jsc');

const {
  isValidRequestId,
  isValidOperatorId,
  isValidYear,
  isValidQuarter,
  validateRequestInputs
} = load('validateRequestInputs.js');

const UUID = 'd7b2a92c-5f81-42cb-9964-b0e6df41c107';
const OPERATOR = '1000124102';

describe('proxy JS: validateRequestInputs (rows 1, 9, 12; D34)', () => {
  describe('isValidRequestId (row 1)', () => {
    it('accepts a UUID, lower and upper case', () => {
      expect(isValidRequestId(UUID)).to.equal(true);
      expect(isValidRequestId(UUID.toUpperCase())).to.equal(true);
    });
    it('rejects absent and empty', () => {
      expect(isValidRequestId(null)).to.equal(false);
      expect(isValidRequestId(undefined)).to.equal(false);
      expect(isValidRequestId('')).to.equal(false);
    });
    it('rejects wrong formats', () => {
      expect(isValidRequestId('nope')).to.equal(false);
      expect(isValidRequestId(`${UUID}2`)).to.equal(false); // messageid-like
      expect(isValidRequestId(` ${UUID}`)).to.equal(false);
      expect(isValidRequestId(UUID.replace(/-/g, ''))).to.equal(false);
      expect(isValidRequestId(`{${UUID}}`)).to.equal(false);
      expect(isValidRequestId('g7b2a92c-5f81-42cb-9964-b0e6df41c107')).to.equal(false);
      expect(isValidRequestId(`${UUID}\n`)).to.equal(false);
    });
    it('judges non-strings by their text form', () => {
      expect(isValidRequestId(12345)).to.equal(false);
      expect(isValidRequestId({})).to.equal(false);
      expect(isValidRequestId(true)).to.equal(false);
      expect(isValidRequestId({ toString: () => UUID })).to.equal(true); // Java-string-like object
    });
  });

  describe('isValidOperatorId (row 9)', () => {
    it('accepts 10 digits starting with 1 or 2', () => {
      expect(isValidOperatorId(OPERATOR)).to.equal(true);
      expect(isValidOperatorId('2999999999')).to.equal(true);
    });
    it('rejects absent and empty', () => {
      expect(isValidOperatorId(null)).to.equal(false);
      expect(isValidOperatorId(undefined)).to.equal(false);
      expect(isValidOperatorId('')).to.equal(false);
    });
    it('rejects wrong formats', () => {
      expect(isValidOperatorId('3000124102')).to.equal(false);
      expect(isValidOperatorId('0000124102')).to.equal(false);
      expect(isValidOperatorId('100012410')).to.equal(false);
      expect(isValidOperatorId('10001241022')).to.equal(false);
      expect(isValidOperatorId('10001241O2')).to.equal(false);
      expect(isValidOperatorId(' 1000124102')).to.equal(false);
      expect(isValidOperatorId('1000124102\n')).to.equal(false);
      expect(isValidOperatorId('１000124102')).to.equal(false); // full-width digit
    });
    it('judges non-strings by their text form', () => {
      expect(isValidOperatorId(1000124102)).to.equal(true);
      expect(isValidOperatorId(3000124102)).to.equal(false);
      expect(isValidOperatorId({})).to.equal(false);
    });
  });

  describe('isValidYear (row 12)', () => {
    it('accepts 2000-2099', () => {
      ['2000', '2025', '2099'].forEach((y) => expect(isValidYear(y), y).to.equal(true));
    });
    it('rejects absent and empty', () => {
      expect(isValidYear(null)).to.equal(false);
      expect(isValidYear(undefined)).to.equal(false);
      expect(isValidYear('')).to.equal(false);
    });
    it('rejects wrong formats', () => {
      ['1999', '2100', '25', '02025', '2025.0', '+2025', ' 2025', '2025 ', 'abcd', '2O25'].forEach((y) => {
        expect(isValidYear(y), y).to.equal(false);
      });
    });
    it('judges non-strings by their text form', () => {
      expect(isValidYear(2025)).to.equal(true);
      expect(isValidYear(1999)).to.equal(false);
      expect(isValidYear([])).to.equal(false);
    });
  });

  describe('isValidQuarter (row 12)', () => {
    it('accepts 1-4', () => {
      ['1', '2', '3', '4'].forEach((q) => expect(isValidQuarter(q, `year=2025&quarter=${q}`), q).to.equal(true));
    });
    it('accepts an absent quarter', () => {
      expect(isValidQuarter(null, 'year=2025')).to.equal(true);
      expect(isValidQuarter(undefined, 'year=2025')).to.equal(true);
      expect(isValidQuarter(null, null)).to.equal(true);
      expect(isValidQuarter(null, undefined)).to.equal(true);
      expect(isValidQuarter(null, '')).to.equal(true);
    });
    it('rejects an empty quarter value', () => {
      expect(isValidQuarter('', 'year=2025&quarter=')).to.equal(false);
    });
    it('rejects an empty quarter= in the query string even if the param reads as absent', () => {
      expect(isValidQuarter(null, 'year=2025&quarter=')).to.equal(false);
      expect(isValidQuarter(null, 'quarter=&year=2025')).to.equal(false);
      expect(isValidQuarter(null, 'quarter=')).to.equal(false);
      expect(isValidQuarter(null, 'year=2025&quarter=&x=1')).to.equal(false);
    });
    it('does not confuse other parameters ending in quarter=', () => {
      expect(isValidQuarter(null, 'year=2025&fiscalquarter=')).to.equal(true);
    });
    it('rejects wrong formats', () => {
      ['0', '5', '01', '1.0', ' 1', 'Q1', 'one', '-1'].forEach((q) => {
        expect(isValidQuarter(q, `quarter=${q}`), q).to.equal(false);
      });
    });
    it('judges non-strings by their text form', () => {
      expect(isValidQuarter(3, 'quarter=3')).to.equal(true);
      expect(isValidQuarter(9, 'quarter=9')).to.equal(false);
      expect(isValidQuarter({}, null)).to.equal(false);
    });
  });

  describe('validateRequestInputs', () => {
    it('returns four booleans for a fully valid request', () => {
      expect(validateRequestInputs({ requestId: UUID, operatorId: OPERATOR, year: '2025', quarter: '3', queryString: 'year=2025&quarter=3' }))
        .to.deep.equal({ requestIdValid: true, operatorIdValid: true, yearValid: true, quarterValid: true });
    });
    it('treats everything absent as invalid except quarter', () => {
      expect(validateRequestInputs({}))
        .to.deep.equal({ requestIdValid: false, operatorIdValid: false, yearValid: false, quarterValid: true });
      expect(validateRequestInputs(null))
        .to.deep.equal({ requestIdValid: false, operatorIdValid: false, yearValid: false, quarterValid: true });
      expect(validateRequestInputs(undefined))
        .to.deep.equal({ requestIdValid: false, operatorIdValid: false, yearValid: false, quarterValid: true });
    });
    it('evaluates each input independently', () => {
      expect(validateRequestInputs({ requestId: 'nope', operatorId: OPERATOR, year: '1999', quarter: '3' }))
        .to.deep.equal({ requestIdValid: false, operatorIdValid: true, yearValid: false, quarterValid: true });
    });
    it('never returns the input values', () => {
      const out = validateRequestInputs({ requestId: UUID, operatorId: OPERATOR, year: '2025' });
      expect(JSON.stringify(out)).to.not.contain(OPERATOR).and.to.not.contain(UUID);
    });
  });

  describe('Apigee glue', () => {
    const FLAGS = ['custom.requestIdValid', 'custom.operatorIdValid', 'custom.yearValid', 'custom.quarterValid'];

    it('sets all four flags as "true" strings for a valid request', () => {
      const set = runInApigee('validateRequestInputs.js', {
        'request.header.X-Request-Id': UUID,
        'request.header.X-Operator-Id': OPERATOR,
        'request.queryparam.year': '2025',
        'request.queryparam.quarter': '3',
        'request.querystring': 'year=2025&quarter=3'
      });
      expect(set).to.deep.equal({
        'custom.requestIdValid': 'true',
        'custom.operatorIdValid': 'true',
        'custom.yearValid': 'true',
        'custom.quarterValid': 'true'
      });
    });

    it('ALWAYS sets every flag, even when nothing is present (the D33/D34 lesson)', () => {
      const set = runInApigee('validateRequestInputs.js', {});
      expect(Object.keys(set).sort()).to.deep.equal(FLAGS.slice().sort());
      expect(set['custom.requestIdValid']).to.equal('false');
      expect(set['custom.operatorIdValid']).to.equal('false');
      expect(set['custom.yearValid']).to.equal('false');
      expect(set['custom.quarterValid']).to.equal('true');
    });

    it('a missing X-Request-Id gives custom.requestIdValid = "false"', () => {
      const set = runInApigee('validateRequestInputs.js', {
        'request.header.X-Operator-Id': OPERATOR,
        'request.queryparam.year': '2025'
      });
      expect(set['custom.requestIdValid']).to.equal('false');
    });

    it('an empty quarter= gives custom.quarterValid = "false" whether the param reads "" or null', () => {
      expect(runInApigee('validateRequestInputs.js', {
        'request.queryparam.year': '2025',
        'request.queryparam.quarter': '',
        'request.querystring': 'year=2025&quarter='
      })['custom.quarterValid']).to.equal('false');
      expect(runInApigee('validateRequestInputs.js', {
        'request.queryparam.year': '2025',
        'request.querystring': 'year=2025&quarter='
      })['custom.quarterValid']).to.equal('false');
    });

    it('sets only the four flags and never writes an input value', () => {
      const set = runInApigee('validateRequestInputs.js', {
        'request.header.X-Request-Id': UUID,
        'request.header.X-Operator-Id': OPERATOR,
        'request.queryparam.year': '2025'
      });
      expect(Object.keys(set).sort()).to.deep.equal(FLAGS.slice().sort());
      Object.keys(set).forEach((k) => expect(set[k]).to.be.oneOf(['true', 'false']));
    });

    it('has no logging calls (print / console)', () => {
      const src = jscSource('validateRequestInputs.js');
      expect(src).to.not.match(/\bprint\s*\(|console\./);
    });
  });
});
