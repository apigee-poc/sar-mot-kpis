const { expect } = require('chai');
const { load, runInApigee } = require('./helpers/jsc');

const { isKpiAllowed } = load('checkKpiAllowed.js');

describe('proxy JS: checkKpiAllowed (ERR-404-RESOURCE when not allowed)', () => {
  describe('isKpiAllowed', () => {
    it('allows a code that is the only entry', () => {
      expect(isKpiAllowed('total_freight', 'total_freight')).to.equal(true);
    });
    it('allows a code anywhere in the list (first, middle, last)', () => {
      const list = 'total_freight,on_time_rate,dwell_time';
      expect(isKpiAllowed('total_freight', list)).to.equal(true);
      expect(isKpiAllowed('on_time_rate', list)).to.equal(true);
      expect(isKpiAllowed('dwell_time', list)).to.equal(true);
    });
    it('rejects a code that is not in the list', () => {
      expect(isKpiAllowed('other_kpi', 'total_freight,on_time_rate')).to.equal(false);
    });
    it('matches whole entries only (no prefix/suffix/substring match)', () => {
      expect(isKpiAllowed('total', 'total_freight')).to.equal(false);
      expect(isKpiAllowed('total_freight_x', 'total_freight')).to.equal(false);
      expect(isKpiAllowed('freight', 'total_freight')).to.equal(false);
      expect(isKpiAllowed('total_freight', 'total_freight_x,x_total_freight')).to.equal(false);
    });
    it('ignores blanks around entries', () => {
      expect(isKpiAllowed('total_freight', ' total_freight ')).to.equal(true);
      expect(isKpiAllowed('on_time_rate', 'total_freight , on_time_rate ,dwell_time')).to.equal(true);
      expect(isKpiAllowed('on_time_rate', 'total_freight,\ton_time_rate\n')).to.equal(true);
    });
    it('does not ignore blanks inside an entry', () => {
      expect(isKpiAllowed('total_freight', 'total _freight')).to.equal(false);
      expect(isKpiAllowed('total freight', 'total_freight')).to.equal(false);
    });
    it('is case-sensitive', () => {
      expect(isKpiAllowed('Total_Freight', 'total_freight')).to.equal(false);
      expect(isKpiAllowed('total_freight', 'TOTAL_FREIGHT')).to.equal(false);
    });
    it('rejects every code when the list is empty or blank', () => {
      expect(isKpiAllowed('total_freight', '')).to.equal(false);
      expect(isKpiAllowed('total_freight', '   ')).to.equal(false);
      expect(isKpiAllowed('total_freight', ',,')).to.equal(false);
    });
    it('an empty kpi code is never allowed, even with empty entries in the list', () => {
      expect(isKpiAllowed('', '')).to.equal(false);
      expect(isKpiAllowed('', ',total_freight,')).to.equal(false);
      expect(isKpiAllowed('', ' ')).to.equal(false);
    });
    it('tolerates empty entries between real ones', () => {
      expect(isKpiAllowed('total_freight', ',,total_freight,,')).to.equal(true);
    });
    [
      ['kpiCode null', null, 'total_freight'],
      ['kpiCode undefined', undefined, 'total_freight'],
      ['list null (config key missing)', 'total_freight', null],
      ['list undefined', 'total_freight', undefined],
      ['both null', null, null]
    ].forEach(([name, code, list]) => {
      it(`rejects ${name}`, () => {
        expect(isKpiAllowed(code, list)).to.equal(false);
      });
    });
    it('does not treat regex or wildcard characters specially', () => {
      expect(isKpiAllowed('total_freight', '*')).to.equal(false);
      expect(isKpiAllowed('total_freight', '.*')).to.equal(false);
      expect(isKpiAllowed('a.b', 'a.b')).to.equal(true);
      expect(isKpiAllowed('axb', 'a.b')).to.equal(false);
    });
    it('splits on commas only (semicolon/space separated lists do not match)', () => {
      expect(isKpiAllowed('total_freight', 'a;total_freight')).to.equal(false);
      expect(isKpiAllowed('total_freight', 'a total_freight')).to.equal(false);
    });
  });

  describe('as run in Apigee (flag contract)', () => {
    const run = (code, list) => runInApigee('checkKpiAllowed.js', { 'kpi.code': code, 'config.allowedKpis': list });

    it('sets custom.kpiAllowed to "true" when allowed (and nothing else)', () => {
      expect(run('total_freight', 'total_freight')).to.deep.equal({ 'custom.kpiAllowed': 'true' });
    });
    it('sets "false" when not allowed (flow raises when != "true")', () => {
      expect(run('other', 'total_freight')).to.deep.equal({ 'custom.kpiAllowed': 'false' });
    });
    it('sets "false" when config.allowedKpis is unresolved', () => {
      expect(run('total_freight', null)).to.deep.equal({ 'custom.kpiAllowed': 'false' });
    });
    it('sets "false" when kpi.code is unresolved', () => {
      expect(run(null, 'total_freight')).to.deep.equal({ 'custom.kpiAllowed': 'false' });
    });
  });
});
