const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { expect } = require('chai');

const ROOT = path.join(__dirname, '..', '..', 'integration');
const ENVS = ['dev', 'staging'];

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function srcFile(env) {
  return `${env}/src/sar-kpi-get-${env}.json`;
}

function task(integration, taskId) {
  return integration.taskConfigs.find((t) => t.taskId === taskId);
}

// Runs an embedded JavaScriptTask script against a mock event.
function runScript(script, params) {
  const out = {};
  const event = {
    getParameter: (k) => params[k],
    setParameter: (k, v) => { out[k] = v; },
    log: () => {}
  };
  const ctx = vm.createContext({});
  vm.runInContext(`${script}\nthis.executeScript = executeScript;`, ctx);
  ctx.executeScript(event);
  // Round-trip through JSON so values created in the vm context compare with deep.equal.
  return JSON.parse(JSON.stringify(out));
}

const integration = readJson(srcFile('dev'));
const buildScript = task(integration, '1').parameters.script.value.stringValue;
const transformScript = task(integration, '3').parameters.script.value.stringValue;

describe('integration sar-kpi-get: structure', () => {
  it('dev and staging src files are byte-identical (env differences live in overrides only)', () => {
    const dev = fs.readFileSync(path.join(ROOT, srcFile('dev')));
    const staging = fs.readFileSync(path.join(ROOT, srcFile('staging')));
    expect(dev.equals(staging)).to.equal(true);
  });

  it('each env src folder has exactly one integration JSON (apply uses the first file)', () => {
    ENVS.forEach((env) => {
      const files = fs.readdirSync(path.join(ROOT, env, 'src')).filter((f) => f.endsWith('.json'));
      expect(files).to.deep.equal([`sar-kpi-get-${env}.json`]);
    });
  });

  it('task numbering agrees: connector is task 2 in src, JS and overrides', () => {
    expect(task(integration, '2').task).to.equal('GenericConnectorTask');
    expect(task(integration, '2').parameters.connectorOutputPayload.value.stringValue)
      .to.equal('$`Task_2_connectorOutputPayload`$');
    expect(transformScript).to.contain('"`Task_2_connectorOutputPayload`"');
    expect(buildScript).to.contain('"`Task_2_connectorInputPayload`"');
    ENVS.forEach((env) => {
      const o = readJson(`${env}/overrides/overrides.json`);
      expect(o.connection_overrides).to.deep.equal([{
        taskId: '2',
        task: 'GenericConnectorTask',
        parameters: { connectionName: `sar-kpi-db-${env}`, connectionLocation: 'us-central1' }
      }]);
      expect(o.trigger_overrides[0].apiPath).to.equal(`sar-kpi-get-${env}`);
    });
  });

  it('every test case has a matching test-config and targets its env trigger', () => {
    ENVS.forEach((env) => {
      const tests = fs.readdirSync(path.join(ROOT, env, 'tests')).sort();
      const configs = fs.readdirSync(path.join(ROOT, env, 'test-configs')).sort();
      expect(tests).to.have.length(4);
      expect(configs).to.deep.equal(tests);
      tests.forEach((f) => {
        const tc = readJson(`${env}/tests/${f}`);
        expect(tc.displayName).to.equal(path.basename(f, '.json'));
        expect(tc.triggerId).to.equal(`api_trigger/sar-kpi-get-${env}`);
      });
    });
  });
});

describe('integration sar-kpi-get: JS-BuildConnectorInput (task 1)', () => {
  it('maps quarter 0 to NULL for both quarter placeholders', () => {
    const out = runScript(buildScript, { kpiCode: 'total_freight', year: 2025, quarter: 0 });
    const p = out['`Task_2_connectorInputPayload`'];
    expect(p.query).to.equal(
      'SELECT quarter, year, actual, load_time\nFROM kpi_records\nWHERE kpi_code = ?\n' +
      '  AND year = ?\n  AND (CAST(? AS SMALLINT) IS NULL OR quarter = ?)\nORDER BY quarter'
    );
    expect(p.queryParameters).to.deep.equal([
      { value: 'total_freight', dataType: 'VARCHAR' },
      { value: 2025, dataType: 'INTEGER' },
      { value: null, dataType: 'INTEGER' },
      { value: null, dataType: 'INTEGER' }
    ]);
  });

  it('passes a real quarter through twice', () => {
    const out = runScript(buildScript, { kpiCode: 'total_freight', year: 2025, quarter: 3 });
    const qp = out['`Task_2_connectorInputPayload`'].queryParameters;
    expect(qp[2].value).to.equal(3);
    expect(qp[3].value).to.equal(3);
  });

  it('treats a missing quarter as NULL', () => {
    const out = runScript(buildScript, { kpiCode: 'total_freight', year: 2025 });
    expect(out['`Task_2_connectorInputPayload`'].queryParameters[2].value).to.equal(null);
  });
});

