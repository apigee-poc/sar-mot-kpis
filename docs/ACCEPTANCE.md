# Acceptance evidence — SAR MOT KPI POC

This file has one row for each `docs/ERROR-CATALOG.md` case and each happy path. Every row shows
the Postman request that proves it, the expected answer, and the evidence recorded so far per
environment. Nothing here is invented. A result is `PASS` only if a real run is recorded in
`docs/DECISIONS.md` or `docs/PLAN.md`. Newman JUnit reports (`reports/*.xml`) are gitignored, so
the decision entries are the evidence.

## Evidence key

| Status | Meaning |
|---|---|
| `PASS (dev rev 7)` | Part of the full suite run on dev revision 7: **24 requests, 260 assertions, 0 failures**, run before and after the fault-injection runs (PLAN P6 "Result", D46). The 24 requests are the folders `Happy paths` (4) and `Error rows` (20). |
| `PASS (dev FI, revs 8–11)` | Verified on dev against a scratch revision whose config KVM changes exactly one entry (`scripts/fi-deploy.sh`, folders `FI-06`/`FI-07`/`FI-13`/`FI-16`). Dev was then restored to revision 7 with `scripts/fi-restore.sh` (D45, D46). |
| `WAIVED` | Not run against a live environment. The reason is in D44, and the logic is covered by the unit tests named in the row. |
| `PENDING` | Not run yet. It runs on the first `cloudbuild-main.yaml` run (staging: `test-staging`, the full `Happy paths` + `Error rows` suite) or the first `cloudbuild-prod.yaml` run (prod: `smoke-prod`, `Happy paths` only). Both need user action first (P7 triggers, P8 checklist). |
| `N/A (by design)` | This environment never runs the request. Fault injection is dev only: `tests/run-newman.sh` refuses FI folders outside dev (D47). Prod runs only `Happy paths`; error rows never run in prod (D62). |

The 10 requests in `Fault injection (needs scratch config)` are **skipped** in a normal run
(`pm.execution.skipRequest()` unless `--env-var faultScenario=<fiNN>` is set, D45). That is why the
normal suite has 24 requests.

Every executed request also passes the shared contract checks:
- the body validates against the OAS schema embedded in the collection;
- `header.timestamp` is ISO-8601 UTC;
- `header.isSuccess` is correct;
- on errors, `error.code` is a **number** equal to the HTTP status, and the message is the exact
  catalog text;
- `header.traceId` equals the `X-Request-Id` sent. Row 1 is the exception: there it is a fresh
  UUID (D35).

The P5 hand-run matrix on dev revisions 5 and 6 (D39, D40) covered the 4 happy paths and rows 1
(malformed), 2–5 and 8–12 before the Newman suite existed.

## Happy paths (folder `Happy paths`)

| Case | Collection request | Expected | Dev | Staging | Prod |
|---|---|---|---|---|---|
| H1 full year 2025 | `GET total_freight year=2025 (full year, 3 quarters)` | 200; `data` = Q1–Q3 2025, exactly the OAS example values | PASS (dev rev 7) | PENDING | PENDING (smoke) |
| H2 quarter 3 | `GET total_freight year=2025 quarter=3` | 200; one record, `actual` 1512750 | PASS (dev rev 7) | PENDING | PENDING (smoke) |
| H3 no data | `GET total_freight year=2026 (no data, empty array)` | 200; `data: []` (an empty result is not an error) | PASS (dev rev 7) | PENDING | PENDING (smoke) |
| H4 full year 2024 | `GET total_freight year=2024 (4 quarters)` | 200; four records | PASS (dev rev 7) | PENDING | PENDING (smoke) |

The prod smoke asserts the same exact mock values, so it needs `kpis_prod` seeded like dev
(D62, DEPLOYMENT.md "First-run VERIFY list" item 12).

## Error catalog rows (folder `Error rows`, plus fault injection)

Messages are copied verbatim from `docs/ERROR-CATALOG.md`.

