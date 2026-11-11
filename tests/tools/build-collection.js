#!/usr/bin/env node
// Generates tests/sar-mot-kpis.postman_collection.json (Postman v2.1) for Newman.
//
//   node tests/tools/build-collection.js          write the collection
//   node tests/tools/build-collection.js --check  exit 1 if the committed file is out of date
//
// Deterministic: no timestamps, no random values, no generated ids in the output. Error message
// texts are read from docs/ERROR-CATALOG.md at generation time. The OAS response schemas are
// hand-converted below to draft-04 compatible JSON Schema (Postman's jsonSchema assertion);
// tests/unit/collection.test.js compares them with api/sar-mot-kpis-oas.yaml.
// Credentials are never written: headers reference {{apiKey}}, {{apiSecret}}, {{otherApiKey}},
// {{otherApiSecret}}, which the runner passes as `newman --env-var`.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CATALOG_FILE = path.join(ROOT, 'docs', 'ERROR-CATALOG.md');
const OUTPUT_FILE = path.join(ROOT, 'tests', 'sar-mot-kpis.postman_collection.json');

const COLLECTION_ID = '6f1d7a52-3c8e-4b0a-9d2f-5a7e1c3b9f40';
const KPI_PATH = '/kpis/total_freight';

// Obviously fake values for the "unknown key" / "wrong secret" scenarios (not credentials).
const FAKE_API_KEY = 'unknown-api-key-for-tests';
const FAKE_API_SECRET = 'wrong-api-secret-for-tests';

const FOLDERS = {
  happy: 'Happy paths',
  errors: 'Error rows',
  faults: 'Fault injection (needs scratch config)'
};

// Catalog rows tested by the "Fault injection" folder (FAULT_INJECTION_REQUESTS below). They need
// a scratch config deployed to dev first (scripts/fi-deploy.sh, D39 recipes).
const FAULT_INJECTION_ROWS = [6, 7, 13, 16];

// Catalog rows waived for P6 (D44): they need a scratch integration that cannot be produced from
// the mock data (row 14) or a slow integration (row 15); their logic is covered by unit tests.
const WAIVED_ROWS = {
  14: 'Needs a scratch integration with malformed output (the DB constraints cannot produce it); logic covered by '
    + 'tests/unit/proxy-js-validate-integration-output.test.js and the RF-BadGateway checks in tests/unit/proxy-conditions.test.js (D44).',
  15: 'Needs a scratch slow integration and the IntegrationEndpoint timeout; the 503/504 mapping is covered by the '
    + 'RF-GatewayTimeout and integration-fault checks in tests/unit/proxy-conditions.test.js (D44).'
};

// ---------------------------------------------------------------------------------------------
// OAS schemas (api/sar-mot-kpis-oas.yaml, components.schemas) as draft-04 JSON Schema.
// $refs are inlined; `format`, `example`, `description` are dropped (tv4 does not check `format`,
// so uuid and date-time are asserted with explicit regexes in the test script).
// No additionalProperties: the OAS does not restrict them.
// ---------------------------------------------------------------------------------------------
const RESPONSE_HEADER = {
  type: 'object',
  required: ['timestamp', 'traceId', 'isSuccess'],
  properties: {
    timestamp: { type: 'string' },
    traceId: { type: 'string' },
    isSuccess: { type: 'boolean' }
  }
};

const KPI_RECORD = {
  type: 'object',
  required: ['quarter', 'year', 'actual', 'loadTime'],
  properties: {
    quarter: { type: 'integer', minimum: 1, maximum: 4 },
    year: { type: 'integer', minimum: 2000, maximum: 2099 },
    actual: { type: 'number', minimum: 0 },
    loadTime: { type: 'string' }
  }
};

const KPI_SUCCESS_RESPONSE = {
  type: 'object',
  required: ['header', 'data'],
  properties: {
    header: RESPONSE_HEADER,
    data: { type: 'array', minItems: 0, maxItems: 4, items: KPI_RECORD }
  }
};

