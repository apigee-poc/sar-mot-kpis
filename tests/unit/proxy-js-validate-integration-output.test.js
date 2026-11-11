const { expect } = require('chai');
const { load, runInApigee } = require('./helpers/jsc');

const { validateIntegrationOutput, MAX_RECORDS } = load('validateIntegrationOutput.js');

// The OAS `full-year` example (api/sar-mot-kpis-oas.yaml, GET /kpis/total_freight).
const OAS_FULL_YEAR = [
  { quarter: 1, year: 2025, actual: 1420500, loadTime: '2025-04-05T02:00:00Z' },
  { quarter: 2, year: 2025, actual: 1388200, loadTime: '2025-07-05T02:00:00Z' },
  { quarter: 3, year: 2025, actual: 1512750, loadTime: '2025-10-05T02:00:00Z' }
];

const rec = (over) => Object.assign({ quarter: 3, year: 2025, actual: 1512750, loadTime: '2025-10-05T02:00:00Z' }, over);
const wrap = (records) => JSON.stringify({ executionId: 'abc', outputParameters: { data: { records } } });

describe('proxy JS: validateIntegrationOutput (ERR-502-GATEWAY)', () => {
  it('MAX_RECORDS is 4 (one per quarter)', () => {
    expect(MAX_RECORDS).to.equal(4);
  });

  describe('valid output', () => {
    it('accepts {outputParameters:{data:{records:[...]}}}', () => {
      const r = validateIntegrationOutput(wrap(OAS_FULL_YEAR));
      expect(r.valid).to.equal(true);
      expect(r.records).to.deep.equal(OAS_FULL_YEAR);
    });
    it('empty records -> valid, [] (200 with "data": [])', () => {
      const r = validateIntegrationOutput(wrap([]));
      expect(r).to.deep.equal({ valid: true, records: [], recordsJson: '[]' });
    });
    it('accepts 1 and exactly 4 records', () => {
      expect(validateIntegrationOutput(wrap([rec()])).valid).to.equal(true);
      const four = [1, 2, 3, 4].map((q) => rec({ quarter: q }));
      const r = validateIntegrationOutput(wrap(four));
      expect(r.valid).to.equal(true);
      expect(r.records).to.have.length(4);
    });
    it('tolerates a top-level data object (no outputParameters wrapper)', () => {
      const r = validateIntegrationOutput(JSON.stringify({ data: { records: OAS_FULL_YEAR } }));
      expect(r.valid).to.equal(true);
      expect(r.records).to.deep.equal(OAS_FULL_YEAR);
    });
    it('parses data that arrives as a JSON string (outputParameters.data and top-level)', () => {
      const asString = JSON.stringify({ records: OAS_FULL_YEAR });
      expect(validateIntegrationOutput(JSON.stringify({ outputParameters: { data: asString } })).valid).to.equal(true);
      expect(validateIntegrationOutput(JSON.stringify({ data: asString })).valid).to.equal(true);
    });
    it('accepts the content as an already-parsed-then-stringified body with extra top-level fields', () => {
      const body = JSON.stringify({ executionId: 'e', status: 'SUCCEEDED', outputParameters: { data: { records: [rec()] }, other: 1 } });
      expect(validateIntegrationOutput(body).valid).to.equal(true);
    });
    it('does not require the data object to carry anything besides records', () => {
      const body = JSON.stringify({ outputParameters: { data: { records: [rec()], note: 'x' } } });
      expect(validateIntegrationOutput(body).valid).to.equal(true);
    });
    it('prefers outputParameters over a top-level data when both exist', () => {
      const body = JSON.stringify({ outputParameters: { data: { records: [] } }, data: { records: [rec()] } });
      expect(validateIntegrationOutput(body).records).to.deep.equal([]);
    });
  });

  describe('record shaping and number fidelity', () => {
    it('keeps numbers as numbers (actual 1512750, year and quarter integers)', () => {
      const r = validateIntegrationOutput(wrap([rec()]));
      const out = r.records[0];
      expect(out.actual).to.equal(1512750);
      expect(out.actual).to.be.a('number');
      expect(out.year).to.be.a('number');
      expect(out.quarter).to.be.a('number');
      expect(r.recordsJson).to.contain('"actual":1512750');
      expect(r.recordsJson).to.contain('"year":2025');
      expect(r.recordsJson).to.contain('"quarter":3');
      expect(r.recordsJson).to.not.contain('"actual":"');
      expect(r.recordsJson).to.not.contain('1512750.0');
    });
    it('a whole-number double from the integration (1512750.0 parsed) serialises as 1512750', () => {
      const body = '{"outputParameters":{"data":{"records":[{"quarter":3.0,"year":2025.0,"actual":1512750.0,"loadTime":"2025-10-05T02:00:00Z"}]}}}';
      const r = validateIntegrationOutput(body);
      expect(r.valid).to.equal(true);
      expect(r.recordsJson).to.equal('[{"quarter":3,"year":2025,"actual":1512750,"loadTime":"2025-10-05T02:00:00Z"}]');
    });
    it('preserves fractional and zero amounts', () => {
      const r = validateIntegrationOutput(wrap([rec({ actual: 1234.5 }), rec({ quarter: 2, actual: 0 })]));
      expect(r.records[0].actual).to.equal(1234.5);
      expect(r.records[1].actual).to.equal(0);
    });
    it('rebuilds each record with exactly the OAS fields in OAS order and drops extras', () => {
      const messy = { loadTime: '2025-10-05T02:00:00Z', actual: 1512750, extra: 'x', year: 2025, id: 7, quarter: 3 };
      const r = validateIntegrationOutput(wrap([messy]));
      expect(Object.keys(r.records[0])).to.deep.equal(['quarter', 'year', 'actual', 'loadTime']);
      expect(r.recordsJson).to.equal('[{"quarter":3,"year":2025,"actual":1512750,"loadTime":"2025-10-05T02:00:00Z"}]');
    });
    it('the data array serialises exactly like the OAS example for 2025', () => {
      const r = validateIntegrationOutput(wrap(OAS_FULL_YEAR));
      expect(r.recordsJson).to.equal(JSON.stringify(OAS_FULL_YEAR));
      expect(r.recordsJson).to.equal(
        '[{"quarter":1,"year":2025,"actual":1420500,"loadTime":"2025-04-05T02:00:00Z"},'
        + '{"quarter":2,"year":2025,"actual":1388200,"loadTime":"2025-07-05T02:00:00Z"},'
        + '{"quarter":3,"year":2025,"actual":1512750,"loadTime":"2025-10-05T02:00:00Z"}]'
      );
    });
    it('keeps the order of the records', () => {
      const r = validateIntegrationOutput(wrap([rec({ quarter: 4 }), rec({ quarter: 1 })]));
      expect(r.records.map((x) => x.quarter)).to.deep.equal([4, 1]);
    });
    it('the assembled 200 body parses as the OAS envelope shape', () => {
      const r = validateIntegrationOutput(wrap(OAS_FULL_YEAR));
      const body = JSON.parse(`{"header":{"timestamp":"t","traceId":"x","isSuccess":true},"data": ${r.recordsJson}}`);
      expect(body.data).to.deep.equal(OAS_FULL_YEAR);
    });
  });

  describe('loadTime formats', () => {
    ['2025-10-05T02:00:00Z', '2025-10-05T02:00:00.1Z', '2025-10-05T02:00:00.123456789Z',
      '2025-10-05T02:00:00+03:00', '2025-10-05T02:00:00.5-05:30'].forEach((lt) => {
      it(`accepts ${lt}`, () => {
        expect(validateIntegrationOutput(wrap([rec({ loadTime: lt })])).valid).to.equal(true);
      });
    });
    [
      ['no timezone', '2025-10-05T02:00:00'],
      ['date only', '2025-10-05'],
      ['space separator', '2025-10-05 02:00:00Z'],
      ['10 fraction digits', '2025-10-05T02:00:00.1234567890Z'],
      ['empty', ''],
      ['lowercase z', '2025-10-05T02:00:00z'],
      ['offset without colon', '2025-10-05T02:00:00+0300'],
      ['number', 1760000000],
      ['null', null]
    ].forEach(([name, lt]) => {
      it(`rejects ${name}`, () => {
        expect(validateIntegrationOutput(wrap([rec({ loadTime: lt })])).valid).to.equal(false);
      });
    });
    it('rejects a missing loadTime', () => {
      const r = rec();
      delete r.loadTime;
      expect(validateIntegrationOutput(wrap([r])).valid).to.equal(false);
    });
  });

  describe('field validation -> invalid', () => {
    const bad = [
      ['quarter 0', { quarter: 0 }],
      ['quarter 5', { quarter: 5 }],
      ['quarter 1.5', { quarter: 1.5 }],
      ['quarter as string', { quarter: '3' }],
      ['quarter null', { quarter: null }],
      ['year 1999', { year: 1999 }],
      ['year 2100', { year: 2100 }],
      ['year as string', { year: '2025' }],
      ['year 2025.5', { year: 2025.5 }],
      ['actual negative', { actual: -1 }],
      ['actual string', { actual: '1512750' }],
      ['actual null', { actual: null }],
      ['actual boolean', { actual: true }]
    ];
    bad.forEach(([name, over]) => {
      it(`rejects ${name}`, () => {
        expect(validateIntegrationOutput(wrap([rec(over)]))).to.deep.equal({ valid: false, records: null, recordsJson: null });
      });
    });
    ['quarter', 'year', 'actual'].forEach((field) => {
      it(`rejects a record missing ${field}`, () => {
        const r = rec();
        delete r[field];
        expect(validateIntegrationOutput(wrap([r])).valid).to.equal(false);
      });
    });
    it('boundary values 1/4 and 2000/2099 are accepted', () => {
      expect(validateIntegrationOutput(wrap([rec({ quarter: 1, year: 2000 }), rec({ quarter: 4, year: 2099 })])).valid).to.equal(true);
    });
    [['null', null], ['a number', 5], ['a string', 'x'], ['an array', [1]], ['true', true]].forEach(([name, item]) => {
      it(`rejects a record that is ${name}`, () => {
        expect(validateIntegrationOutput(wrap([item])).valid).to.equal(false);
      });
    });
    it('one bad record invalidates the whole output', () => {
      expect(validateIntegrationOutput(wrap([rec(), rec({ quarter: 9 }), rec()])).valid).to.equal(false);
    });
  });

  describe('structure -> 502 signal', () => {
    const INVALID = { valid: false, records: null, recordsJson: null };
    const cases = {
      'more than 4 records (5)': wrap([1, 2, 3, 4, 5].map((q) => rec({ quarter: q }))),
      'records missing': JSON.stringify({ outputParameters: { data: {} } }),
      'records null': JSON.stringify({ outputParameters: { data: { records: null } } }),
      'records an object': JSON.stringify({ outputParameters: { data: { records: { quarter: 3 } } } }),
      'records a string': JSON.stringify({ outputParameters: { data: { records: 'x' } } }),
      'records a number': JSON.stringify({ outputParameters: { data: { records: 4 } } }),
      'data missing': JSON.stringify({ outputParameters: {} }),
      'data null': JSON.stringify({ outputParameters: { data: null } }),
      'data an array': JSON.stringify({ outputParameters: { data: [rec()] } }),
      'data a number': JSON.stringify({ outputParameters: { data: 7 } }),
      'data a non-JSON string': JSON.stringify({ outputParameters: { data: 'not json' } }),
      'data a string holding null': JSON.stringify({ outputParameters: { data: 'null' } }),
      'data a string holding an array': JSON.stringify({ outputParameters: { data: '[]' } }),
      'outputParameters null': JSON.stringify({ outputParameters: null }),
      'outputParameters a string': JSON.stringify({ outputParameters: 'x' }),
      'outputParameters null with top-level data (no tolerance)': JSON.stringify({ outputParameters: null, data: { records: [] } }),
      'outputParameters without data, top-level data present': JSON.stringify({ outputParameters: {}, data: { records: [] } }),
      'neither outputParameters nor data': JSON.stringify({ executionId: 'x' }),
      'top-level data without records': JSON.stringify({ data: {} }),
      'empty object': '{}',
      'body is an array': '[]',
      'body is a record array': JSON.stringify([rec()]),
      'body is a string': '"hello"',
      'body is a number': '42',
      'body is JSON null': 'null',
      'body is not JSON': 'not json',
      'body is HTML': '<html><body>502 Bad Gateway</body></html>',
      'body is truncated JSON': '{"outputParameters":{"data":{"records":[',
      'empty string': '',
      'whitespace': '   ',
      'null content (unresolved response.content)': null,
      'undefined content': undefined
    };
    Object.keys(cases).forEach((name) => {
      it(`flags invalid: ${name}`, () => {
        expect(validateIntegrationOutput(cases[name])).to.deep.equal(INVALID);
      });
    });
  });

  describe('as run in Apigee (flag contract)', () => {
    const run = (content) => runInApigee('validateIntegrationOutput.js', { 'response.content': content });

    it('valid: custom.outputValid "true" and kpi.recordsJson set (what AM-BuildKpiResponse inserts)', () => {
      const set = run(wrap(OAS_FULL_YEAR));
      expect(set['custom.outputValid']).to.equal('true');
      expect(set['kpi.recordsJson']).to.equal(JSON.stringify(OAS_FULL_YEAR));
      expect(Object.keys(set).sort()).to.deep.equal(['custom.outputValid', 'kpi.recordsJson']);
    });
    it('empty records: "true" and kpi.recordsJson "[]"', () => {
      const set = run(wrap([]));
      expect(set['custom.outputValid']).to.equal('true');
      expect(set['kpi.recordsJson']).to.equal('[]');
    });
    it('invalid: "false" and no kpi.recordsJson (flow raises RF-BadGateway when != "true")', () => {
      expect(run('not json')).to.deep.equal({ 'custom.outputValid': 'false' });
      expect(run(null)).to.deep.equal({ 'custom.outputValid': 'false' });
      expect(run(wrap([1, 2, 3, 4, 5].map((q) => rec({ quarter: q }))))).to.deep.equal({ 'custom.outputValid': 'false' });
    });
  });
});
