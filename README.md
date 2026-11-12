# sar-mot-kpis — SAR → MOT KPI Data Sharing POC

A read-only API that exposes approved SAR KPIs to MOT. The first resource is
`GET /mot-kpis/business-domain/v1/kpis/total_freight?year=YYYY[&quarter=1..4]`. The contract is
[`api/sar-mot-kpis-oas.yaml`](api/sar-mot-kpis-oas.yaml) (OAS v1.0.1). Every response, success or
error, matches it. Error behaviour is defined in
[`docs/ERROR-CATALOG.md`](docs/ERROR-CATALOG.md).

## Architecture

```
Client (MOT)
  │  X-API-Key, X-API-Secret, X-Request-Id, X-Request-Timestamp, X-Operator-Id
  ▼
Apigee X proxy  sar-mot-kpis-v1  (base path /mot-kpis/business-domain/v1)
  │  validation, key + secret, SpikeArrest/Quota, error envelope; runtime SA sa-kpi-proxy-runtime
  │  IntegrationEndpoint (no TargetEndpoint); integration name/trigger read from the versioned config KVM
  ▼
Application Integration  sar-kpi-get-<env>   (API trigger api_trigger/sar-kpi-get-<env>)
  │  JS-BuildConnectorInput → CON-QueryKpiRecords → JS-TransformOutput
  ▼
Integration Connectors  sar-kpi-db-<env>   (PostgreSQL, runtime SA sa-kpi-connector)
  │  private: PSC endpoint attachment → Cloud SQL service attachment
  ▼
Cloud SQL for PostgreSQL  (private IP / PSC only, read-only user kpi_reader, table kpi_records)
```

| | dev | staging | prod |
|---|---|---|---|
| Project / Apigee org | `apigee-nonprod-511322` | `apigee-nonprod-511322` | `apigee-prod-511508` |
| Hostname | `35.201.86.122.nip.io` | `staging.35.201.86.122.nip.io` | `prod.35.201.86.122.nip.io` |
| Integration / connection | `sar-kpi-get-dev` / `sar-kpi-db-dev` | `sar-kpi-get-staging` / `sar-kpi-db-staging` | `sar-kpi-get-prod` / `sar-kpi-db-prod` |
| Cloud SQL instance / DB | `sar-kpi-sql-nonprod` / `kpis_dev` | `sar-kpi-sql-nonprod` / `kpis_staging` | `sar-kpi-sql-prod` / `kpis_prod` |

All services run in `us-central1`. CI/CD runs in `ci-cd-511313`. The complete environment and
role tables are in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) ("Environments and roles").

The design is generic: `kpiCode` is a parameter end to end. Adding a KPI needs a proxy flow, an
`allowedKpis` entry in the config KVM, and data (AGENTS.md rule 8).

## Status

| Phase | Status |
|---|---|
| P0–P6 | DONE and verified on dev. The Newman suite is green on dev revision 7 (24 requests, 260 assertions). Catalog rows 6, 7, 13 and 16 were verified by fault injection; rows 14 and 15 are waived (unit-tested only). See [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md). |
| P7 CI/CD (PR + non-prod) | DONE for files, scripts and static tests. **Live acceptance PENDING user action:** git remote, Cloud Build GitHub connection and triggers (D53). |
| P8 Prod | DONE for files. **Prod run PENDING user action:** nothing has run against `apigee-prod-511508`. Checklist: DEPLOYMENT.md "Prod (P8)" → "What YOU must run/approve". |
| P9 Docs + demo | DONE for docs. **Demo recording and the staging/prod acceptance runs are PENDING user action** ([`docs/DEMO.md`](docs/DEMO.md)). |

The authoritative status is [`docs/PLAN.md`](docs/PLAN.md).

## Repository layout

