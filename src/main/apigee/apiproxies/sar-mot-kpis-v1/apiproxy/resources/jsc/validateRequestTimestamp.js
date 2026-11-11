/*
 * JS-ValidateRequestTimestamp
 *
 * Validates the X-Request-Timestamp header (ERROR-CATALOG row 8):
 *   - required;
 *   - ISO-8601 UTC: YYYY-MM-DDTHH:mm:ss[.f{1,3}]Z, with a real calendar date and time;
 *   - within config.maxClockSkewSeconds of the gateway clock (past or future).
 * Sets custom.timestampValid ("true"/"false"); RF-InvalidRequestTimestamp raises ERR-400-TIMESTAMP
 * when it is not true.
 *
 * ES5 only (Apigee Rhino). The pure functions are exported for mocha when `module` exists.
 */
/* global context, module */

var ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
var DEFAULT_MAX_CLOCK_SKEW_SECONDS = 300;

function isLeapYear(year) {
  "use strict";
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  "use strict";
  var days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return days[month - 1];
}

/*
 * Returns the epoch milliseconds of a strict ISO-8601 UTC timestamp, or null if the
 * value is not one.
 */
function parseIsoUtc(value) {
  "use strict";
  if (value === null || value === undefined) {
    return null;
  }
  var match = ISO_UTC_PATTERN.exec(String(value));
  if (!match) {
    return null;
  }
  var year = parseInt(match[1], 10);
  var month = parseInt(match[2], 10);
  var day = parseInt(match[3], 10);
  var hour = parseInt(match[4], 10);
  var minute = parseInt(match[5], 10);
  var second = parseInt(match[6], 10);
  var millis = 0;
  if (match[7] !== undefined && match[7] !== null && match[7] !== "") {
    millis = parseInt((match[7] + "00").substring(0, 3), 10);
  }
  if (month < 1 || month > 12) {
    return null;
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  return Date.UTC(year, month - 1, day, hour, minute, second, millis);
}

/*
 * Returns the allowed clock skew in seconds: the configured value if it is a
 * non-negative integer, otherwise the default.
 */
function resolveMaxSkewSeconds(configured) {
  "use strict";
  if (configured === null || configured === undefined) {
    return DEFAULT_MAX_CLOCK_SKEW_SECONDS;
  }
  var text = String(configured);
  if (!/^\d+$/.test(text)) {
    return DEFAULT_MAX_CLOCK_SKEW_SECONDS;
  }
  return parseInt(text, 10);
}

/*
 * Pure validation: true when `value` is a strict ISO-8601 UTC timestamp no more than
 * `maxSkewSeconds` away from `nowMs`.
 */
function validateRequestTimestamp(value, nowMs, maxSkewSeconds) {
  "use strict";
  var timestampMs = parseIsoUtc(value);
  if (timestampMs === null) {
    return false;
  }
  var maxSkewMs = resolveMaxSkewSeconds(maxSkewSeconds) * 1000;
  return Math.abs(Number(nowMs) - timestampMs) <= maxSkewMs;
}

if (typeof context !== "undefined") {
  var headerValue = context.getVariable("request.header.X-Request-Timestamp");
  var configuredSkew = context.getVariable("config.maxClockSkewSeconds");
  context.setVariable(
    "custom.timestampValid",
    String(validateRequestTimestamp(headerValue, new Date().getTime(), configuredSkew))
  );
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ISO_UTC_PATTERN: ISO_UTC_PATTERN,
    DEFAULT_MAX_CLOCK_SKEW_SECONDS: DEFAULT_MAX_CLOCK_SKEW_SECONDS,
    parseIsoUtc: parseIsoUtc,
    resolveMaxSkewSeconds: resolveMaxSkewSeconds,
    validateRequestTimestamp: validateRequestTimestamp
  };
}
