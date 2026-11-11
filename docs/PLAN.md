# Implementation plan — SAR MOT KPI POC

Status values: `TODO` · `IN PROGRESS` · `BLOCKED (reason)` · `DONE (commit sha)`.
Agents update the status line of a phase when they start or finish it.
**👤 = human action required** (Console, approvals, or decisions an agent must not take).

| Phase | Title | Status |
|---|---|---|
| P0 | Repo bootstrap | DONE (505f7b7) |
| P1 | Non-prod foundation (APIs, service accounts, IAM) | TODO |
| P2 | Private Cloud SQL + mock data | TODO |
| P3 | Integration Connector (private) | TODO |
| P4 | Application Integration | TODO |
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
├── integration/                               # integrationcli scaffold layout
│   ├── src/sar-kpi-get.json
│   ├── connectors/ (or <env>/connectors/)     # follow scaffold output
│   ├── overrides/<env>/overrides.json         # dev | staging | prod
│   └── test-cases/
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

1. Design once (👤 the Console editor is fine for the first version). The integration has:
   - API trigger `api_trigger/sar-kpi-get`
   - Inputs: `kpiCode` (string), `year` (int), `quarter` (int, nullable)
   - Connectors task on `sar-kpi-db-<env>`, action **Execute custom query**:
     ```sql
     SELECT quarter, year, actual, load_time FROM kpi_records
     WHERE kpi_code = ? AND year = ? AND (CAST(? AS SMALLINT) IS NULL OR quarter = ?)
     ORDER BY quarter
     ```
   - Data Mapping into output `data` (JSON array of `KpiRecord`): `load_time` → `loadTime` as
     ISO-8601 UTC `YYYY-MM-DDTHH:MM:SSZ`, `actual` as a number, and `[]` (never null) when
     there are no rows.
   - On task failure, end with an error so Apigee sees a non-2xx response. No partial data.
2. Pull it into the repo: `integrationcli integrations scaffold -n sar-kpi-get-dev --latest -f integration -e dev`.
   Normalise names so one `src/sar-kpi-get.json` plus per-env overrides
   (`overrides/<env>/overrides.json`) produce `sar-kpi-get-<env>` bound to `sar-kpi-db-<env>`.
3. Integration test cases in `integration/test-cases/`: full year 2025 (3 rows), quarter 3
   (1 row), 2026 (0 rows), 2024 (4 rows).
4. Publish dev with `integrationcli integrations apply --env=dev --folder=integration
   --userlabel=<SHORT_SHA> --wait=true --run-tests=true`, then staging the same way.
5. Add `scripts/get-published-integration-version.sh` and `scripts/rollback-integration.sh`.
   These record the published version before apply and re-publish it on failure, mirroring
   `get-deployed-revision.sh` / `rollback.sh`.

**Acceptance:** both integrations are published with the commit SHA as label; test cases
pass; executing via API returns `data` in the exact OAS shape.

---

## P5 — Apigee proxy `sar-mot-kpis-v1`

**Goal:** the proxy behaves exactly as the OAS and `docs/ERROR-CATALOG.md` say.

Policies (pet-poc naming style). Use `__KVM_VERSION__` placeholders for the KVM map
identifiers, stamped by the pipeline.

| Stage | Policy | Purpose |
|---|---|---|
| PreFlow req | `AM-SetTraceAndTimestamp` | `custom.traceId = messageid`; `custom.timestamp` = ISO-8601 UTC (e.g. `timeFormatUTCMs` in a message template; VERIFY exact syntax in the emulator) |
| | `KVM-GetConfig` | `sar-mot-kpis-config-__KVM_VERSION__`: integrationName, projectId, region, spikeArrestRate, quotaLimit, quotaInterval, quotaTimeUnit, maxClockSkewSeconds, allowedKpis |
| | `RF-InvalidRequestId` | missing or not a UUID → `ERR-400-REQUESTID` |
| | `AM-SetClientTraceId` | `custom.traceId = request.header.X-Request-Id` |
| | `VA-VerifyApiKey` | `request.header.x-api-key` |
| | `RF-InvalidSecret` | `request.header.x-api-secret != verifyapikey.VA-VerifyApiKey.client_secret` → `ERR-401-SECRET` |
| | `SA-SpikeArrest`, `Q-ImposeQuota` | rates from KVM, with API product quota overriding when set |
| | `JS-ValidateRequestTimestamp` + `RF-InvalidRequestTimestamp` | ISO parse and clock-skew check → `ERR-400-TIMESTAMP` (unit-tested JS) |
| | `RF-InvalidOperatorId` | `^[12]\d{9}$` → `ERR-400-OPERATOR` |
| Flow `GetTotalFreight` (`/kpis/total_freight`, GET) | `RF-InvalidQueryParams` | year `^20\d{2}$`; quarter empty or `^[1-4]$` → `ERR-400-PARAMS` |
| | `AM-SetKpiCode` | `kpi.code = total_freight` |
| | `SIR-SetIntegrationRequest` | name, project and region read via `ref` from the KVM; parameters `kpiCode`, `year`, `quarter` (omit quarter when absent) |
| resp | `RF-IntegrationError` | status ≠ 2xx → `ERR-500-INTEGRATION` |
| | `EV-ExtractIntegrationOutput` | JSONPath to the `data` output parameter (VERIFY the response shape with a debug session) |
| | `RF-BadGateway` | output missing, not an array, or > 4 items → `ERR-502-GATEWAY` |
| | `AM-BuildKpiResponse` | `{header:{timestamp,traceId,isSuccess:true}, data:<array>}`, 200 |
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
2. `tests/sar-mot-kpis.postman_collection.json`. At least one request per catalog row, plus:
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
  5. record the published integration version → `integrationcli integrations apply --env=dev
     --run-tests=true` (using the `integrationcli-builder` image) → roll back the integration on
     failure
  6. record the dev proxy revision → create versioned KVMs → deploy proxy with runtime SA →
     wait → Newman dev → on failure roll back **proxy, then integration**
  7. repeat steps 3–6 for staging, promoting the **same proxy revision** as in
     `cicd-workspace`
  8. summary: commit, integration versions, proxy revisions

**Acceptance:** a merge to `main` reaches staging green. A commit with a broken test rolls
dev back and staging is untouched.

---

## P8 — Prod

1. 👤 Provision Application Integration in `us-central1` for `apigee-prod-511508`.
2. Run `cloudbuild-infra.yaml` with `_TARGET=prod` (👤 approve). It creates the same
   foundation, `sar-kpi-sql-prod` / `kpis_prod`, the endpoint attachment, the connection
   `sar-kpi-db-prod`, the runtime SA, and grants for `cb-deploy-prod`.
3. `cloudbuild-prod.yaml`: manual trigger with approval. It must:
   - find the revision READY in staging
   - read its commit SHA from the bundle description
   - **fail if it differs from the build's commit**
   - seed `kpis_prod`
   - apply the integration with prod overrides
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
6. `integrationcli` folder layout and flags for the installed version (P4).
7. Whether the Apigee emulator can run anything integration-related. Assume not; mock-free
   local tests cover error paths only (P6).
