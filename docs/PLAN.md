# Implementation plan — SAR MOT KPI POC

Status values: `TODO` · `IN PROGRESS` · `IN REVIEW (scope)` · `BLOCKED (reason)` · `DONE (commit sha)`.
Agents update the status line of a phase when they start or finish it.
**👤 = human action required** (Console, approvals, or decisions an agent must not take).

| Phase | Title | Status |
|---|---|---|
| P0 | Repo bootstrap | DONE (505f7b7) |
| P1 | Non-prod foundation (APIs, service accounts, IAM) | DONE (cbf1347) |
| P2 | Private Cloud SQL + mock data | DONE (b5813cf) |
| P3 | Integration Connector (private) | DONE (8987442) |
| P4 | Application Integration | DONE (3400476) |
| P5 | Apigee proxy | DONE (80ad235) |
| P6 | Tests (unit, Newman, integration tests) | DONE (6919831) |
| P7 | CI/CD pipelines (PR + non-prod) | DONE (9dfd5fc) for files, scripts and static tests; live acceptance PENDING user action: git remote, Cloud Build GitHub connection and triggers (D53, DEPLOYMENT.md) |
| P8 | Prod foundation + prod pipeline | IN REVIEW (files; prod run pending): pipelines, scripts, static tests and runbook on branch `p8-prod`; the live prod run is PENDING user action (D59–D66, DEPLOYMENT.md "Prod (P8)") |
| P9 | Documentation + acceptance demo | TODO |

---

## Target repository layout

```
sar-mot-kpis/
├── AGENTS.md  CLAUDE.md  .claude/settings.json  .agent/rules/
├── api/sar-mot-kpis-oas.yaml                  # contract (v1.0.1, includes 404/502)
├── docs/  PLAN.md ERROR-CATALOG.md DECISIONS.md PROMPTS.md DEPLOYMENT.md
├── infra/
│   ├── env/nonprod.env  env/prod.env          # project, region, names (no secrets)
│   ├── 01-enable-apis.sh
│   ├── 02-service-accounts-iam.sh
│   ├── 03-cloudsql-private.sh                 # instance + DBs + kpi_reader user + secret
│   ├── 04-psc-endpoint-attachment.sh
│   └── 05-apigee-products-apps.sh             # API product, MOT test developer + app
├── db/
│   ├── migrations/V001__create_kpi_records.sql
│   ├── seed/total_freight.sql                 # idempotent mock data
│   └── load.sh                                # upload to GCS + gcloud sql import sql
├── integration/                               # one integrationcli apply root per env (D20)
│   ├── connectors/sar-kpi-db-<env>.json
│   └── <env>/                                 # dev | staging | prod
│       ├── src/sar-kpi-get-<env>.json         # file name = integration name (D21)
│       ├── overrides/overrides.json
│       ├── tests/                             # TestCase definitions
│       └── test-configs/                      # executeTest bodies, same file names
├── src/main/apigee/
│   ├── apiproxies/sar-mot-kpis-v1/{pom.xml, apiproxy/...}
│   ├── environments/<local|dev|staging|prod>/kvms/{sar-mot-kpis-config,sar-mot-kpis-errors}.json
│   └── environments/<env>/debugmask.json
├── deploy/shared-pom.xml
├── scripts/                                   # copied from cicd-workspace + new integration scripts
├── tests/  postman collection, env files, unit/ (mocha for proxy JS)
├── cloudbuild-infra.yaml  cloudbuild-pr.yaml  cloudbuild-main.yaml  cloudbuild-prod.yaml
└── package.json
```

---

## P0 — Repo bootstrap

**Goal:** an empty but runnable workspace that follows `cicd-workspace` conventions.

1. 👤 Create the GitHub repo `apigee-poc/sar-mot-kpis` and clone it. Copy this starter kit in.
2. Copy from `cicd-workspace`: `deploy/shared-pom.xml`, `scripts/*.sh`, `package.json`
   (pinned `apigeelint` and `newman`), `.gitignore`, `.gitattributes`. Rename every `hello-v1`
   reference to `sar-mot-kpis-v1`.
3. Add `mocha` + `chai` as dev dependencies, plus the script `"test:unit": "mocha tests/unit"`.
4. Change `deploy-revision.sh` and the Maven deploy so the deployment passes the runtime
   service account (`serviceAccount=sa-kpi-proxy-runtime@<project>.iam.gserviceaccount.com`
   query parameter on the deployments API). VERIFY the equivalent option in the
   apigee-deploy-maven-plugin version in use. If none exists, deploy with the script for both
   the first deploy and promotion.
