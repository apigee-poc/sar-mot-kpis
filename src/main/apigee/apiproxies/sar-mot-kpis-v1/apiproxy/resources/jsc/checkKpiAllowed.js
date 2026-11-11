/*
 * JS-CheckKpiAllowed
 *
 * The config KVM key allowedKpis is a comma-separated list of the kpiCodes this
 * environment may serve (e.g. "total_freight"). Sets custom.kpiAllowed (boolean);
 * the flow raises ERR-404-RESOURCE (RF-ResourceNotFound) when it is not true.
 * Matching is exact and case-sensitive; blanks around entries are ignored.
 *
 * ES5 only (Apigee Rhino). The pure function is exported for mocha when `module` exists.
 */
/* global context, module */

function isKpiAllowed(kpiCode, allowedKpis) {
  "use strict";
  if (kpiCode === null || kpiCode === undefined || allowedKpis === null || allowedKpis === undefined) {
    return false;
  }
  var code = String(kpiCode);
  if (code === "") {
    return false;
  }
  var entries = String(allowedKpis).split(",");
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].replace(/^\s+|\s+$/g, "") === code) {
      return true;
    }
  }
  return false;
}

if (typeof context !== "undefined") {
  context.setVariable(
    "custom.kpiAllowed",
    isKpiAllowed(context.getVariable("kpi.code"), context.getVariable("config.allowedKpis"))
  );
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    isKpiAllowed: isKpiAllowed
  };
}
