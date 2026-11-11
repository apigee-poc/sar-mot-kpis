/*
 * JS-SetIntegrationParams
 *
 * Normalises the validated query parameters into plain DIGIT STRINGS for
 * SIR-SetIntegrationRequest (integration inputs year and quarter are INT, and the SIR
 * parameters stay type="integer"; quarter "0" = all quarters, D24).
 * Why strings (D35): a JS number set with context.setVariable was rendered as "2,025"
 * (locale grouping) when SIR resolved the ref, and SIR failed with
 * MismatchedTypeAndResolvedRef. A digit string resolves as "2025" and SIR parses it.
 * Runs only after RF-InvalidQueryParams, so year is "20NN" and quarter is absent or "1".."4".
 *
 * ES5 only (Apigee Rhino). The pure function is exported for mocha when `module` exists.
 */
/* global context, module */

/*
 * Returns {year: "20NN", quarter: "0".."4"} (digit strings, no sign, no grouping, no
 * leading zeros), or null when the values are not valid
 * (year 2000-2099; quarter absent/empty -> "0", otherwise "1"-"4").
 */
function toIntegrationParams(year, quarter) {
  "use strict";
  if (year === null || year === undefined || !/^20\d{2}$/.test(String(year))) {
    return null;
  }
  var quarterText = "0";
  if (quarter !== null && quarter !== undefined && String(quarter) !== "") {
    if (!/^[1-4]$/.test(String(quarter))) {
      return null;
    }
    quarterText = String(quarter);
  }
  return { year: String(year), quarter: quarterText };
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
