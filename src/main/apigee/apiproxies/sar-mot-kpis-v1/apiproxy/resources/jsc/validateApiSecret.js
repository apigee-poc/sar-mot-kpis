/*
 * JS-ValidateApiSecret
 *
 * Compares the X-API-Secret header with the client secret of the app that
 * VA-VerifyApiKey resolved (D8, ERROR-CATALOG row 4). Missing or empty on either
 * side is invalid. The comparison takes the same time wherever the first difference
 * is (constant-time over the longer length). Sets custom.secretValid ("true"/"false");
 * RF-InvalidSecret raises ERR-401-SECRET when it is not "true".
 * The secret is never written to any other flow variable and never logged.
 *
 * ES5 only (Apigee Rhino). The pure function is exported for mocha when `module` exists.
 */
/* global context, module */

function secretsMatch(provided, expected) {
  "use strict";
  if (provided === null || provided === undefined || expected === null || expected === undefined) {
    return false;
  }
  var a = String(provided);
  var b = String(expected);
  if (a.length === 0 || b.length === 0) {
    return false;
  }
  var length = Math.max(a.length, b.length);
  var diff = a.length ^ b.length;
  for (var i = 0; i < length; i++) {
    var ca = i < a.length ? a.charCodeAt(i) : 0;
    var cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

if (typeof context !== "undefined") {
  context.setVariable(
    "custom.secretValid",
    String(secretsMatch(
      context.getVariable("request.header.X-API-Secret"),
      context.getVariable("verifyapikey.VA-VerifyApiKey.client_secret")
    ))
  );
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    secretsMatch: secretsMatch
  };
}
