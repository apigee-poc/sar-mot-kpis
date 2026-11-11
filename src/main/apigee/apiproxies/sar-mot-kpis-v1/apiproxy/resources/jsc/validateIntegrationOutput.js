/*
 * JS-ValidateIntegrationOutput
 *
 * The IntegrationEndpoint response is the integrations.execute JSON:
 *   {"executionId": "...", "outputParameters": {"data": {"records": [KpiRecord, ...]}}}
 * (D26, D30). A body without outputParameters but with a top-level "data" is also
 * accepted (tolerance, the IntegrationEndpoint shape is not documented). This script:
 *   - parses response.content (and data too, if it arrives as a string);
 *   - checks that records is an array of at most 4 KpiRecords (ERROR-CATALOG row 14);
 *   - rebuilds each record with exactly the OAS fields, in OAS order;
 *   - sets custom.outputValid ("true"/"false") and kpi.recordsJson (JSON array text) for
 *     AM-BuildKpiResponse. RF-BadGateway raises ERR-502-GATEWAY when the output is not valid.
 *
 * ES5 only (Apigee Rhino). The pure function is exported for mocha when `module` exists.
 */
/* global context, module */

var MAX_RECORDS = 4;
var LOAD_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isArray(value) {
  "use strict";
  return Object.prototype.toString.call(value) === "[object Array]";
}

function isInteger(value) {
  "use strict";
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value;
}

function toRecord(item) {
  "use strict";
  if (item === null || typeof item !== "object" || isArray(item)) {
    return null;
  }
  if (!isInteger(item.quarter) || item.quarter < 1 || item.quarter > 4) {
    return null;
  }
  if (!isInteger(item.year) || item.year < 2000 || item.year > 2099) {
    return null;
  }
  if (typeof item.actual !== "number" || !isFinite(item.actual) || item.actual < 0) {
    return null;
  }
  if (typeof item.loadTime !== "string" || !LOAD_TIME_PATTERN.test(item.loadTime)) {
    return null;
  }
  return {
    quarter: item.quarter,
    year: item.year,
    actual: item.actual,
    loadTime: item.loadTime
  };
}

/*
 * Pure validation. `content` is the integration response body (string).
 * Returns {valid: boolean, records: Array|null, recordsJson: string|null}.
 */
function validateIntegrationOutput(content) {
  "use strict";
  var invalid = { valid: false, records: null, recordsJson: null };
  var body;
  var data;
  try {
    body = JSON.parse(String(content));
  } catch (e) {
    return invalid;
  }
  if (body === null || typeof body !== "object" || isArray(body)) {
    return invalid;
  }
  if (body.outputParameters !== null && typeof body.outputParameters === "object") {
    data = body.outputParameters.data;
  } else if (body.outputParameters === undefined) {
    // Tolerance (V2): a body without the execute wrapper, {"data": {"records": [...]}}.
    data = body.data;
  } else {
    return invalid;
  }
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch (e2) {
      return invalid;
    }
  }
  if (data === null || data === undefined || typeof data !== "object" || !isArray(data.records)) {
    return invalid;
  }
  if (data.records.length > MAX_RECORDS) {
    return invalid;
  }
  var records = [];
  for (var i = 0; i < data.records.length; i++) {
    var record = toRecord(data.records[i]);
    if (record === null) {
      return invalid;
    }
    records.push(record);
  }
  return { valid: true, records: records, recordsJson: JSON.stringify(records) };
}

if (typeof context !== "undefined") {
  var result = validateIntegrationOutput(context.getVariable("response.content"));
  context.setVariable("custom.outputValid", String(result.valid));
  if (result.valid) {
    context.setVariable("kpi.recordsJson", result.recordsJson);
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MAX_RECORDS: MAX_RECORDS,
    validateIntegrationOutput: validateIntegrationOutput
  };
}
