# Implementation plan — SAR MOT KPI POC

Status values: `TODO` · `IN PROGRESS` · `BLOCKED (reason)` · `DONE (commit sha)`.
Agents update the status line of a phase when they start or finish it.
**👤 = human action required** (Console, approvals, or decisions an agent must not take).

| Phase | Title | Status |
|---|---|---|
| P0 | Repo bootstrap | DONE (505f7b7) |
| P1 | Non-prod foundation (APIs, service accounts, IAM) | DONE (cbf1347) |
| P2 | Private Cloud SQL + mock data | DONE (b5813cf) |
| P3 | Integration Connector (private) | DONE (8987442) |
| P4 | Application Integration | DONE (3400476) |
| P5 | Apigee proxy | TODO |
| P6 | Tests (unit, Newman, integration tests) | TODO |
| P7 | CI/CD pipelines (PR + non-prod) | TODO |
| P8 | Prod foundation + prod pipeline | TODO |
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

| Stage | Policy | Purpose |
|---|---|---|
| PreFlow req | `AM-SetTraceAndTimestamp` | `custom.traceId = messageid`; `custom.timestamp` = ISO-8601 UTC (e.g. `timeFormatUTCMs` in a message template; VERIFY exact syntax in the emulator) |
| | `KVM-GetConfig` | `sar-mot-kpis-config-__KVM_VERSION__`: integrationName, triggerName (`api_trigger/sar-kpi-get-<env>`, D22), projectId, region, spikeArrestRate, quotaLimit, quotaInterval, quotaTimeUnit, maxClockSkewSeconds, allowedKpis |
| | `RF-InvalidRequestId` | missing or not a UUID → `ERR-400-REQUESTID` |
| | `AM-SetClientTraceId` | `custom.traceId = request.header.X-Request-Id` |
| | `VA-VerifyApiKey` | `request.header.x-api-key` |
| | `RF-InvalidSecret` | `JS-ValidateApiSecret` (constant-time compare of `X-API-Secret` with `verifyapikey.VA-VerifyApiKey.client_secret`, sets `custom.secretValid`) → `ERR-401-SECRET` |
| | `SA-SpikeArrest`, `Q-ImposeQuota` | rates from KVM, with API product quota overriding when set |
| | `JS-ValidateRequestTimestamp` + `RF-InvalidRequestTimestamp` | ISO parse and clock-skew check → `ERR-400-TIMESTAMP` (unit-tested JS) |
| | `RF-InvalidOperatorId` | `^[12]\d{9}$` → `ERR-400-OPERATOR` |
| Flow `GetTotalFreight` (`/kpis/total_freight`, GET) | `RF-InvalidQueryParams` | year `^20\d{2}$`; quarter empty or `^[1-4]$` → `ERR-400-PARAMS` |
| | `AM-SetKpiCode` | `kpi.code = total_freight` |
| | `SIR-SetIntegrationRequest` | name, trigger name, project and region read via `ref` from the KVM; parameters `kpiCode`, `year`, `quarter` as numbers set by `JS-SetIntegrationParams` (quarter `0` = all quarters when absent, D24) |
| resp | `RF-IntegrationError` | status ≠ 2xx → `ERR-500-INTEGRATION` |
| | `EV-ExtractIntegrationOutput` | JSONPath `$.outputParameters.data.records` (integration output is `{records:[…]}`, D26; VERIFY the exact path with a debug session) |
| | `RF-BadGateway` | `data.records` missing, not an array, or > 4 items → `ERR-502-GATEWAY` |
| | `AM-BuildKpiResponse` | `{header:{timestamp,traceId,isSuccess:true}, data:<records array>}`, 200 |
| Flow `MethodNotAllowed` | `RF-MethodNotAllowed` | `ERR-405-METHOD` |
| Flow `NotFound` (catch-all) | `RF-ResourceNotFound` | `ERR-404-RESOURCE` |
| FaultRule (403) | `AM-SetStatus403` | `fault.name = "InvalidApiKeyForGivenResource"` |
| DefaultFaultRule (`AlwaysEnforce=true`) | `AM-SetLookupKey` → `KVM-GetErrorMessage` → `AM-BuildErrorResponse` | integer `error.code`, `escapeJSON` on the message, status from override → `error.status.code` → 500 |
| PostFlow resp + fault | `AM-SetResponseRequestIdHeader` | `X-Request-Id: {custom.traceId}` on every response |

Target: an **IntegrationEndpoint** target endpoint. Map timeout faults to `ERR-504-TIMEOUT`
in a target FaultRule, as pet-poc does.

Environment files:
- `debugmask.json` masks `X-API-Key`, `X-API-Secret` and `X-Operator-Id`.
- Config + error KVM definitions for `local`, `dev`, `staging` and `prod`. Error texts must
  be copied verbatim from `ERROR-CATALOG.md`.

