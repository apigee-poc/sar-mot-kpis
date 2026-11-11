/*
 * JS-SetIntegrationParams
 *
 * Converts the validated query parameters into numbers for SIR-SetIntegrationRequest
 * (integration inputs year and quarter are INT; quarter 0 = all quarters, D24).
 * A string flow variable bound to a type="integer" SIR parameter may raise
 * MismatchedTypeAndResolvedRef, so the SIR refs point at kpi.year / kpi.quarter set here.
 * Runs only after RF-InvalidQueryParams, so year is "20NN" and quarter is absent or "1".."4".
 *
 * ES5 only (Apigee Rhino). The pure function is exported for mocha when `module` exists.
 */
/* global context, module */

/*
 * Returns {year: number, quarter: number}, or null when the values are not valid
 * (year 2000-2099; quarter absent/empty -> 0, otherwise 1-4).
 */
function toIntegrationParams(year, quarter) {
  "use strict";
  if (year === null || year === undefined || !/^20\d{2}$/.test(String(year))) {
    return null;
  }
  var quarterNumber = 0;
  if (quarter !== null && quarter !== undefined && String(quarter) !== "") {
    if (!/^[1-4]$/.test(String(quarter))) {
      return null;
    }
    quarterNumber = parseInt(String(quarter), 10);
  }
  return { year: parseInt(String(year), 10), quarter: quarterNumber };
}

if (typeof context !== "undefined") {
  var params = toIntegrationParams(
    context.getVariable("request.queryparam.year"),
    context.getVariable("request.queryparam.quarter")
  );
  if (params !== null) {
    context.setVariable("kpi.year", params.year);
    context.setVariable("kpi.quarter", params.quarter);
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    toIntegrationParams: toIntegrationParams
  };
}
