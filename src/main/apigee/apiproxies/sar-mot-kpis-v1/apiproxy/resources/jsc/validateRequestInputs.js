/*
 * JS-ValidateRequestInputs
 *
 * Presence and format checks of the inbound inputs, done in JavaScript because
 * condition tests on missing headers proved unreliable in dev (D34). Reads with
 * context.getVariable (null when absent) and ALWAYS sets four string flags:
 *   custom.requestIdValid   X-Request-Id: UUID                  (ERROR-CATALOG row 1)
 *   custom.operatorIdValid  X-Operator-Id: ^[12]\d{9}$          (row 9)
 *   custom.yearValid        year: ^20\d{2}$                     (row 12)
 *   custom.quarterValid     quarter: absent, or ^[1-4]$; an empty "quarter=" is invalid (row 12)
 * Each is "true" or "false"; absent, empty or wrong format gives "false". The RF-* steps
 * test these flags in the catalog order. The input values themselves are never copied,
 * logged or returned (the operator ID is a personal identifier).
 *
 * Values are converted with String() before matching (Rhino may hand back Java strings),
 * so a non-string such as the number 2025 is judged by its text form.
 *
 * ES5 only (Apigee Rhino). The pure functions are exported for mocha when `module` exists.
 */
/* global context, module */

var REQUEST_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
var OPERATOR_ID_PATTERN = /^[12]\d{9}$/;
var YEAR_PATTERN = /^20\d{2}$/;
var QUARTER_PATTERN = /^[1-4]$/;
var EMPTY_QUARTER_PATTERN = /(^|&)quarter=(&|$)/;

function isPresent(value) {
  "use strict";
  return value !== null && value !== undefined && String(value) !== "";
}

function matches(value, pattern) {
  "use strict";
  return isPresent(value) && pattern.test(String(value));
}

function isValidRequestId(value) {
  "use strict";
  return matches(value, REQUEST_ID_PATTERN);
}

function isValidOperatorId(value) {
  "use strict";
  return matches(value, OPERATOR_ID_PATTERN);
}

function isValidYear(value) {
  "use strict";
  return matches(value, YEAR_PATTERN);
}

/*
 * quarter is optional. Absent (null/undefined) is valid unless the raw query string
 * contains an empty "quarter=" (some runtimes report an empty parameter as absent).
 */
function isValidQuarter(value, queryString) {
  "use strict";
  if (value === null || value === undefined) {
    if (queryString === null || queryString === undefined) {
      return true;
    }
    return !EMPTY_QUARTER_PATTERN.test(String(queryString));
  }
  return matches(value, QUARTER_PATTERN);
}

/*
 * inputs: {requestId, operatorId, year, quarter, queryString}
 * Returns booleans {requestIdValid, operatorIdValid, yearValid, quarterValid}.
 */
function validateRequestInputs(inputs) {
  "use strict";
  var i = inputs || {};
  return {
    requestIdValid: isValidRequestId(i.requestId),
    operatorIdValid: isValidOperatorId(i.operatorId),
    yearValid: isValidYear(i.year),
    quarterValid: isValidQuarter(i.quarter, i.queryString)
  };
}

if (typeof context !== "undefined") {
  var inputFlags = validateRequestInputs({
    requestId: context.getVariable("request.header.X-Request-Id"),
    operatorId: context.getVariable("request.header.X-Operator-Id"),
    year: context.getVariable("request.queryparam.year"),
    quarter: context.getVariable("request.queryparam.quarter"),
    queryString: context.getVariable("request.querystring")
  });
  context.setVariable("custom.requestIdValid", String(inputFlags.requestIdValid));
  context.setVariable("custom.operatorIdValid", String(inputFlags.operatorIdValid));
  context.setVariable("custom.yearValid", String(inputFlags.yearValid));
  context.setVariable("custom.quarterValid", String(inputFlags.quarterValid));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    isValidRequestId: isValidRequestId,
    isValidOperatorId: isValidOperatorId,
    isValidYear: isValidYear,
    isValidQuarter: isValidQuarter,
    validateRequestInputs: validateRequestInputs
  };
}
