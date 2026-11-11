const { expect } = require('chai');
const { load, runInApigee } = require('./helpers/jsc');

const { toIntegrationParams } = load('setIntegrationParams.js');

describe('proxy JS: setIntegrationParams (SIR year/quarter as numbers, quarter 0 = all)', () => {
  describe('toIntegrationParams', () => {
    it('converts year and quarter strings to numbers', () => {
      const r = toIntegrationParams('2025', '3');
      expect(r).to.deep.equal({ year: 2025, quarter: 3 });
      expect(r.year).to.be.a('number');
      expect(r.quarter).to.be.a('number');
    });
    it('quarter absent (null/undefined) -> 0', () => {
      expect(toIntegrationParams('2025', null)).to.deep.equal({ year: 2025, quarter: 0 });
      expect(toIntegrationParams('2025', undefined)).to.deep.equal({ year: 2025, quarter: 0 });
    });
    it('quarter empty string -> 0 (the flow rejects "?quarter=" earlier, so this is defensive)', () => {
      expect(toIntegrationParams('2025', '')).to.deep.equal({ year: 2025, quarter: 0 });
    });
    it('accepts every quarter 1..4', () => {
      [1, 2, 3, 4].forEach((q) => {
        expect(toIntegrationParams('2025', String(q)).quarter).to.equal(q);
      });
    });
    it('accepts year boundaries 2000 and 2099', () => {
      expect(toIntegrationParams('2000', '1').year).to.equal(2000);
      expect(toIntegrationParams('2099', '4').year).to.equal(2099);
    });
    it('accepts values that are already numbers', () => {
      expect(toIntegrationParams(2025, 3)).to.deep.equal({ year: 2025, quarter: 3 });
      expect(toIntegrationParams(2025, null)).to.deep.equal({ year: 2025, quarter: 0 });
    });

    // Unreachable after RF-InvalidQueryParams; the defined safe behaviour is null (no throw).
    [
      ['year missing (null)', null, '1'],
      ['year missing (undefined)', undefined, '1'],
      ['year empty', '', '1'],
      ['year 1999', '1999', '1'],
      ['year 2100', '2100', '1'],
      ['year with 3 digits', '202', '1'],
      ['year with 5 digits', '20250', '1'],
      ['year with leading zero', '02025', '1'],
      ['year with spaces', ' 2025', '1'],
      ['year decimal', '2025.0', '1'],
      ['year text', 'abcd', '1'],
      ['year negative', '-2025', '1'],
      ['quarter 0', '2025', '0'],
      ['quarter 5', '2025', '5'],
      ['quarter 10', '2025', '10'],
      ['quarter text', '2025', 'q1'],
      ['quarter decimal', '2025', '1.5'],
      ['quarter with space', '2025', ' 1'],
      ['quarter negative', '2025', '-1'],
      ['quarter number 0', '2025', 0]
    ].forEach(([name, year, quarter]) => {
      it(`returns null for ${name}`, () => {
        expect(toIntegrationParams(year, quarter)).to.equal(null);
      });
    });
  });

  describe('as run in Apigee (flow contract)', () => {
    const run = (year, quarter) => runInApigee('setIntegrationParams.js', {
      'request.queryparam.year': year,
      'request.queryparam.quarter': quarter
    });

    it('sets numeric kpi.year and kpi.quarter (what SIR-SetIntegrationRequest refs)', () => {
      const set = run('2025', '3');
      expect(set).to.deep.equal({ 'kpi.year': 2025, 'kpi.quarter': 3 });
      expect(set['kpi.year']).to.be.a('number');
      expect(set['kpi.quarter']).to.be.a('number');
    });
    it('sets kpi.quarter 0 when the query parameter is unresolved (null)', () => {
      expect(run('2025', null)).to.deep.equal({ 'kpi.year': 2025, 'kpi.quarter': 0 });
    });
    it('sets nothing for invalid input (SIR then falls back to its literal, never garbage)', () => {
      expect(run('abcd', '3')).to.deep.equal({});
      expect(run('2025', '9')).to.deep.equal({});
      expect(run(null, null)).to.deep.equal({});
    });
  });
});