| # | Scenario | Collection request(s) | HTTP | Message | Dev | Staging | Prod |
|---|---|---|---|---|---|---|---|
| 1 | `X-Request-Id` not a UUID | `Row 1: X-Request-Id malformed ("nope") -> 400` | 400 | Header 'X-Request-Id' is required and must be a valid UUID. | PASS (dev rev 7). **Not testable:** a *missing* header, because the platform adds a UUID before the proxy runs (D35). **Not asserted:** the response `X-Request-Id` echoes `nope` (D35, D47(6)). | PENDING | N/A (by design) |
| 2 | `X-API-Key` missing | `Row 2: X-API-Key missing -> 401` | 401 | Invalid or missing credentials in 'X-API-Key' or 'X-API-Secret' headers. | PASS (dev rev 7) | PENDING | N/A (by design) |
| 3 | `X-API-Key` unknown / revoked / app not approved / owner inactive | `Row 3: X-API-Key unknown -> 401` | 401 | Invalid or missing credentials in 'X-API-Key' or 'X-API-Secret' headers. | PASS (dev rev 7) for an **unknown** key only. Revoked key, unapproved app and inactive developer/company are **not tested**. They map by fault name (`ApiKeyNotApproved`, `DeveloperStatusNotActive`, `invalid_client-app_not_approved`, `CompanyStatusNotActive` → FaultRule `inactive-owner`, D41), and that mapping is checked only by static tests. | PENDING | N/A (by design) |
| 4 | `X-API-Secret` missing or wrong | `Row 4: X-API-Secret missing -> 401`; `Row 4: X-API-Secret wrong -> 401` | 401 | Invalid or missing credentials in 'X-API-Key' or 'X-API-Secret' headers. | PASS (dev rev 7) | PENDING | N/A (by design) |
| 5 | Valid key, product does not include the resource | `Row 5: key of an app whose product does not include /kpis/** -> 403`; `Row 5: path outside /kpis/ (/other, D32) -> 403` | 403 | API Key is not associated with an approved API Product for KPI data sharing. | PASS (dev rev 7). A key with **no product at all** (`consumer_key_missing_api_product_association`, D41) is **not tested**. | PENDING | N/A (by design) |
| 6 | SpikeArrest exceeded | `FI-06 SpikeArrest 429`: `Row 6: A first request, within the rate -> 200` … `Row 6: E immediate fifth request -> 429` (5 requests) | 429 | Rate limit has been exceeded. | PASS (dev FI, revs 8–11): fi06 `spikeArrestRate=2pm` gave 200, 200, 429, 429, 429 (D46) | N/A (by design, FI is dev only) | N/A (by design) |
| 7 | Quota exceeded | `FI-07 Quota 429`: `Row 7: A first request in a fresh minute -> 200`, `Row 7: B second request -> 200`, `Row 7: C third request in the same minute -> 429` | 429 | Rate limit has been exceeded. | PASS (dev FI, revs 8–11): fi07 `quotaLimit=2` gave 200, 200, 429 (D46) | N/A (by design, FI is dev only) | N/A (by design) |
| 8 | `X-Request-Timestamp` missing / not ISO-8601 UTC / outside clock skew | `Row 8: X-Request-Timestamp missing -> 400`; `Row 8: X-Request-Timestamp not ISO-8601 ("yesterday") -> 400`; `Row 8: X-Request-Timestamp outside clock skew (2020-01-01T00:00:00Z) -> 400` | 400 | Header 'X-Request-Timestamp' is required and must be a UTC ISO-8601 date-time within the allowed clock skew. | PASS (dev rev 7). Every validator branch is also unit-tested (`tests/unit/proxy-js-validate-request-timestamp.test.js`; 1–3 fractional digits only, D42). | PENDING | N/A (by design) |
| 9 | `X-Operator-Id` missing or not `^[12]\d{9}$` | `Row 9: X-Operator-Id missing -> 400`; `Row 9: X-Operator-Id invalid ("3000124102") -> 400` | 400 | Header 'X-Operator-Id' is required and must be a valid 10-digit National ID or Iqama number. | PASS (dev rev 7) | PENDING | N/A (by design) |
| 10 | Unknown path | `Row 10: unknown KPI path (/kpis/nope) -> 404` | 404 | Requested resource was not found. Please verify the API path. | PASS (dev rev 7). A path outside `/kpis/**` gives 403 (row 5), by design (D32). | PENDING | N/A (by design) |
| 11 | Known path, verb ≠ GET | `Row 11: POST total_freight with all valid headers and an empty body -> 405` | 405 | HTTP method not allowed. Only 'GET' operations are supported on this endpoint. | PASS (dev rev 7), including `Allow: GET` | PENDING | N/A (by design) |
| 12 | `year` missing / not 2000–2099, or `quarter` present and not 1–4 | `Row 12: year missing -> 400`; `Row 12: year=1999 -> 400`; `Row 12: year=abc -> 400`; `Row 12: quarter=5 -> 400`; `Row 12: quarter=0 -> 400`; `Row 12: quarter empty (quarter=) -> 400` | 400 | Query parameter 'quarter' must be an integer between 1 and 4, and 'year' must be a valid 4-digit Gregorian year (2000-2099). | PASS (dev rev 7) | PENDING | N/A (by design) |
| 13 | Integration returned non-2xx / execution failed | `FI-13 Integration failure 500`: `Row 13: unknown integration trigger -> 500` | 500 | An unexpected error occurred. Quote the traceId when contacting support. | PASS (dev FI, revs 8–11): fi13 `triggerName=api_trigger/does-not-exist` gave 500. The debug trace shows an Apigee fault `BadGateway` ("Received non success response code") in the target response flow, which closes V3/V9 (D46). | N/A (by design, FI is dev only) | N/A (by design) |
| 14 | Integration output missing, not an array, or more than 4 items | none (no collection request) | 502 | Invalid or malformed response received from backend service. | **WAIVED** (D44): the DB constraints cannot produce bad output, so a live test needs a scratch integration. Covered by `tests/unit/proxy-js-validate-integration-output.test.js` and the `RF-BadGateway` / `custom.statusOverride` checks in `tests/unit/proxy-conditions.test.js`. | WAIVED | WAIVED |
| 15 | Target timeout / service unavailable | none (no collection request) | 504 | The request timed out. The service is temporarily unavailable. | **WAIVED** (D44): a live test needs a scratch slow integration and the IntegrationEndpoint timeout. The 503/504 mapping (`RF-GatewayTimeout`, `integration-fault` FaultRule, D41) is covered by `tests/unit/proxy-conditions.test.js`. | WAIVED | WAIVED |
| 16 | Anything else (unmapped fault) | `FI-16 Unmapped fault 500`: `Row 16: unmapped fault from an invalid rate-limit config -> 500` | 500 | An unexpected error occurred. Quote the traceId when contacting support. | PASS (dev FI, revs 8–11): fi16 `spikeArrestRate=abc` gave 500 (D46). The fault name was **not captured** (no debug session); `FailedToResolveSpikeArrestRate` is only the documented candidate (D45 update). Rows 13 and 16 share the client message, so the client cannot see the lookup key. | N/A (by design, FI is dev only) | N/A (by design) |