const ERROR_DETAIL = {
  type: 'object',
  required: ['code', 'message'],
  properties: {
    code: { type: 'integer' },
    message: { type: 'string' }
  }
};

const ERROR_RESPONSE = {
  type: 'object',
  required: ['header', 'error'],
  properties: {
    header: RESPONSE_HEADER,
    error: ERROR_DETAIL
  }
};

const SCHEMAS = {
  ResponseHeader: RESPONSE_HEADER,
  KpiRecord: KPI_RECORD,
  KpiSuccessResponse: KPI_SUCCESS_RESPONSE,
  ErrorDetail: ERROR_DETAIL,
  ErrorResponse: ERROR_RESPONSE
};

// ---------------------------------------------------------------------------------------------
// Error catalog
// ---------------------------------------------------------------------------------------------
function parseCatalog(text) {
  const rows = {};
  text.split(/\r?\n/).forEach((line) => {
    const m = /^\| (\d+) \| (.*) \| (`[^|]+`) \| \*{0,2}(\d{3})\*{0,2}[^|]* \| (.*) \|$/.exec(line);
    if (m) {
      rows[Number(m[1])] = { row: Number(m[1]), status: Number(m[4]), message: m[5] };
    }
  });
  return rows;
}

function readCatalog() {
  return parseCatalog(fs.readFileSync(CATALOG_FILE, 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------
// `headers` lists only the headers that differ from the default set; `null` omits a header
// entirely (no empty header is sent).
const HAPPY_REQUESTS = [
  {
    name: 'GET total_freight year=2025 (full year, 3 quarters)',
    query: [['year', '2025']],
    data: [
      { quarter: 1, year: 2025, actual: 1420500, loadTime: '2025-04-05T02:00:00Z' },
      { quarter: 2, year: 2025, actual: 1388200, loadTime: '2025-07-05T02:00:00Z' },
      { quarter: 3, year: 2025, actual: 1512750, loadTime: '2025-10-05T02:00:00Z' }
    ]
  },
  {
    name: 'GET total_freight year=2025 quarter=3',
    query: [['year', '2025'], ['quarter', '3']],
    data: [{ quarter: 3, year: 2025, actual: 1512750, loadTime: '2025-10-05T02:00:00Z' }]
  },
  {
    name: 'GET total_freight year=2026 (no data, empty array)',
    query: [['year', '2026']],
    data: []
  },
  {
    name: 'GET total_freight year=2024 (4 quarters)',
    query: [['year', '2024']],
    data: [
      { quarter: 1, year: 2024, actual: 1350000, loadTime: '2024-04-05T02:00:00Z' },
      { quarter: 2, year: 2024, actual: 1395000, loadTime: '2024-07-05T02:00:00Z' },
      { quarter: 3, year: 2024, actual: 1480000, loadTime: '2024-10-05T02:00:00Z' },
      { quarter: 4, year: 2024, actual: 1520000, loadTime: '2025-01-05T02:00:00Z' }
    ]
  }
];

const YEAR_2025 = [['year', '2025']];

const ERROR_REQUESTS = [
  { row: 1, name: 'X-Request-Id malformed ("nope")', query: YEAR_2025, headers: { 'X-Request-Id': 'nope' } },
  { row: 2, name: 'X-API-Key missing', query: YEAR_2025, headers: { 'X-API-Key': null } },
  { row: 3, name: 'X-API-Key unknown', query: YEAR_2025, headers: { 'X-API-Key': FAKE_API_KEY } },
  { row: 4, name: 'X-API-Secret missing', query: YEAR_2025, headers: { 'X-API-Secret': null } },
  { row: 4, name: 'X-API-Secret wrong', query: YEAR_2025, headers: { 'X-API-Secret': FAKE_API_SECRET } },
  {
    row: 5,
    name: 'key of an app whose product does not include /kpis/**',
    query: YEAR_2025,
    headers: { 'X-API-Key': '{{otherApiKey}}', 'X-API-Secret': '{{otherApiSecret}}' }
  },
  { row: 5, name: 'path outside /kpis/ (/other, D32)', path: '/other', query: YEAR_2025 },
  { row: 8, name: 'X-Request-Timestamp missing', query: YEAR_2025, headers: { 'X-Request-Timestamp': null } },
  { row: 8, name: 'X-Request-Timestamp not ISO-8601 ("yesterday")', query: YEAR_2025, headers: { 'X-Request-Timestamp': 'yesterday' } },
  {
    row: 8,
    name: 'X-Request-Timestamp outside clock skew (2020-01-01T00:00:00Z)',
    query: YEAR_2025,
    headers: { 'X-Request-Timestamp': '2020-01-01T00:00:00Z' }
  },
  { row: 9, name: 'X-Operator-Id missing', query: YEAR_2025, headers: { 'X-Operator-Id': null } },
  { row: 9, name: 'X-Operator-Id invalid ("3000124102")', query: YEAR_2025, headers: { 'X-Operator-Id': '3000124102' } },
  { row: 10, name: 'unknown KPI path (/kpis/nope)', path: '/kpis/nope', query: YEAR_2025 },
  { row: 11, name: 'POST total_freight with all valid headers and an empty body', method: 'POST', query: YEAR_2025, allow: 'GET' },
  { row: 12, name: 'year missing', query: [] },
  { row: 12, name: 'year=1999', query: [['year', '1999']] },
  { row: 12, name: 'year=abc', query: [['year', 'abc']] },
  { row: 12, name: 'quarter=5', query: [['year', '2025'], ['quarter', '5']] },
  { row: 12, name: 'quarter=0', query: [['year', '2025'], ['quarter', '0']] },
  { row: 12, name: 'quarter empty (quarter=)', query: [['year', '2025'], ['quarter', '']] }
];

// Fault injection: one subfolder per scenario (run one with `--folder "<name>"`). Every request is
// skipped unless the run sets `--env-var faultScenario=<one of scenarios>`, so a full-collection
// run against a normal deploy never sends them. Request `expect`:
//   'ok'      -> 200 (with `data` if given)
//   'error'   -> the catalog row's status and message
//   'errorOr200' -> the catalog row's error, or 200 (rate-limit windows that may still have room)
// `freshMinute`: wait (pre-request) until a calendar minute has at least 20 s left, so a
// per-minute quota window is not reset between the requests of the scenario.
const FI_FIRST = { quarter: 1, year: 2025, actual: 1420500, loadTime: '2025-04-05T02:00:00Z' };
const FULL_2025 = [
  FI_FIRST,
  { quarter: 2, year: 2025, actual: 1388200, loadTime: '2025-07-05T02:00:00Z' },
  { quarter: 3, year: 2025, actual: 1512750, loadTime: '2025-10-05T02:00:00Z' }
];

const FAULT_INJECTION_REQUESTS = [
  {
    folder: 'FI-06 SpikeArrest 429',
    scenarios: ['fi06'],
    description: 'Catalog row 6 (SpikeArrestViolation -> 429). First deploy the scratch config: '
      + '`bash scripts/fi-deploy.sh fi06` (spikeArrestRate=2pm, sliding window, UseEffectiveCount). '
      + 'Then: `bash tests/run-newman.sh dev --folder "FI-06 SpikeArrest 429" --env-var faultScenario=fi06`. '
      + 'Send nothing else with the test app in the minute before. Restore: `bash scripts/fi-restore.sh`. '
      + 'A must pass (window empty); B-D may still fit the 2-per-minute window (200) or be 429; E must be 429.',
    requests: [
      { row: 6, name: 'A first request, within the rate', expect: 'ok', data: FULL_2025 },
      { row: 6, name: 'B immediate second request', expect: 'errorOr200' },
      { row: 6, name: 'C immediate third request', expect: 'errorOr200' },
      { row: 6, name: 'D immediate fourth request', expect: 'errorOr200' },
      { row: 6, name: 'E immediate fifth request', expect: 'error' }
    ]
  },
  {
    folder: 'FI-07 Quota 429',
    scenarios: ['fi07'],
    description: 'Catalog row 7 (QuotaViolation -> 429). First deploy the scratch config: '
      + '`bash scripts/fi-deploy.sh fi07` (quotaLimit=2 per 1 minute, distributed, synchronous). '
      + 'Then: `bash tests/run-newman.sh dev --folder "FI-07 Quota 429" --env-var faultScenario=fi07`. '
      + 'Request A waits for a calendar minute with at least 20 s left, so A, B and C share one quota window. '
      + 'Send nothing else with the test app in that minute. Restore: `bash scripts/fi-restore.sh`.',
    requests: [
      { row: 7, name: 'A first request in a fresh minute', expect: 'ok', data: FULL_2025, freshMinute: true },
      { row: 7, name: 'B second request', expect: 'ok', data: FULL_2025 },
      { row: 7, name: 'C third request in the same minute', expect: 'error' }
    ]
  },
  {
    folder: 'FI-13 Integration failure 500',
    scenarios: ['fi13'],
    description: 'Catalog row 13 (integration call fails -> 500 ERR-500-INTEGRATION). First deploy the scratch config: '
      + '`bash scripts/fi-deploy.sh fi13` (triggerName=api_trigger/does-not-exist) and start a debug session '
      + '(D39: record whether the IntegrationEndpoint raised a fault and its fault.name, V3/V9). '
      + 'Then: `bash tests/run-newman.sh dev --folder "FI-13 Integration failure 500" --env-var faultScenario=fi13`. '
      + 'The row 13 and row 16 messages are identical, so only the debug session shows which path ran. '
      + 'Restore: `bash scripts/fi-restore.sh`.',
    requests: [
      { row: 13, name: 'unknown integration trigger', expect: 'error' }
    ]
  },
  {
    folder: 'FI-16 Unmapped fault 500',
    scenarios: ['fi16', 'fi16b'],
    description: 'Catalog row 16 (unmapped fault -> 500 ERR-SYS-500). First deploy the scratch config: '
      + '`bash scripts/fi-deploy.sh fi16` (spikeArrestRate=abc; expected fault FailedToResolveSpikeArrestRate, '
      + 'which is not in the error KVM). If this returns 200 (the invalid rate fell back to 30pm), restore and use '
      + '`fi16b` (quotaTimeUnit=fortnight) with `--env-var faultScenario=fi16b`. '
      + 'Then: `bash tests/run-newman.sh dev --folder "FI-16 Unmapped fault 500" --env-var faultScenario=fi16`. '
      + 'Restore: `bash scripts/fi-restore.sh`.',
    requests: [
      { row: 16, name: 'unmapped fault from an invalid rate-limit config', expect: 'error' }
    ]
  }
];

const DEFAULT_HEADERS = [
  ['X-Request-Id', '{{requestId}}'],
  ['X-Request-Timestamp', '{{requestTimestamp}}'],
  ['X-Operator-Id', '{{operatorId}}'],
  ['X-API-Key', '{{apiKey}}'],
  ['X-API-Secret', '{{apiSecret}}'],
  ['Accept', 'application/json']
];

// ---------------------------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------------------------
const COLLECTION_PREREQUEST = [
  '// Fresh correlation id and request timestamp for every request (collection level).',
  'pm.variables.set(\'requestId\', pm.variables.replaceIn(\'{{$guid}}\'));',
  'pm.variables.set(\'requestTimestamp\', new Date().toISOString().replace(/\\.\\d{3}Z$/, \'Z\'));',
  'if (!pm.variables.get(\'operatorId\')) {',
  '  throw new Error(\'Environment variable operatorId is not set\');',
  '}'
];

function collectionTests() {
  const lines = [
    '// Contract checks for every response (collection level). Each request sets `expected`.',
    `const SUCCESS_SCHEMA = ${JSON.stringify(KPI_SUCCESS_RESPONSE)};`,
    `const ERROR_SCHEMA = ${JSON.stringify(ERROR_RESPONSE)};`,
    'const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;',
    'const ISO_UTC_RE = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$/;',
    'const expectedJson = pm.variables.get(\'expected\');',
    'pm.test(\'request declares its expected result\', function () {',
    '  pm.expect(expectedJson, \'pm.variables "expected" not set by the request pre-request script\').to.be.a(\'string\');',
    '});',
    'if (expectedJson) {',
    '  let expected = JSON.parse(expectedJson);',
    '  // A request may allow one alternative outcome (e.g. a rate-limit window that still has room).',
    '  if (expected.or && pm.response.code === expected.or.status) {',
    '    expected = expected.or;',
    '  }',
    '  const status = pm.response.code;',
    '  pm.test(\'status is \' + expected.status, function () {',
    '    pm.response.to.have.status(expected.status);',
    '  });',
    '  pm.test(\'Content-Type is application/json\', function () {',
    '    pm.expect(pm.response.headers.get(\'Content-Type\') || \'\').to.include(\'application/json\');',
    '  });',
    '  let body = null;',
    '  pm.test(\'body is JSON\', function () {',
    '    body = pm.response.json();',
    '  });',
    '  if (body) {',
    '    pm.test(\'body matches the OAS \' + (status < 300 ? \'KpiSuccessResponse\' : \'ErrorResponse\') + \' schema\', function () {',
    '      pm.response.to.have.jsonSchema(status < 300 ? SUCCESS_SCHEMA : ERROR_SCHEMA);',
    '    });',
    '    const header = body.header || {};',
    '    pm.test(\'header.timestamp is ISO-8601 UTC\', function () {',
    '      pm.expect(header.timestamp).to.match(ISO_UTC_RE);',
    '    });',
    '    pm.test(\'header.isSuccess is \' + (status < 300), function () {',
    '      pm.expect(header.isSuccess).to.equal(status < 300);',
    '    });',
    '    const sentId = pm.variables.replaceIn(pm.request.headers.get(\'X-Request-Id\') || \'\');',
    '    if (UUID_RE.test(sentId)) {',
    '      pm.test(\'header.traceId equals the X-Request-Id sent\', function () {',
    '        pm.expect(header.traceId).to.equal(sentId);',
    '      });',
    '      pm.test(\'X-Request-Id response header equals the X-Request-Id sent\', function () {',
    '        pm.expect(pm.response.headers.get(\'X-Request-Id\')).to.equal(sentId);',
    '      });',
    '    } else {',
    '      pm.test(\'header.traceId is a UUID (malformed X-Request-Id sent, D35)\', function () {',
    '        pm.expect(header.traceId).to.match(UUID_RE);',
    '      });',
    '    }',
    '    if (expected.status >= 300) {',
    '      pm.test(\'error.code is the number \' + status, function () {',
    '        pm.expect(typeof (body.error || {}).code).to.equal(\'number\');',
    '        pm.expect(body.error.code).to.equal(status);',
    '      });',
    '      pm.test(\'error.message is the catalog row \' + expected.row + \' text\', function () {',
    '        pm.expect((body.error || {}).message).to.equal(expected.message);',
    '      });',
    '    }',
    '    if (expected.data) {',
    '      pm.test(\'data has \' + expected.data.length + \' item(s) with the expected values\', function () {',
    '        pm.expect(body.data).to.be.an(\'array\');',
    '        pm.expect(body.data.length).to.equal(expected.data.length);',
    '        pm.expect(body.data).to.deep.equal(expected.data);',
    '      });',
    '    }',
    '  }',
    '  if (expected.allow) {',
    '    pm.test(\'Allow header is \' + expected.allow, function () {',
    '      pm.expect(pm.response.headers.get(\'Allow\')).to.equal(expected.allow);',
    '    });',
    '  }',
    '}'
  ];
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------
function buildHeaders(overrides) {
  const over = overrides || {};
  const headers = [];
  DEFAULT_HEADERS.forEach(([key, value]) => {
    if (Object.prototype.hasOwnProperty.call(over, key)) {
      if (over[key] !== null) {
        headers.push({ key, value: over[key], type: 'text' });
      }
    } else {
      headers.push({ key, value, type: 'text' });
    }
  });
  return headers;
}

// A plain string URL: Newman resolves {{baseUrl}} (scheme + host) and {{basePath}} before parsing.
function buildUrl(resourcePath, query) {
  const qs = query.map(([k, v]) => `${k}=${v}`).join('&');
  return `{{baseUrl}}{{basePath}}${resourcePath}${qs ? `?${qs}` : ''}`;
}

function buildItem(name, spec, expected, preLines) {
  const method = spec.method || 'GET';
  const request = {
    method,
    header: buildHeaders(spec.headers),
    url: buildUrl(spec.path || KPI_PATH, spec.query)
  };
  if (method !== 'GET') {
    // Explicit empty body: Content-Length 0 (without it the front end answers 411).
    request.body = { mode: 'raw', raw: '' };
  }
  return {
    name,
    event: [
      {
        listen: 'prerequest',
        script: {
          type: 'text/javascript',
          exec: (preLines || []).concat([`pm.variables.set('expected', JSON.stringify(${JSON.stringify(expected)}));`])
        }
      }
    ],
    request
  };
}

function errorItem(spec, catalog) {
  const entry = catalog[spec.row];
  if (!entry) {
    throw new Error(`Catalog row ${spec.row} not found in ${CATALOG_FILE}`);
  }
  const expected = { row: spec.row, status: entry.status, message: entry.message };
  if (spec.allow) {
    expected.allow = spec.allow;
  }
  return buildItem(`Row ${spec.row}: ${spec.name} -> ${entry.status}`, spec, expected);
}

// Pre-request lines of a fault-injection request: skip unless the run targets this scenario,
// optionally wait for a calendar minute with enough time left (quota window).
function faultPreLines(scenarios, freshMinute) {
  const lines = [
    `if (!${JSON.stringify(scenarios)}.includes(pm.variables.get('faultScenario'))) {`,
    '  // Needs the matching scratch deploy (scripts/fi-deploy.sh) and --env-var faultScenario=<scenario>.',
    '  pm.execution.skipRequest();',
    '}'
  ];
  if (freshMinute) {
    lines.push(
      'const secondsIntoMinute = new Date().getUTCSeconds();',
      'if (pm.variables.get(\'faultScenario\') && secondsIntoMinute > 40) {',
      '  setTimeout(function () {}, (62 - secondsIntoMinute) * 1000);',
      '}'
    );
  }
  return lines;
}

function faultItem(group, spec, catalog) {
  const entry = catalog[spec.row];
  if (!entry) {
    throw new Error(`Catalog row ${spec.row} not found in ${CATALOG_FILE}`);
  }
  const ok = { status: 200 };
  if (spec.data) {
    ok.data = spec.data;
  }
  const error = { row: spec.row, status: entry.status, message: entry.message };
  let expected;
  let suffix;
  if (spec.expect === 'ok') {
    expected = ok;
    suffix = '200';
  } else if (spec.expect === 'error') {
    expected = error;
    suffix = String(entry.status);
  } else if (spec.expect === 'errorOr200') {
    expected = Object.assign({}, error, { or: ok });
    suffix = `${entry.status} or 200`;
  } else {
    throw new Error(`Unknown expect "${spec.expect}" in ${group.folder}`);
  }
  return buildItem(`Row ${spec.row}: ${spec.name} -> ${suffix}`, { query: YEAR_2025 }, expected,
    faultPreLines(group.scenarios, spec.freshMinute));
}

function buildCollection(catalog) {
  const cat = catalog || readCatalog();
  const waivers = Object.keys(WAIVED_ROWS).map((row) => `- Row ${row} (${cat[row].status}) WAIVED: ${WAIVED_ROWS[row]}`);
  return {
    info: {
      _postman_id: COLLECTION_ID,
      name: 'sar-mot-kpis-v1',
      description: [
        'Contract tests for GET /mot-kpis/business-domain/v1/kpis/{kpiCode} (api/sar-mot-kpis-oas.yaml).',
        'Generated by tests/tools/build-collection.js - do not edit by hand. Error texts come from docs/ERROR-CATALOG.md.',
        'Credentials are environment variables injected at run time (tests/run-newman.sh); none are stored here.',
        'Folders (use with newman --folder): "Happy paths" [smoke, read-only], "Error rows" [errors],',
        '"Fault injection (needs scratch config)" [fault-injection, catalog rows 6, 7, 13, 16; subfolders "FI-06 SpikeArrest 429",',
        '"FI-07 Quota 429", "FI-13 Integration failure 500", "FI-16 Unmapped fault 500"; skipped unless --env-var faultScenario is set;',
        'run only against a scratch deploy from scripts/fi-deploy.sh, see tests/fault-injection/README.md].',
        'Waived catalog rows:',
        ...waivers
      ].join('\n'),
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    },
    item: [
      {
        name: FOLDERS.happy,
        description: '[smoke] Read-only happy paths with exact data from the mock data set.',
        item: HAPPY_REQUESTS.map((spec) => buildItem(spec.name, spec, { status: 200, data: spec.data }))
      },
      {
        name: FOLDERS.errors,
        description: '[errors] One request per testable catalog row variant (rows 1, 2, 3, 4, 5, 8, 9, 10, 11, 12). '
          + 'Every other header is valid, so the named check is the first to fail.',
        item: ERROR_REQUESTS.map((spec) => errorItem(spec, cat))
      },
      {
        name: FOLDERS.faults,
        description: `[fault-injection] Catalog rows ${FAULT_INJECTION_ROWS.join(', ')}, one subfolder per scenario. `
          + 'Dev only, one subfolder at a time, after `bash scripts/fi-deploy.sh <scenario>`; restore with '
          + '`bash scripts/fi-restore.sh`. Requests are skipped unless --env-var faultScenario=<scenario> is set. '
          + 'Procedure: tests/fault-injection/README.md.',
        item: FAULT_INJECTION_REQUESTS.map((group) => ({
          name: group.folder,
          description: group.description,
          item: group.requests.map((spec) => faultItem(group, spec, cat))
        }))
      }
    ],
    event: [
      { listen: 'prerequest', script: { type: 'text/javascript', exec: COLLECTION_PREREQUEST } },
      { listen: 'test', script: { type: 'text/javascript', exec: collectionTests() } }
    ]
  };
}

function render(catalog) {
  return `${JSON.stringify(buildCollection(catalog), null, 2)}\n`;
}

module.exports = {
  OUTPUT_FILE,
  FOLDERS,
  SCHEMAS,
  FAULT_INJECTION_ROWS,
  FAULT_INJECTION_REQUESTS,
  WAIVED_ROWS,
  FAKE_API_KEY,
  FAKE_API_SECRET,
  parseCatalog,
  readCatalog,
  buildCollection,
  render
};

if (require.main === module) {
  const out = render();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUTPUT_FILE) ? fs.readFileSync(OUTPUT_FILE, 'utf8').replace(/\r\n/g, '\n') : '';
    if (current !== out) {
      console.error(`${path.relative(ROOT, OUTPUT_FILE)} is out of date: run node tests/tools/build-collection.js`);
      process.exit(1);
    }
    console.log('collection is up to date');
  } else {
    fs.writeFileSync(OUTPUT_FILE, out);
    console.log(`wrote ${path.relative(ROOT, OUTPUT_FILE)}`);
  }
}