`infra/05-apigee-products-apps.sh`: create API product `sar-mot-kpis-product` (path
`/kpis/**`, envs dev + staging), developer `mot-poc@example.com`, app `mot-poc-app`, and a
second product **without** this path for the 403 test. Credentials go to Secret Manager for
the pipelines and are never committed.

**Acceptance:** `npm run lint` passes with 0/0; the local emulator passes every error case that
doesn't need the integration; dev passes the full Newman suite.

---

## P6 — Tests

1. `tests/unit/` (mocha): every branch of `JS-ValidateRequestTimestamp`.
2. `tests/sar-mot-kpis.postman_collection.json`. At least one request per catalog row (404 tests use
   `/kpis/<unknown>`: an unknown path outside `/kpis/**` gives 403, see D32), plus:
   - 200 full year 2025 (3 items, values equal the OAS example)
   - 200 quarter 3
   - 200 year 2026 → `data: []`
   - 200 year 2024 (4 items)
   - Every response: `header.traceId === X-Request-Id` request header === `X-Request-Id`
     response header; `timestamp` matches ISO-8601; `isSuccess` correct; `error.code` is a
     **number** equal to the HTTP status
   - Schema check of every body against the OAS schemas (embed the JSON schemas in the
     collection)
3. Environment files: `local` (error cases only, via a folder tag), `dev`, `staging`, `prod`
   (prod = read-only smoke subset). Credentials are injected by the pipeline from Secret
   Manager as Newman `--env-var`, never stored in files.

**Acceptance:** the suite is green on dev, and a deliberately broken integration (wrong
connection in overrides) produces the 500 case in a scratch test.

---

## P7 — CI/CD pipelines (non-prod)

All in Cloud Build, project `ci-cd-511313`, same triggers and service accounts as
`cicd-workspace`.

- `cloudbuild-infra.yaml`: manual trigger. Runs `infra/0*.sh` for a chosen `_TARGET`
  (`nonprod`/`prod`). Never runs automatically.
- `cloudbuild-pr.yaml` (`cb-validate`, no cloud access): `npm ci` → apigeelint → unit tests →
  OAS lint (e.g. `@redocly/cli lint`) → integration JSON validation → Maven package.
- `cloudbuild-main.yaml` (`cb-deploy-nonprod`), on push to `main`:
  1. stamp commit + KVM version (as in `cicd-workspace`)
  2. lint + unit tests
  3. `db/load.sh dev` (expand-only migrations + seed)
  4. connections apply for dev (no-op if unchanged)
  5. record the published integration version, then (with the `integrationcli-builder` image)
     `integrationcli integrations apply -f <copy of integration/dev with userLabel stamped>
     --skip-connectors=true --wait=true --run-tests=true` (D20, D23); on failure roll back the
     integration (D25, D29). Also:
     - record the published version id **after** apply too (rollback's `failed_version`
       argument needs it for the no-previous-version / fallback-unpublish path, and step 8 reports it)
     - scripted post-apply assertion on the ACTIVE version: task 2 `connectionName` ends in
       `sar-kpi-db-<env>` and `userLabel` == SHORT_SHA; fail the build otherwise
     - after a rollback, re-record the version id: the restored version gets a **new** id (D29)
  6. deploy `debugmask.json` to the environment (`organizations/<org>/environments/<env>/debugmask`;
     **nothing does this yet**, so the AGENTS.md rule 4 masking exists only on paper until this step
     is added), then record the dev proxy revision → create versioned KVMs → deploy proxy with runtime SA →
     wait → Newman dev → on failure roll back **proxy, then integration**
  7. repeat steps 3–6 for staging, promoting the **same proxy revision** as in
     `cicd-workspace`
  8. summary: commit, integration versions, proxy revisions

**Acceptance:** a merge to `main` reaches staging green. A commit with a broken test rolls
dev back and staging is untouched.

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
2. Run `cloudbuild-infra.yaml` with `_TARGET=prod` (👤 approve). It creates the same
   foundation, `sar-kpi-sql-prod` / `kpis_prod`, the endpoint attachment, the connection
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
2. Deploying a proxy with a service account via the Maven plugin vs the API (P0).
3. Exact response shape of an IntegrationEndpoint target, i.e. where `data` sits (P5).
4. Default HTTP statuses of VerifyAPIKey / SpikeArrest / Quota faults (P5).
5. Message-template syntax for the ISO timestamp (P5).
6. `integrationcli` folder layout and flags for the installed version (P4). Resolved: D20–D23.
7. Whether the Apigee emulator can run anything integration-related. Assume not; mock-free
   local tests cover error paths only (P6).