## Pipeline acceptance (not catalog rows)

| Check | Source | Status |
|---|---|---|
| A merge to `main` reaches staging green | PLAN P7 acceptance | PENDING: needs the git remote, the Cloud Build connection and the triggers (D53, DEPLOYMENT.md "CI/CD triggers (not created yet)") |
| A commit that breaks a test rolls dev back, and staging is untouched | PLAN P7 acceptance | PENDING: same prerequisites; demo steps in `docs/DEMO.md` |
| A prod run promotes byte for byte what passed staging, and the smoke passes | PLAN P8 acceptance | PENDING: user checklist in DEPLOYMENT.md "Prod (P8)" → "What YOU must run/approve" |
| Integration test cases (2025 full year, 2025 Q3, 2026 empty, 2024 full year) pass | PLAN P4 | PASS on dev and staging (D30, D31). Prod: PENDING (`apply-int-prod` runs them) |
| `npm run lint` 0/0 and unit tests green | AGENTS.md rule 7 | P9 local run (2026-11-12, Windows workstation): lint 0 errors / 0 warnings; unit tests 791 passing, **1 failing**, both with and without `REQUIRE_BASH_TESTS=1`. The failing test is `prod.env defines every nonprod.env key, targets prod and holds no secret`. Cause: the Windows working copy of `infra/env/prod.env` has CRLF line endings (`core.autocrlf=true`; `.gitattributes` pins only `*.sh` to LF). The committed file is LF and parses 23 keys; the working copy parses 0. It also failed on the baseline run before any P9 edit, and P9 changes no `infra/` or `tests/` file. CI (Linux checkout): PENDING (first PR/main build) |

## How to update this file

After a run, replace `PENDING` with the result. Name the environment, the proxy revision, the
build id (or the date for a local run) and the request/assertion counts, and add the run to
`docs/DECISIONS.md`. Do not mark a row `PASS` from a run that did not execute it. A Newman run
that reports **0 executed requests** for an FI folder did not run the scenario
(`tests/fault-injection/README.md`).