```
AGENTS.md  CLAUDE.md  .agent/rules/  .claude/settings.json   agent rules and permissions
api/sar-mot-kpis-oas.yaml                  the contract (v1.0.1)
docs/                                      see "Where things are documented"
infra/
  env/nonprod.env  env/prod.env            names, tiers, accounts (no secrets)
  lib/guard.sh                             project/target guard, sourced by every infra script and db/load.sh
  01-enable-apis.sh                        APIs
  02-service-accounts-iam.sh               runtime SAs and IAM (exit 3 = incomplete, e.g. Quick setup missing)
  03-cloudsql-private.sh                   PSC-only Cloud SQL, DBs, kpi_reader + password secret, seed bucket (billable)
  04-psc-endpoint-attachment.sh            endpoint attachment for Integration Connectors (billable)
  05-apigee-products-apps.sh               non-prod product, test developer and apps; keys in Secret Manager
  06-apigee-prod-product-app.sh            prod product, MOT app and smoke app (prod only)
db/
  migrations/V001__create_kpi_records.sql  expand-only schema
  seed/total_freight.sql                   idempotent mock data (2024 Q1–Q4, 2025 Q1–Q3)
  load.sh                                  upload to GCS, then gcloud sql import sql
integration/
  connectors/sar-kpi-db-<env>.json         connection definitions (prod one has run-time placeholders, D61)
  <dev|staging|prod>/                      one integrationcli apply root per env (D20, D21)
    src/sar-kpi-get-<env>.json  overrides/overrides.json  tests/  test-configs/
src/main/apigee/
  apiproxies/sar-mot-kpis-v1/{pom.xml, apiproxy/}   the proxy bundle
  environments/<local|dev|staging|prod>/            kvms/{sar-mot-kpis-config,sar-mot-kpis-errors}.json, debugmask.json
deploy/shared-pom.xml                      Maven parent POM (from cicd-workspace)
scripts/                                   deploy, KVM, rollback, integration, debug-mask and prod helper scripts
  lib/                                     python.sh, prod-guard.sh, connectors-tenant.sh
  fi-deploy.sh  fi-restore.sh              dev-only fault injection (P6)
tests/
  sar-mot-kpis.postman_collection.json     generated by tests/tools/build-collection.js (do not edit by hand)
  environments/*.postman_environment.json  no credentials
  run-newman.sh                            dev/staging runner; reads credentials from Secret Manager
  fault-injection/README.md                rows 6, 7, 13, 16 procedure
  unit/                                    mocha: proxy JS, integration JS, KVM contract, pipelines, scripts
cloudbuild-pr.yaml  cloudbuild-main.yaml  cloudbuild-infra.yaml  cloudbuild-infra-prod.yaml  cloudbuild-prod.yaml
```

## Setup order (non-prod, first time)

The non-prod foundation exists already (P1–P6). This is the order to rebuild it, or to follow
for a new project. Steps marked 👤 are human steps. AGENTS.md rule 3 applies: billable or
destructive commands need explicit approval. Prod is never set up from a workstation (rule 2);
see DEPLOYMENT.md "Prod (P8)".

1. 👤 **Application Integration Quick setup** in the Console for the project and `us-central1`
   (D28). `infra/02` needs the integrations service agent it creates.
2. **Infra, in order:** `infra/01-enable-apis.sh` → `infra/02-service-accounts-iam.sh` →
   `infra/03-cloudsql-private.sh` (👤 approve, billable) → `infra/04-psc-endpoint-attachment.sh`
   (👤 approve, billable) → `infra/05-apigee-products-apps.sh`. Every script is idempotent.
   `infra/05` grants the Newman secret access itself (D56); re-run `infra/02` or `infra/05` only if
   the four test-app secrets were created some other way, or later. The preferred route is the
   approved manual trigger `sar-mot-kpis-infra-nonprod` (`cloudbuild-infra.yaml`, `_TARGET=nonprod`
   only).
3. **Connections:** the non-prod connections `sar-kpi-db-dev` / `sar-kpi-db-staging` were created
   once by hand in P3 with `integrationcli connectors create … --wait=true` from
   `integration/connectors/sar-kpi-db-<env>.json`. `scripts/create-connection.sh` is **prod
   only**, and the pipelines apply integrations with `--skip-connectors=true`, so a changed
   connection needs a manual or infra run.
4. **Database:** `bash db/load.sh dev`, then `bash db/load.sh staging`. Migrations run first, then
   the seed. Expand-only, and safe to re-run (7 rows).
5. **Integration:** `bash scripts/apply-integration.sh dev <short_sha>`, then `staging`. It stamps
   `userLabel` into a temp copy, then runs `integrationcli integrations apply --skip-connectors=true
   --wait=true --run-tests=true` without `-e` (D20–D23). Follow with
   `bash scripts/assert-integration.sh <env> <short_sha>`. integrationcli v0.86.0 is pinned
   (`scripts/install-integrationcli.sh`, D48).
6. **Proxy:** the normal route is `cloudbuild-main.yaml`. It runs `scripts/stamp-commit.sh` (commit
   into the description, `__KVM_VERSION__` → SHORT_SHA), `scripts/deploy-debugmask.sh <env>`,
   `scripts/create-versioned-kvm.sh <org> <env> <short_sha>`, then
   `mvn -f src/main/apigee/apiproxies/sar-mot-kpis-v1/pom.xml clean install -P<env> -Dbearer=<token>`
   (deploys with `sa-kpi-proxy-runtime`, D16). Staging gets the **same revision** through
   `scripts/deploy-revision.sh`. A manual deploy must create the versioned KVMs before the deploy,
   and must not commit the stamped tree (afterwards:
   `git checkout -- src/main/apigee/apiproxies/sar-mot-kpis-v1/apiproxy`).

Before a fresh project relies on it, read DEPLOYMENT.md "IAM required per build service account".

## Local workflow

Requires Node.js and `npm ci`. The tool versions are in DEPLOYMENT.md "Tooling & Prerequisites".

