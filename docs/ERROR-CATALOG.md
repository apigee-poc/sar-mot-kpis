# Error catalog

Every error response uses the OAS `ErrorResponse` envelope:

```json
{
  "header": { "timestamp": "2026-10-14T08:30:01Z", "traceId": "<X-Request-Id or messageid>", "isSuccess": false },
  "error":  { "code": 400, "message": "<from KVM>" }
}
```

`error.code` is the **integer** HTTP status (unquoted in the AssignMessage template).
The `X-Request-Id` response header is always set to the same value as `header.traceId`.
The lookup key (column 3) is internal: it selects the message from the
`sar-mot-kpis-errors-<SHA>` KVM and is written to logs, never to the client.

## Evaluation order in the proxy

1. Set timestamp + default trace ID (`messageid`); load config KVM.
2. Validate `X-Request-Id` (required, UUID). If valid, it becomes the trace ID.
3. Verify API key → verify secret → SpikeArrest → Quota.
4. Validate `X-Request-Timestamp` and `X-Operator-Id`.
5. Route: unknown path → 404; known path with non-GET verb → 405.
6. Validate `year` / `quarter`.
7. Call integration; validate its output.

The first failing check wins.

## Catalog

| # | Scenario | Lookup key | HTTP | Message (KVM value) |
|---|---|---|---|---|
| 1 | `X-Request-Id` missing or not a UUID | `ERR-400-REQUESTID` | 400 | Header 'X-Request-Id' is required and must be a valid UUID. |
| 2 | `X-API-Key` missing | `FailedToResolveAPIKey` | 401 | Invalid or missing credentials in 'X-API-Key' or 'X-API-Secret' headers. |
| 3 | `X-API-Key` unknown / revoked / app not approved | `InvalidApiKey`, `ApiKeyNotApproved`, `DeveloperStatusNotActive`, `invalid_client-app_not_approved` | 401 | Invalid or missing credentials in 'X-API-Key' or 'X-API-Secret' headers. |
| 4 | `X-API-Secret` missing or does not match the app | `ERR-401-SECRET` | 401 | Invalid or missing credentials in 'X-API-Key' or 'X-API-Secret' headers. |
| 5 | Valid key, product does not include this resource | `InvalidApiKeyForGivenResource` | **403** (override) | API Key is not associated with an approved API Product for KPI data sharing. |
| 6 | SpikeArrest exceeded | `SpikeArrestViolation` | 429 | Rate limit has been exceeded. |
| 7 | Quota exceeded | `QuotaViolation` | 429 | Rate limit has been exceeded. |
| 8 | `X-Request-Timestamp` missing, not ISO-8601 UTC, or outside allowed clock skew | `ERR-400-TIMESTAMP` | 400 | Header 'X-Request-Timestamp' is required and must be a UTC ISO-8601 date-time within the allowed clock skew. |
| 9 | `X-Operator-Id` missing or not `^[12]\d{9}$` | `ERR-400-OPERATOR` | 400 | Header 'X-Operator-Id' is required and must be a valid 10-digit National ID or Iqama number. |
| 10 | Unknown path | `ERR-404-RESOURCE` | 404 | Requested resource was not found. Please verify the API path. |
| 11 | Known path, verb ≠ GET | `ERR-405-METHOD` | 405 | HTTP method not allowed. Only 'GET' operations are supported on this endpoint. |
| 12 | `year` missing / not 2000–2099, or `quarter` present and not 1–4 | `ERR-400-PARAMS` | 400 | Query parameter 'quarter' must be an integer between 1 and 4, and 'year' must be a valid 4-digit Gregorian year (2000-2099). |
| 13 | Integration returned non-2xx / execution failed | `ERR-500-INTEGRATION` | 500 | An unexpected error occurred. Quote the traceId when contacting support. |
| 14 | Integration output missing, not an array, or more than 4 items | `ERR-502-GATEWAY` | 502 | Invalid or malformed response received from backend service. |
| 15 | Target timeout / service unavailable | `ERR-504-TIMEOUT` | 504 | The request timed out. The service is temporarily unavailable. |
| 16 | Anything else (unmapped fault) | `ERR-SYS-500` | 500 | An unexpected error occurred. Quote the traceId when contacting support. |

Notes:

- Messages for rows 2–7 and 10–16 are the exact texts from the OAS examples. Do not
  paraphrase them.
- Row 5: Apigee's default status for this fault is not 403. Add a FaultRule
  (`fault.name = "InvalidApiKeyForGivenResource"`) that sets `custom.statusOverride = 403`.
  `AM-BuildErrorResponse` must take `firstnonnull(custom.statusOverride, error.status.code, '500')`.
  VERIFY the default status codes of rows 2, 3, 6 and 7 in a real environment, and add
  overrides where they differ from this table.
- Rows 2–4 share one message on purpose. Never tell a caller which of key or secret was wrong.
- An empty result is **not** an error: return 200 with `"data": []`.