5. Install `integrationcli` locally (Google's application-integration-management-toolkit)
   and record its version in `docs/DEPLOYMENT.md`.

**Acceptance:** `npm ci` and `npm run lint` run (lint may have nothing to lint yet). Scripts
contain no `hello-v1` references.

---

## P1 — Non-prod foundation

**Goal:** APIs, identities and permissions in `apigee-nonprod-511322`.

1. `infra/01-enable-apis.sh`: enable `sqladmin`, `integrations`, `connectors`, `secretmanager`,
   `servicenetworking`, `compute`, `storage`, `cloudbuild` (VERIFY the exact API names).
2. 👤 Provision Application Integration in `us-central1` for this project, if it isn't already.
   The Console's one-time setup page is simplest.
3. `infra/02-service-accounts-iam.sh` (idempotent: create only if missing). It creates:
   - `sa-kpi-proxy-runtime` with `roles/integrations.invoker`
   - `sa-kpi-connector` with `roles/secretmanager.secretAccessor` on the DB password secret only
   - Grants for `cb-deploy-nonprod` (from `ci-cd-511313`) on this project: Integration admin,
     Connectors admin, a Cloud SQL role that includes `cloudsql.instances.import`,
     `roles/iam.serviceAccountUser` on both new SAs, and `roles/storage.objectAdmin` on the seed
     bucket. Choose the least-privileged roles and record them in `DECISIONS.md`.
   - Grant the Apigee service agent permission to act as `sa-kpi-proxy-runtime`, if required
     (VERIFY).

**Acceptance:** `gcloud projects get-iam-policy` shows exactly the intended bindings, and
the script is safe to re-run.

---

## P2 — Private Cloud SQL + mock data

**Goal:** a private PostgreSQL instance holding the OAS example data.

1. `infra/env/nonprod.env`: names, tier (smallest shared-core), PostgreSQL version.
2. `infra/03-cloudsql-private.sh` (👤 approve before running, it's billable):
   - Create `sar-kpi-sql-nonprod` with **Private Service Connect enabled and no public IP**.
     Allow-list the Integration Connectors tenant project in `--allowed-psc-projects`. Obtain
     that project from the Connectors runtime config for `us-central1` (VERIFY how).
   - Create databases `kpis_dev` and `kpis_staging`.
   - Create user `kpi_reader` with a generated password, written straight into Secret Manager
     secret `sar-kpi-db-reader-password` (piped, never printed).
   - Create the GCS bucket `<project>-sar-kpi-seed` and grant the instance's service account
     read access.
3. `db/migrations/V001__create_kpi_records.sql`:

   ```sql
   CREATE TABLE IF NOT EXISTS kpi_records (
     kpi_code   VARCHAR(64)   NOT NULL,
     year       SMALLINT      NOT NULL CHECK (year BETWEEN 2000 AND 2099),
     quarter    SMALLINT      NOT NULL CHECK (quarter BETWEEN 1 AND 4),
     actual     NUMERIC(20,4) NOT NULL CHECK (actual >= 0),
     load_time  TIMESTAMPTZ   NOT NULL,
     PRIMARY KEY (kpi_code, year, quarter)
   );
   GRANT SELECT ON kpi_records TO kpi_reader;
   ```

4. `db/seed/total_freight.sql`: idempotent (`INSERT ... ON CONFLICT (kpi_code, year, quarter)
   DO UPDATE`). Use exactly the OAS example rows:

   | kpi_code | year | quarter | actual | load_time |
   |---|---|---|---|---|
   | total_freight | 2025 | 1 | 1420500 | 2025-04-05T02:00:00Z |
   | total_freight | 2025 | 2 | 1388200 | 2025-07-05T02:00:00Z |
   | total_freight | 2025 | 3 | 1512750 | 2025-10-05T02:00:00Z |

   Insert nothing for 2025 Q4 or 2026, so the empty-array case is testable. Add 2024 Q1–Q4
   (any plausible values) so a full four-quarter year is also testable.
5. `db/load.sh <env>`: uploads migration + seed to the bucket and runs `gcloud sql import sql`
   into `kpis_<env>`, migrations first. Must be idempotent.

**Acceptance:** the instance has no public IP; re-running `load.sh dev` twice gives the same
7 rows; the password exists only in Secret Manager.

---

## P3 — Integration Connector (private)

**Goal:** connections `sar-kpi-db-dev` and `sar-kpi-db-staging` reaching the private instance.

1. VERIFY in current docs the supported private path from Integration Connectors to a PSC-enabled
   Cloud SQL instance. The expected approach is an **endpoint attachment** targeting the
   instance's PSC service attachment, used as the host in a PostgreSQL connection. Record the
   result in `DECISIONS.md`.
2. `infra/04-psc-endpoint-attachment.sh` (👤 approve): create endpoint attachment
   `sar-kpi-sql-nonprod-ea`.
3. Connection definitions (JSON, as produced by `integrationcli connectors get`/scaffold):
   host = endpoint attachment, database `kpis_<env>`, user `kpi_reader`, password from the
   Secret Manager secret, service account `sa-kpi-connector`. Smallest node count.
4. Create both connections with `integrationcli connectors create ... --wait=true`.

**Acceptance:** both connections are `ACTIVE`; a test query from the Console connection
tester or a throwaway integration returns the seed rows for its own database only.

---

## P4 — Application Integration

**Goal:** `sar-kpi-get-dev` and `sar-kpi-get-staging`, published from the repo.

1. Design once. (Done by hand-authoring the src JSON — no Console access — and verified by a real
   dev/staging deploy.) The integration has:
   - API trigger `api_trigger/sar-kpi-get-<env>` (per env, D22)
   - Inputs: `kpiCode` (string), `year` (int), `quarter` (int, default `0` = all quarters; never
     null — P5 omits it or sends 0)
   - Connectors task on `sar-kpi-db-<env>`, action **Execute custom query**:
     ```sql
     SELECT quarter, year, actual, load_time FROM kpi_records
     WHERE kpi_code = ? AND year = ? AND (CAST(? AS SMALLINT) IS NULL OR quarter = ?)
     ORDER BY quarter
     ```
   - Task 1 `JS-BuildConnectorInput` (JavaScript, D24) builds the query input (quarter 0 →
     NULL); task 3 `JS-TransformOutput` (JavaScript) maps the rows into output `data` = `{"records": [KpiRecord…]}` (D26; a JSON variable only
     accepts an object): `load_time` → `loadTime` as ISO-8601 UTC `YYYY-MM-DDTHH:MM:SSZ`, `actual`
     as a number, and `{"records": []}` (never null) when there are no rows.
   - On task failure, end with an error so Apigee sees a non-2xx response. No partial data.
2. Keep it in the repo as one apply root per env (D20, D21):
   `integration/<env>/src/sar-kpi-get-<env>.json` (the file name is the integration name; each
   file hard-codes its own `sar-kpi-db-<env>` connection and trigger),
   `integration/<env>/overrides/overrides.json` (connection + trigger again, defence in depth).
   The dev and staging src files differ only in those values (unit-tested). To compare with
   the service, `integrationcli integrations scaffold -n sar-kpi-get-dev --latest -f <tmp> -e dev`
   and diff; do not commit the scaffolded `src/javascript/*.js` (apply would override the inline
   scripts with them).
3. Integration test cases in `integration/<env>/tests/` (TestCase definitions) with matching
   `integration/<env>/test-configs/` (`executeTest` bodies, same file names): full year 2025
   (3 rows), quarter 3 (1 row), 2026 (0 rows), 2024 (4 rows).
4. Publish dev with `integrationcli integrations apply -f ./integration/dev --skip-connectors=true
   --wait=true --run-tests=true -p apigee-nonprod-511322 -r us-central1` (**no `-e`**), then
   staging the same way with `./integration/staging`. `--userlabel` is ignored by integrationcli
   v0.86.0 (D23): stamp `"userLabel": "<SHORT_SHA>"` into a temp copy of the env's apply root and
   apply the copy.
5. Add `scripts/get-published-integration-version.sh` and `scripts/rollback-integration.sh`.
   These record the published version before apply and, on failure, restore that version's
   content as a new draft and publish it (D25, D29: publishing a new version moves the old one to
   SNAPSHOT, and an old version cannot be re-published by id),
   mirroring `get-deployed-revision.sh` / `rollback.sh`.

**Acceptance:** both integrations are published with the commit SHA as label; test cases
pass; executing via API returns `data.records` in the exact OAS `KpiRecord[]` shape.

---

## P5 — Apigee proxy `sar-mot-kpis-v1`

**Goal:** the proxy behaves exactly as the OAS and `docs/ERROR-CATALOG.md` say.

Policies (pet-poc naming style). Use `__KVM_VERSION__` placeholders for the KVM map
identifiers, stamped by the pipeline.

Bundle: 40 policies, 6 JS resources, ProxyEndpoint `default`, IntegrationEndpoint `default`
(`integration-endpoints/default.xml`, no TargetEndpoint). Conditions never read `request.*`:
inputs are validated in JavaScript into always-set `"true"`/`"false"` flags (D34), and the inbound
verb is captured once (D36).

| Stage | Step (condition) | Purpose |
|---|---|---|
| PreFlow req | `AM-SetTraceAndTimestamp` | `custom.timestamp` (ISO-8601 UTC via `timeFormatUTCMs`), `custom.traceId = {createUuid()}` (D33), `custom.messageId`, `custom.requestVerb` (D36), `custom.integrationCalled`/`custom.proxyFault` = `"false"` |
| | `KVM-GetConfig` | `sar-mot-kpis-config-__KVM_VERSION__` (11 keys: integrationName, triggerName `api_trigger/sar-kpi-get-<env>` D22, projectId, region, spikeArrestRate, quotaLimit, quotaInterval, quotaTimeUnit, maxClockSkewSeconds, allowedKpis, commit) |
| | `JS-ValidateRequestInputs` | sets `custom.requestIdValid`, `operatorIdValid`, `yearValid`, `quarterValid` (D34) |
| | `RF-InvalidRequestId` (`custom.requestIdValid != "true"`) | malformed X-Request-Id → `ERR-400-REQUESTID` (a missing header is replaced by the platform, D35) |
| | `AM-SetClientTraceId` | `custom.traceId` = the valid X-Request-Id |
| | `VA-VerifyApiKey` | `X-API-Key` (rows 2, 3, 5) |
| | `JS-ValidateApiSecret` | constant-time compare with `verifyapikey.VA-VerifyApiKey.client_secret` → `custom.secretValid` (D8) |
| | `RF-InvalidSecret` (`custom.secretValid != "true"`) | `ERR-401-SECRET` |
| | `AM-SetRateIdentifier` | `custom.rateIdentifier` = developer email / app name, never the key (D37) |
| | `SA-SpikeArrest` | rate `config.spikeArrestRate` (literal 30pm only as fallback) |
| | `AM-SetQuotaValues` → `Q-ImposeQuota` | product quota if set, else config KVM |
| | `JS-ValidateRequestTimestamp` → `RF-InvalidRequestTimestamp` (`custom.timestampValid != "true"`) | `ERR-400-TIMESTAMP` (1–3 fractional digits, D42) |
| | `RF-InvalidOperatorId` (`custom.operatorIdValid != "true"`) | `ERR-400-OPERATOR` |
| Flow `GetTotalFreight` (`proxy.pathsuffix MatchesPath "/kpis/total_freight"` and `custom.requestVerb = "GET"`), req | `AM-SetKpiCode` → `JS-CheckKpiAllowed` → `RF-ResourceNotFound` (`custom.kpiAllowed != "true"`) | `kpi.code = total_freight`; allowlist `config.allowedKpis`, else 404 |
| | `RF-InvalidQueryParams` (`custom.yearValid != "true"`; `custom.quarterValid != "true"`) | `ERR-400-PARAMS` |
| | `JS-SetIntegrationParams` → `SIR-SetIntegrationRequest` → `AM-SetIntegrationCalled` | digit strings `kpi.year`/`kpi.quarter` (`"0"` = all) into `type="integer"` parameters (D35); name, trigger, project, region from the KVM |
| resp | `RF-GatewayTimeout` (`response.status.code` 503 or 504) | `ERR-504-TIMEOUT` (D41) |
| | `RF-IntegrationError` (status not 2xx) | `ERR-500-INTEGRATION` |
| | `EV-ExtractIntegrationOutput` | `$.outputParameters.data.records` → `kpi.records` (debug only, `continueOnError`; path confirmed on dev, D36) |
| | `JS-ValidateIntegrationOutput` → `RF-BadGateway` (`custom.outputValid != "true"`) | parses `response.content`, at most 4 valid records → `kpi.recordsJson`; else `ERR-502-GATEWAY` |
| | `AM-BuildKpiResponse` | `{header:{timestamp,traceId,isSuccess:true}, data:<records>}`, 200 |
| Flow `MethodNotAllowed` (same path, `custom.requestVerb != "GET"`) | `RF-MethodNotAllowed` | `ERR-405-METHOD`, sets `Allow: GET` |
| Flow `NotFound` (unconditional, last) | `RF-ResourceNotFound` | `ERR-404-RESOURCE` |
| PostFlow resp | `AM-SetResponseRequestIdHeader` | `X-Request-Id: {custom.traceId}` (the platform still returns the client-sent value, D35) |
| FaultRule `invalid-key-for-resource` | `AM-SetStatus403` | `InvalidApiKeyForGivenResource` or `consumer_key_missing_api_product_association` → 403 (D41) |
| FaultRule `inactive-owner` | `AM-SetStatus401` | `CompanyStatusNotActive` → 401 (D41) |
| FaultRule `rate-limit` | `AM-SetStatus429` | `SpikeArrestViolation` / `QuotaViolation` → 429 |
| FaultRule `integration-fault` (`custom.integrationCalled = "true"` and `custom.proxyFault != "true"`) | `AM-SetIntegrationError`, then `AM-SetTimeoutError` on GatewayTimeout / ServiceUnavailable or `error.status.code` 503/504 | 500 `ERR-500-INTEGRATION` or 504 `ERR-504-TIMEOUT` (D41) |
| DefaultFaultRule (`AlwaysEnforce=true`) | `AM-SetLookupKey` → `KVM-GetErrorMessage` → `AM-CheckErrorMessage` → (no message: `AM-SetSystemError` + 2nd `KVM-GetErrorMessage`) → `AM-BuildErrorResponse` → `AM-SetResponseRequestIdHeader` | integer `error.code`, `escapeJSON` message, status override → `error.status.code` → 500; unmapped faults → `ERR-SYS-500` |

The three FaultRules that test only `fault.name` fire before `AM-SetIntegrationCalled`, and
`integration-fault` requires `custom.integrationCalled = "true"`, so the FaultRules are mutually
exclusive and their evaluation order does not matter. Timeouts are mapped in the **ProxyEndpoint**
FaultRule `integration-fault` and the response-flow `RF-GatewayTimeout`; there is no TargetEndpoint.

Environment files:
- `debugmask.json` (all four envs) masks the credential headers (both case forms), `X-Operator-Id`,
  `verifyapikey.VA-VerifyApiKey.client_id` / `client_secret` / `developer.email`, `client_id`,
  `apigee.client_id`, `ratelimit.SA-SpikeArrest.identifier`, `ratelimit.Q-ImposeQuota.identifier`,
  `custom.rateIdentifier` and `request.queryparam.apikey` (D37, D41). **Dev was masked by hand** with
  `PATCH https://apigee.googleapis.com/v1/organizations/<org>/environments/<env>/debugmask?updateMask=variables`
  (body `{"variables":[…]}` from `environments/<env>/debugmask.json`). Staging and prod are not masked
  yet: **P7 must automate exactly that call for every environment.**
- Config and error KVM definitions for `local`, `dev`, `staging` and `prod` (error KVM: 21 keys,
  verbatim catalog texts).

`infra/05-apigee-products-apps.sh`: create API product `sar-mot-kpis-product` (path
`/kpis/**`, envs dev + staging, **no verb restriction**, D32), developer `mot-poc@example.com`, app
`mot-poc-app`, and a second product **without** this path for the 403 test. Credentials go to
Secret Manager for the pipelines and are never committed.

**Acceptance (waived as recorded in D39):** `npm run lint` passes with 0/0 and the unit tests pass;
no emulator (user decision); the dev matrix was verified by hand (4 happy paths and rows 1
(malformed), 2–5, 8–12). Rows 6, 7, 13, 14, 15 and 16 are **not** verified on dev and are part of
P6 acceptance, using the fault-injection recipes in D39. The Newman suite is P6.

---

## P6 — Tests

1. `tests/unit/` (mocha): every branch of `JS-ValidateRequestTimestamp`.
2. `tests/sar-mot-kpis.postman_collection.json`. At least one request per catalog row (404 tests use
   `/kpis/<unknown>`: an unknown path outside `/kpis/**` gives 403, see D32), plus:
   - 200 full year 2025 (3 items, values equal the OAS example)
   - 200 quarter 3
   - 200 year 2026 → `data: []`
   - 200 year 2024 (4 items)
   - Every response with a valid `X-Request-Id`: `header.traceId === X-Request-Id` request header === `X-Request-Id`
     response header (for a malformed ID the response header echoes it and `header.traceId` is a fresh UUID; a missing header cannot be tested, the platform adds one, D35); `timestamp` matches ISO-8601; `isSuccess` correct; `error.code` is a
     **number** equal to the HTTP status
   - Schema check of every body against the OAS schemas (embed the JSON schemas in the
     collection)
3. Environment files: `local` (error cases only, via a folder tag), `dev`, `staging`, `prod`
   (prod = read-only smoke subset). Credentials are injected by the pipeline from Secret
   Manager as Newman `--env-var`, never stored in files.

4. Carried over from the P5 final review (D35, D38, D39):
   - 404 tests use `/kpis/<unknown>` (a path outside `/kpis/**` gives 403, D32).
   - Non-GET requests need an explicit empty body (`Content-Length: 0`, e.g. `curl --data ""`),
     otherwise the front end answers HTTP 411.
   - A `POST` without headers returns **400**. Row 1 is tested with a malformed X-Request-Id (a
     missing header is replaced by the platform, D35); a POST with all valid headers gives 405.
   - Assert `Allow: GET` on 405 (the proxy sets it in `RF-MethodNotAllowed`).
   - Trace-ID assertions only for valid IDs (D35).
   - `error.code` is a number equal to the HTTP status.
   - 429 (rows 6, 7) via a scratch config (low `spikeArrestRate` / `quotaLimit`), **not** a burst (D38).
   - The fault-injection runs for rows 6, 7, 13, 14, 15 and 16 (recipes in D39) are **P6
     acceptance**; the row 13 run also records the IntegrationEndpoint fault name and path (V3/V9).

**Acceptance:** the suite is green on dev, and the D39 fault-injection runs produce rows 6, 7, 13,
14, 15 and 16 (or a row is explicitly waived with a reason).

**Result (2026-11-12):** met with a waiver.
- Full suite green on dev revision 7: 24 requests, 260 assertions, 0 failures, before and after
  the fault-injection runs.
- Rows 6, 7, 13 and 16 verified on dev with scratch revisions 8-11 (`scripts/fi-deploy.sh`,
  folders `FI-06`/`FI-07`/`FI-13`/`FI-16`), then restored to revision 7 with
  `scripts/fi-restore.sh` (D45, D46).
- Rows 14 and 15 waived with reasons (D44); their logic is covered by unit tests.
- [x] Row 13 records the IntegrationEndpoint fault and path (V3/V9): an Apigee fault
  `BadGateway` ("Received non success response code") in the target response flow (D46).
- Prod smoke subset (`--folder "Happy paths"`) is a P8 pipeline decision; the smoke folder
  asserts exact mock values, so `kpis_prod` needs the same seed or prod needs its own subset
  (D47).

---

## P7 — CI/CD pipelines (non-prod)

All in Cloud Build, project `ci-cd-511313`, same triggers and service accounts as
`cicd-workspace`.

- `cloudbuild-infra.yaml`: manual trigger with approval. Runs `infra/0*.sh` for
  `_TARGET=nonprod` **only** (any other value is refused). Never runs automatically. The prod
  foundation gets its own `cloudbuild-infra-prod.yaml` on a separate approved trigger as
  `cb-deploy-prod` in P8 (D55).
- `cloudbuild-pr.yaml` (`cb-validate`, no cloud access): `npm ci` → apigeelint → unit tests →
  OAS lint (e.g. `@redocly/cli lint`) → integration JSON validation → Maven package.
- `cloudbuild-main.yaml` (`cb-deploy-nonprod`), on push to `main`:
  1. `npm ci`, lint + unit tests on the **unstamped** tree (a stamped tree fails the
     `kvm-contract` tests, D51)
  2. stamp commit + KVM version (`scripts/stamp-commit.sh`, as in `cicd-workspace`)
  3. `db/load.sh dev` (expand-only migrations + seed)
  4. connections apply for dev (no-op if unchanged)
  5. record the published integration version, then (with integrationcli v0.86.0 from the pinned,
     checksum-verified download `scripts/install-integrationcli.sh`, D48; no builder image)
     `integrationcli integrations apply -f <copy of integration/dev with userLabel stamped>
     --skip-connectors=true --wait=true --run-tests=true` (D20, D23); on failure roll back the
     integration (D25, D29). Also:
     - record the published version id **after** apply too (rollback's `failed_version`
       argument needs it for the no-previous-version / fallback-unpublish path, and step 8 reports it)
     - scripted post-apply assertion on the ACTIVE version: task 2 `connectionName` ends in
       `sar-kpi-db-<env>` and `userLabel` == SHORT_SHA; fail the build otherwise
     - after a rollback, re-record the version id: the restored version gets a **new** id (D29)
  6. deploy `debugmask.json` to the environment with
     `PATCH https://apigee.googleapis.com/v1/organizations/<org>/environments/<env>/debugmask?updateMask=variables`
     (body `{"variables":[…]}` from `environments/<env>/debugmask.json`; dev was done by hand this way
     in P5, staging and prod are still unmasked), then record the dev proxy revision → create versioned KVMs → deploy proxy with runtime SA →
     wait → runtime-SA check → Newman dev → on a failure of any of deploy, wait, SA check or
     Newman, roll back **proxy, then integration** (D54)
  7. repeat steps 3–6 for staging, promoting the **same proxy revision** as in
     `cicd-workspace`
  8. summary: commit, integration versions, proxy revisions

**Acceptance:** a merge to `main` reaches staging green. A commit with a broken test rolls
dev back and staging is untouched.

**Implemented (2026-11-12, offline):** `cloudbuild-pr.yaml`, `cloudbuild-main.yaml`,
`cloudbuild-infra.yaml` (nonprod only; refuses `_TARGET=prod`), the helper scripts
(`stamp-commit`, `install-integrationcli`, `apply-integration`, `assert-integration`,
`deploy-debugmask`, `assert-proxy-runtime-sa`, `lib/python.sh`), the carry-over fixes I-3, M-4 and M-5,
and the static tests `tests/unit/pipeline-scripts.test.js` and `tests/unit/pipelines.test.js`
(D48–D53), plus the final-review fixes (D54–D58: whole proxy phase under rollback,
fail-closed `get-deployed-revision.sh`, strict `rollback.sh`, Newman secret grants in infra/05,
strict CI tests). Step 4 (connections apply) is not a pipeline step: the connections are created
by P3/infra and integrationcli runs with `--skip-connectors=true`, so a changed connection needs a
manual or infra run. **Pending (👤):** GitHub remote, Cloud Build connection and triggers
(DEPLOYMENT.md "CI/CD triggers (not created yet)"), then the acceptance run above (D53).

**P7 carry-over from P4 final review (no code yet):**
- I-3: `scripts/get-published-integration-version.sh` fails open. It must exit non-zero on
  401/403/5xx, network errors or an empty token, and treat only HTTP 200 without an ACTIVE version
  or 404 as "none". Otherwise a transient failure makes `rollback-integration.sh` take the
  "no previous version" branch and **unpublish** instead of restoring.
- M-4: the same script's header says "never fails hard", but it exits non-zero when no Python
  runs — reconcile with the I-3 fix.
- M-5: `infra/02-service-accounts-iam.sh` should check that the Application Integration service
  agent exists (Quick setup done, D28) before the `connectors.invoker` grant, with a clear message,
  instead of aborting under `set -e` before the cb-deploy grants.
- Deferred: orphan DRAFT left after a failed restore (note it in P9 DEPLOYMENT rollback notes);
  rollback polling prints the API error every 5 s; a missing `kpiCode` becomes the literal
  "undefined" in JS-BuildConnectorInput (P5 always sets it via `AM-SetKpiCode`).

---

## P8 — Prod

1. 👤 Provision Application Integration in `us-central1` for `apigee-prod-511508` (Console
   **Quick setup**, once per project/region, D28). Then grant the Application Integration service
   agent `service-<PROJECT_NUMBER>@gcp-sa-integrations.iam.gserviceaccount.com`
   `roles/connectors.invoker` on the prod project (the prod variant of
   `infra/02-service-accounts-iam.sh`); without it publish fails with
   `connectors.connections.get` denied.
2. Write `cloudbuild-infra-prod.yaml` (its own manual trigger with approval, service account
   `cb-deploy-prod`, `infra/env/prod.env`; D55; `cloudbuild-infra.yaml` stays nonprod-only) and
   run it (👤 approve). It creates the same foundation, `sar-kpi-sql-prod` / `kpis_prod`, the endpoint attachment, the connection
   `sar-kpi-db-prod`, the runtime SA, and grants for `cb-deploy-prod`.
3. `cloudbuild-prod.yaml`: manual trigger with approval. It must:
   - find the revision READY in staging
   - read its commit SHA from the bundle description
   - **fail if it differs from the build's commit**
   - seed `kpis_prod`
   - apply the integration from `integration/prod/` (`src/sar-kpi-get-prod.json` with the
     `sar-kpi-db-prod` connection and `api_trigger/sar-kpi-get-prod`, plus
     `overrides/overrides.json`, `tests/`, `test-configs/`; userLabel stamped, no `-e`;
     D20–D23). The prod src task 2 `config` must use **prod** values in all three places that
     hard-code non-prod today: `connectionName` project (`apigee-prod-511508`), `serviceName`
     tenant project (the prod Connectors tenant, via `get-runtime-config`, not
     `ef911070c468726ff-tp`) and `connectorVersion` project. When adding `prod` to `ENVS` in
     `tests/unit/integration-sar-kpi-get.test.js`, extend its normalisation to the project id and
     tenant project too.
   - copy the proxy revision to the prod org
   - create the versioned KVMs
   - deploy with the prod runtime SA
   - run the smoke tests
   - roll back the proxy, then the integration, on failure
4. Prod API product + MOT app (credentials in Secret Manager, handed over 👤 out of band).

**Acceptance:** a prod run promotes byte-for-byte what passed staging, and the smoke tests
pass.

**Status: IN REVIEW (files; prod run pending).** Every file is written and statically tested.
The acceptance above has **not** been run: per AGENTS.md rule 2, nothing ran against
`apigee-prod-511508`. The acceptance is met when:

- an approved `sar-mot-kpis-prod` run, at a commit whose most recent `sar-mot-kpis-main` build is
  green, passes `check-commit`;
- its `copy-revision` imports the staging bundle with the identical stamped description (`cmp`);
- the deployed prod revision runs as `sa-kpi-proxy-runtime@apigee-prod-511508`;
- the `Happy paths` smoke passes against `https://prod.35.201.86.122.nip.io`.

Record the first-run VERIFY results (DEPLOYMENT.md "First-run VERIFY list") in DECISIONS, then mark
P8 `DONE`.

**Implemented (2026-11-12, offline, branch `p8-prod`):**

- **Task A.** `infra/env/prod.env`, the prod guard `infra/lib/guard.sh` in `infra/01`–`06` and
  `db/load.sh`, `infra/02`/`04` prod-only steps (on `IS_PROD`), `infra/06-apigee-prod-product-app.sh`,
  `scripts/create-connection.sh` + `integration/connectors/sar-kpi-db-prod.json`, `integration/prod/**`
  (tenant placeholder), and the prod helper scripts (`apply-`/`assert-integration-prod`,
  `deploy-debugmask-prod`, `run-newman-prod`, `lib/prod-guard`, `lib/connectors-tenant`).
- **Task B.** `cloudbuild-infra-prod.yaml`, `cloudbuild-prod.yaml` and `scripts/check-release-commit.sh`.
- **Tests.** `tests/unit/prod-scripts.test.js` and `tests/unit/prod-pipelines.test.js`.
- **Task C.** The runbook (DEPLOYMENT.md "Prod (P8)") and D59–D66.

Step 1 above is a 👤 prerequisite. Steps 2–4 are done as files: step 2 by `cloudbuild-infra-prod.yaml`, step 3 by `cloudbuild-prod.yaml`, step 4 by `infra/06`. Every one of them is pending its first approved run.

**What YOU must run/approve** (identical to DEPLOYMENT.md; commands A–D, the trigger commands and
the staging-green check are there):

1. 👤 Review and merge `p8-prod` into `main`.
2. 👤 Decide the real MOT developer email. Edit the `MOT_DEVELOPER_EMAIL` line in `infra/env/prod.env`, then commit (`P8: set MOT developer email`). At the same time, decide D41 (D63): either record that the email is not sensitive, or hash the rate identifier. Hashing is a proxy change, so it goes through dev and staging first.
3. 👤 Create the GitHub repository `apigee-poc/sar-mot-kpis`, run `git remote add origin https://github.com/apigee-poc/sar-mot-kpis.git`, and push `main`. Create the Cloud Build GitHub connection and the three P7 triggers ("CI/CD triggers (not created yet)").
4. 👤 Let `sar-mot-kpis-main` take the merged commit green through dev and staging.
5. 👤 Console **Quick setup** for Application Integration in `apigee-prod-511508` / `us-central1` (D28).
6. 👤 Prod admin: run command A, the bootstrap roles for `cb-deploy-prod` on `apigee-prod-511508`.
7. 👤 Prod admin: run command B and confirm the output is **empty** (`cb-deploy-nonprod` has no role on prod). Also check Policy Analyzer for resource-level bindings.
8. 👤 Non-prod admin: approve and run command C, the custom read-only role for `cb-deploy-prod` on `apigee-nonprod-511322` (D60, supersedes D55).
9. 👤 Run command D: `logging.logWriter` for `cb-deploy-prod`, `serviceAccountUser` for the trigger creator, and `cloudbuild.builds.approver` for each approver, all on `ci-cd-511313`.
10. 👤 Create the triggers `sar-mot-kpis-infra-prod` and `sar-mot-kpis-prod` ("Prod triggers (NOT RUN)").
11. 👤 Run `sar-mot-kpis-infra-prod` and **approve** it (billable). Re-run it until `check-infra-02` passes, and once more before `secretmanager.admin` is ever removed from `cb-deploy-prod` (the DB secret viewer grant). Note the tenant project, the endpoint IP and the connection state.
12. 👤 Make sure `prod.35.201.86.122.nip.io` routes to the prod org's `prod` environment (VERIFY 11).
13. 👤 Confirm that the most recent `sar-mot-kpis-main` build is `SUCCESS` for the commit you will promote and that none is running ("Before approving").
14. 👤 Run `sar-mot-kpis-prod --sha=<that commit>` and **approve** it. Check the `summary` step. On failure, follow "Rollback behaviour and manual intervention".
15. 👤 Hand the `mot-app` credentials to MOT out of band.
16. 👤 Report the first-run VERIFY results (DEPLOYMENT.md "First-run VERIFY list") so they can be recorded in DECISIONS. Then mark P8 `DONE`.

---

## P9 — Documentation + demo

`README.md` (setup order, local workflow), `docs/DEPLOYMENT.md` (environments, roles,
rollback), `docs/ACCEPTANCE.md` (one row per catalog case with evidence). Record a demo:
success cases, three error cases, a failing commit rolled back automatically, and a prod
promotion.

---

## Known VERIFY items (resolve as you reach them)

1. Private path from Integration Connectors to PSC Cloud SQL (P3), and how to get the
   Connectors tenant project for `--allowed-psc-projects` (P2).
2. Deploying a proxy with a service account via the Maven plugin vs the API (P0). Resolved:
   `apigee.googletoken.email` on plugin 2.5.2 (D16, verified on dev, D40).
3. Exact response shape of an IntegrationEndpoint target, i.e. where `data` sits (P5). Resolved:
   `$.outputParameters.data.records` (D36).
4. Default HTTP statuses of VerifyAPIKey / SpikeArrest / Quota faults (P5). Resolved: rows 2 and 3
   are 401 (verified, D40); 403 and 429 are forced by FaultRules (D41).
5. Message-template syntax for the ISO timestamp (P5). Resolved: `timeFormatUTCMs` with a format
   variable works on dev (D40).
6. `integrationcli` folder layout and flags for the installed version (P4). Resolved: D20–D23.
7. Whether the Apigee emulator can run anything integration-related. Assume not; mock-free
   local tests cover error paths only (P6).