```bash
npm ci
npm run lint                         # apigeelint, profile apigeex, must be 0 errors / 0 warnings
npm run test:unit                    # mocha tests/unit (some tests need bash and Python 3)
REQUIRE_BASH_TESTS=1 npm run test:unit   # as in CI: bash/Python tests fail instead of skipping (D57)
npm run test:dev                     # = bash tests/run-newman.sh dev (calls the live dev env)
bash tests/run-newman.sh dev --folder "Happy paths"
bash tests/run-newman.sh dev --folder "Error rows"
```

- `npm run test:dev` / `test:staging` call the **live** environment. They read the four test-app
  secrets from Secret Manager in `apigee-nonprod-511322`, so they need `gcloud auth login` and
  `roles/secretmanager.secretAccessor` on those secrets. The credentials go to Newman as
  `--env-var` and are never printed.
- `run-newman.sh` accepts only `--folder`, `--bail` and, on dev, `--env-var faultScenario=<fiNN>`
  (D47). It refuses `prod` and `local`: there is no prod test script and no local emulator.
- Definition of done for a code change (AGENTS.md rule 7): lint 0/0, unit tests green, and the
  relevant Newman tests green.
- The collection is generated: edit `tests/tools/build-collection.js`, then run
  `node tests/tools/build-collection.js` (`--check` exits 1 if the committed file is out of date;
  the PR build runs it). `tests/unit/collection.test.js` checks the collection against the catalog
  and the OAS.
- Fault injection (dev only, one scenario at a time, approval needed):
  [`tests/fault-injection/README.md`](tests/fault-injection/README.md).

## Pipelines (Cloud Build, project `ci-cd-511313`, `us-central1`)

| File | Trigger | Service account | Purpose |
|---|---|---|---|
| `cloudbuild-pr.yaml` | `sar-mot-kpis-pr`: pull request to `main` | `cb-validate` (no cloud access) | npm ci → apigeelint → unit tests (`REQUIRE_BASH_TESTS=1`) → OAS lint → collection check → Maven package |
| `cloudbuild-main.yaml` | `sar-mot-kpis-main`: push to `main` | `cb-deploy-nonprod` | lint + unit tests (unstamped) → stamp → **dev**: db load, integration apply/assert, debug mask, KVMs, proxy deploy, runtime-SA check, Newman, and on failure roll back the proxy, then the integration → **staging**: the same, promoting the dev revision → summary |
| `cloudbuild-infra.yaml` | `sar-mot-kpis-infra-nonprod`: manual + approval | `cb-deploy-nonprod` | `infra/01..05` for non-prod; refuses any other target |
| `cloudbuild-infra-prod.yaml` | `sar-mot-kpis-infra-prod`: manual + approval | `cb-deploy-prod` | prod foundation: `infra/01..04`, `create-connection.sh prod`, `infra/06` (billable) |
| `cloudbuild-prod.yaml` | `sar-mot-kpis-prod`: manual + approval | `cb-deploy-prod` | promotes the READY staging revision **byte for byte** after the commit check: db load, integration apply, copy revision, KVMs, debug mask, deploy, smoke (`Happy paths`), and rollback on failure |

**None of these triggers exists yet.** The repo has no git remote. The commands are in
DEPLOYMENT.md "CI/CD triggers (not created yet)" and "Prod triggers (NOT RUN)". Merge one PR at a
time: concurrent main builds can roll back each other's deploys (D58).

## Where things are documented

| File | Content |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Rules and fixed facts for any coding agent (Claude Code via `CLAUDE.md`, Antigravity via `.agent/rules/`) |
| [`docs/PLAN.md`](docs/PLAN.md) | Phases P0–P9, acceptance criteria and status |
| [`docs/ERROR-CATALOG.md`](docs/ERROR-CATALOG.md) | Every error case: HTTP status, KVM lookup key, exact message, evaluation order |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Decision log D1–D67, including every VERIFY finding |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Tooling, environments and roles, pipelines, triggers, rollback and manual intervention, prod runbook |
| [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) | One row per catalog case and happy path, with the request and the evidence |
| [`docs/DEMO.md`](docs/DEMO.md) | Demo script (to be recorded by the user) |
| [`docs/PROMPTS.md`](docs/PROMPTS.md) | One agent prompt per phase |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | Historical handoff notes (P0–P3 era). The status table is current; the rest may be stale. |
| [`tests/fault-injection/README.md`](tests/fault-injection/README.md) | Fault-injection procedure for rows 6, 7, 13, 16 |

## Security notes

- No secrets in git, logs or chat. The DB password and the app credentials live only in Secret
  Manager.
- The debug masks (`environments/<env>/debugmask.json`) cover `X-API-Key`, `X-API-Secret`,
  `X-Operator-Id` and every variable that carries the key or the developer email (D37, D41).
- Prod changes only through the approved prod triggers. `cb-deploy-nonprod` holds no role on
  prod. The residual risks are listed in DEPLOYMENT.md "Prod (P8)" (D67).