describe('integration sar-kpi-get: JS-TransformOutput (task 3)', () => {
  const key = '`Task_2_connectorOutputPayload`';

  it('maps rows to KpiRecord with numeric actual and ISO-8601 UTC loadTime', () => {
    const rows = [
      { quarter: 1, year: 2025, actual: '1420500.0000', load_time: '2025-04-05 02:00:00.0' },
      { quarter: 2.0, year: 2025.0, actual: 1388200.0, load_time: '2025-07-05T02:00:00Z' },
      { quarter: 3, year: 2025, actual: 1512750, load_time: '2025-10-05 05:00:00+03' }
    ];
    const out = runScript(transformScript, { [key]: rows });
    expect(out.data).to.deep.equal([
      { quarter: 1, year: 2025, actual: 1420500, loadTime: '2025-04-05T02:00:00Z' },
      { quarter: 2, year: 2025, actual: 1388200, loadTime: '2025-07-05T02:00:00Z' },
      { quarter: 3, year: 2025, actual: 1512750, loadTime: '2025-10-05T02:00:00Z' }
    ]);
  });

  it('accepts the payload as a JSON string', () => {
    const rows = JSON.stringify([{ quarter: 3, year: 2025, actual: 1512750, load_time: '2025-10-05T02:00:00.000+00:00' }]);
    const out = runScript(transformScript, { [key]: rows });
    expect(out.data).to.deep.equal([{ quarter: 3, year: 2025, actual: 1512750, loadTime: '2025-10-05T02:00:00Z' }]);
  });

  it('returns [] (never null) when there are no rows', () => {
    [[], null, undefined, '', '[]'].forEach((empty) => {
      expect(runScript(transformScript, { [key]: empty }).data).to.deep.equal([]);
    });
  });

  it('fails the task on an unparseable load_time', () => {
    expect(() => runScript(transformScript, { [key]: [{ quarter: 1, year: 2025, actual: 1, load_time: 'bad' }] }))
      .to.throw(/Invalid load_time/);
  });

  it('fails the task when the payload is not an array', () => {
    expect(() => runScript(transformScript, { [key]: { error: 'x' } })).to.throw(/not an array/);
  });

  it('produces exactly the data asserted by each test case from the seed rows', () => {
    // Seed rows from db/seed/total_freight.sql, shaped like connector output.
    const seed = [
      [2024, 1, 1350000, '2024-04-05T02:00:00Z'], [2024, 2, 1395000, '2024-07-05T02:00:00Z'],
      [2024, 3, 1480000, '2024-10-05T02:00:00Z'], [2024, 4, 1520000, '2025-01-05T02:00:00Z'],
      [2025, 1, 1420500, '2025-04-05T02:00:00Z'], [2025, 2, 1388200, '2025-07-05T02:00:00Z'],
      [2025, 3, 1512750, '2025-10-05T02:00:00Z']
    ].map(([year, quarter, actual, lt]) => ({ quarter, year, actual: actual.toFixed(4), load_time: lt }));
    ENVS.forEach((env) => {
      fs.readdirSync(path.join(ROOT, env, 'tests')).forEach((f) => {
        const tc = readJson(`${env}/tests/${f}`);
        const input = readJson(`${env}/test-configs/${f}`).inputParameters;
        const year = Number(input.year.intValue);
        const quarter = Number(input.quarter.intValue);
        const rows = seed.filter((r) => r.year === year && (quarter === 0 || r.quarter === quarter));
        const expected = tc.testTaskConfigs.find((t) => t.taskNumber === '3')
          .assertions.find((a) => a.assertionStrategy === 'ASSERT_EQUALS').parameter.value.jsonValue;
        expect(JSON.stringify(runScript(transformScript, { [key]: rows }).data)).to.equal(expected);
      });
    });
  });
});
