# Deployment Guide — SAR MOT KPI Data Sharing POC

This document records the tooling, environment setup, and deployment procedures for the SAR MOT KPI solution.

## Tooling & Prerequisites

### 1. Application Integration Management Toolkit (`integrationcli`)
- **Binary:** `integrationcli`
- **Installed Version:** `integrationcli version 0.86.0 date: 2026-03-13T18:03:59Z [commit: d6fa527]`
- **Repository:** `https://github.com/GoogleCloudPlatform/application-integration-management-toolkit`
- **Installation Path:** `C:\Users\ENVNT.DESKTOP-125116U\tools\integrationcli` (available on system PATH)

### 2. Node.js & Apigee Linting Tools
- **Node.js:** `v24.20.0`
- **npm:** `11.19.0`
- **apigeelint:** `2.85.1` (pinned in `package.json`)
- **newman:** `6.2.3` (pinned in `package.json`)
- **mocha / chai:** unit testing framework for proxy JavaScript policies

### 3. Build & Deployment
- **Maven:** `3.9.9` with `io.apigee.build-tools.enterprise4g:apigee-edge-maven-plugin:2.5.2`
- **Google Cloud SDK:** `583.0.0`

## Environments and roles

### Environments

All resources are in `us-central1`. Names are fixed in AGENTS.md and `infra/env/*.env`.
"Live state" is what has actually run (2026-11-12). `<SHA>` is the short commit SHA that the
pipeline stamps.

| | dev | staging | prod |
|---|---|---|---|
| GCP project / Apigee org | `apigee-nonprod-511322` | `apigee-nonprod-511322` | `apigee-prod-511508` |
| Apigee env / hostname | `dev` / `35.201.86.122.nip.io` | `staging` / `staging.35.201.86.122.nip.io` | `prod` / `prod.35.201.86.122.nip.io` (routing to the prod org is VERIFY 11) |
| Proxy / base path | `sar-mot-kpis-v1` / `/mot-kpis/business-domain/v1` | same revision as dev (promoted) | same bundle as staging (copied, D64) |
| Config / error KVMs | `sar-mot-kpis-config-<SHA>` / `sar-mot-kpis-errors-<SHA>` | same | same (same suffix as the staging stamp) |
| Integration / trigger | `sar-kpi-get-dev` / `api_trigger/sar-kpi-get-dev` | `sar-kpi-get-staging` / `api_trigger/sar-kpi-get-staging` | `sar-kpi-get-prod` / `api_trigger/sar-kpi-get-prod` |
| Connection | `sar-kpi-db-dev` | `sar-kpi-db-staging` | `sar-kpi-db-prod` (created by `scripts/create-connection.sh prod`) |
| Cloud SQL / DB | `sar-kpi-sql-nonprod` / `kpis_dev` | `sar-kpi-sql-nonprod` / `kpis_staging` | `sar-kpi-sql-prod` / `kpis_prod` |
| Endpoint attachment | `sar-kpi-sql-nonprod-ea` (shared by dev and staging) | same | `sar-kpi-sql-prod-ea` |
| Seed bucket | `gs://apigee-nonprod-511322-sar-kpi-seed` | same | `gs://apigee-prod-511508-sar-kpi-seed` |
| Runtime SAs | `sa-kpi-proxy-runtime@apigee-nonprod-511322`, `sa-kpi-connector@apigee-nonprod-511322` | same | `sa-kpi-proxy-runtime@apigee-prod-511508`, `sa-kpi-connector@apigee-prod-511508` |
| API product / apps | `sar-mot-kpis-product` (`/kpis/**`, no verb restriction), `sar-mot-other-product`; apps `mot-poc-app`, `mot-poc-other-app` (`infra/05`) | same products and apps | `sar-mot-kpis-product`; apps `mot-app` (MOT handover) and `mot-smoke-app` (pipeline smoke) (`infra/06`) |
| Rates (config KVM) | SpikeArrest 600pm, quota 1000/min | same | 300pm, 300/min |
| Debug mask | applied by hand (P5, D40) | **not yet**: first `cloudbuild-main.yaml` run | **not yet**: first `cloudbuild-prod.yaml` run |
| Deployed by | `cloudbuild-main.yaml` (and `scripts/fi-*.sh` for fault injection) | `cloudbuild-main.yaml` | `cloudbuild-prod.yaml` only (AGENTS.md rule 2) |
| Newman | full suite (`Happy paths` + `Error rows`), FI folders on demand | full suite | `Happy paths` smoke only (D62) |
| Live state | proxy revision 7, integration and connection live; suite green (D46) | integration and connection live (P4, D30); proxy not yet run through the pipeline | **nothing created**: P8 prod run pending |

### Roles

The build service accounts (`cb-validate`, `cb-deploy-nonprod`, `cb-deploy-prod`) are in
"IAM required per build service account" below. The runtime identities and the people involved:

| Identity | Role(s) | Where granted | Source |
|---|---|---|---|
| `sa-kpi-proxy-runtime@<project>` | `roles/integrations.integrationInvoker` on the project. The proxy deploys with it (`serviceAccount`), and the IntegrationEndpoint calls the integration as this SA. | `infra/02` | D16, D17, D40 |
| Apigee service agent `service-<NUM>@gcp-sa-apigee` | `roles/iam.serviceAccountTokenCreator` on `sa-kpi-proxy-runtime` | `infra/02` | D17 |
| `sa-kpi-connector@<project>` | `roles/secretmanager.secretAccessor` on `sar-kpi-db-reader-password` only; it is the connection's runtime SA | `infra/02`, `infra/03` | D12, D17 |
| Application Integration service agent `service-<NUM>@gcp-sa-integrations` | `roles/connectors.invoker` on the project. It exists only after the Console Quick setup; without it, publish fails with `connectors.connections.get` denied. | `infra/02` (exit 3 if missing) | D28, D50 |
| Cloud SQL instance service account | `roles/storage.objectViewer` on the seed bucket (`gcloud sql import sql`) | `infra/03` | D11 |
| DB user `kpi_reader` | `SELECT` on `kpi_records` only; password only in Secret Manager | `db/migrations/V001…`, `infra/03` | D12 |
| 👤 Infra / release approvers | `roles/cloudbuild.builds.approver` on `ci-cd-511313`. They need no actAs. | by hand (command D for prod) | D58, D67 |
| 👤 Trigger creator | `roles/iam.serviceAccountUser` on the `cb-*` SA it attaches. For `cb-deploy-prod` this is **temporary**: removed by command E right after the prod triggers exist. | by hand | D67 |
| 👤 Prod admin | Runs commands A, B and F, the Quick setup in prod, and Console-only rollbacks in prod. The only human who changes prod. | by hand | D59, D66 |
| 👤 Non-prod admin | Runs command C (read-only custom role `sarKpiPromotionReader` for `cb-deploy-prod`) and approves non-prod billable or destructive actions | by hand | D60 |
| 👤 Credential custodian | `roles/secretmanager.secretAccessor` on `sar-mot-app-api-key` / `-secret`; hands them to MOT out of band | by hand | D63 |

## Apigee environment settings

### Debug masks (AGENTS.md rule 4)

- Source of truth: `src/main/apigee/environments/<env>/debugmask.json` (local, dev, staging, prod).
- Applied with:
  `PATCH https://apigee.googleapis.com/v1/organizations/<org>/environments/<env>/debugmask?updateMask=variables`
  with the body `{"variables": [...]}` taken from that file.
- Dev was applied by hand this way in P5 and verified in a debug session (D40). The call is now
  automated: `scripts/deploy-debugmask.sh <dev|staging>` (step `debugmask-<env>` in
  `cloudbuild-main.yaml`) and `scripts/deploy-debugmask-prod.sh` (step `debugmask-prod` in
  `cloudbuild-prod.yaml`) run it before every proxy deploy. Staging and prod are still **unmasked**
  until the first run of those pipelines, which is pending user action. Do not start a debug session
  on staging before then.

### Debug sessions via REST

- The create `POST .../debugsessions` needs `Content-Length: 0` (otherwise HTML 411).
- Data appears about 15 s or more after the session is created; `GET .../debugsessions/{id}/data`
  lists the transaction ids (D35).

## CI/CD pipelines (P7)

| File | Trigger | Service account | What it does |
|---|---|---|---|
| `cloudbuild-pr.yaml` | pull request to `main` | `cb-validate` (no cloud access) | `npm ci` → apigeelint → unit tests → OAS lint (`@redocly/cli@1.34.24` via `npx`) → collection `--check` → Maven package |
| `cloudbuild-main.yaml` | push to `main` | `cb-deploy-nonprod` | lint + unit tests (unstamped) → stamp → dev (db load, integration apply/assert, debug mask, KVMs, proxy deploy, runtime-SA check, Newman, rollback proxy then integration on failure) → staging (same, promoting the dev proxy revision) → summary |
| `cloudbuild-infra.yaml` | manual, approval required | `cb-deploy-nonprod` | `infra/01..05` with `infra/env/nonprod.env`; refuses any `_TARGET` other than `nonprod` |

**Rollback on a failed proxy phase.** This covers a failed deploy/promote, a deployment that never becomes READY, a wrong or missing runtime SA, or a failed Newman run (D54). The build runs `scripts/rollback.sh` (proxy) **then** `scripts/rollback-integration.sh` (integration). It then records the integration version again, because the restored version gets a new id (D29).

**Integration failures.** A failed integration apply or post-apply assertion rolls back only the integration and stops before the proxy.

**Database.** It is never rolled back (expand-only, AGENTS.md rule 9). Rule 9 covers the database only; nothing guarantees that a new integration works with the old proxy.

**Hard failures between the integration publish and the proxy deploy.** If `token-proxy-*`, `debugmask-*`, `record-prev-*` or `create-kvm-*` fails, the new integration is left live, so roll it back by hand with `scripts/rollback-integration.sh` (D54). Details: D48–D58.

**Running the main pipeline.** It runs only from its trigger. With `gcloud builds submit`, `SHORT_SHA` is empty and `stamp-commit.sh` exits 2 before any cloud call. For a manual run use `gcloud builds triggers run sar-mot-kpis-main --branch=main --region=us-central1 --project=ci-cd-511313` (D58).

**Known POC risks (D58):**
- **Concurrent builds.** Two quick merges can run concurrently against dev/staging. One build's rollback can revert the other's deploy, and both import into the same Cloud SQL instance. **Merge one PR at a time.**
- **Debug mask.** The debug-mask PATCH (`updateMask=variables`) appends, so a variable removed from `debugmask.json` stays masked in the environment.
- **Floating image.** `node:22` is a floating tag; pinning `node:22-bookworm` or a digest is open.
- **Connections.** A changed connection needs a manual or infra run: the pipeline applies integrations with `--skip-connectors=true`.

### CI/CD triggers (not created yet)

**NOT RUN.** These commands have not been executed. Prerequisites (👤):

1. The local repository has **no git remote**. Create the GitHub repository `apigee-poc/sar-mot-kpis`,
   then `git remote add origin https://github.com/apigee-poc/sar-mot-kpis.git` and push `main`.
2. A Cloud Build GitHub connection (2nd gen) in `ci-cd-511313` / `us-central1` with the Cloud Build
   GitHub App installed on `apigee-poc`. Below it is called `github-apigee-poc`; use the existing
   connection name if `cicd-workspace` already has one (`gcloud builds connections list
   --project=ci-cd-511313 --region=us-central1`).
3. The IAM below.

```bash
PROJECT=ci-cd-511313
REGION=us-central1
CONN=github-apigee-poc
REPO="projects/${PROJECT}/locations/${REGION}/connections/${CONN}/repositories/sar-mot-kpis"

# Link the GitHub repository to the connection
gcloud builds repositories create sar-mot-kpis \
  --remote-uri=https://github.com/apigee-poc/sar-mot-kpis.git \
  --connection="${CONN}" --region="${REGION}" --project="${PROJECT}" --quiet

# 1. PR validation (no cloud access)
gcloud builds triggers create github \
  --name=sar-mot-kpis-pr \
  --description="SAR MOT KPIs: validate pull requests to main" \
  --repository="${REPO}" \
  --pull-request-pattern='^main$' \
  --comment-control=COMMENTS_ENABLED_FOR_EXTERNAL_CONTRIBUTORS_ONLY \
  --build-config=cloudbuild-pr.yaml \
  --service-account="projects/${PROJECT}/serviceAccounts/cb-validate@${PROJECT}.iam.gserviceaccount.com" \
  --include-logs-with-status \
  --region="${REGION}" --project="${PROJECT}" --quiet

# 2. Release to dev and staging on every push to main
gcloud builds triggers create github \
  --name=sar-mot-kpis-main \
  --description="SAR MOT KPIs: deploy main to dev, then staging" \
  --repository="${REPO}" \
  --branch-pattern='^main$' \
  --build-config=cloudbuild-main.yaml \
  --service-account="projects/${PROJECT}/serviceAccounts/cb-deploy-nonprod@${PROJECT}.iam.gserviceaccount.com" \
  --include-logs-with-status \
  --region="${REGION}" --project="${PROJECT}" --quiet

# 3. Non-prod foundation: manual, with approval (creates billable resources)
gcloud builds triggers create manual \
  --name=sar-mot-kpis-infra-nonprod \
  --repository="${REPO}" \
  --branch=main \
  --build-config=cloudbuild-infra.yaml \
  --substitutions=_TARGET=nonprod \
  --service-account="projects/${PROJECT}/serviceAccounts/cb-deploy-nonprod@${PROJECT}.iam.gserviceaccount.com" \
  --require-approval \
  --region="${REGION}" --project="${PROJECT}" --quiet
```

Notes on these commands:
- **`--include-logs-with-status` is VERIFY.** It is unclear whether it works with `CLOUD_LOGGING_ONLY` and a user-specified SA on a 2nd-gen repo. If the trigger creation or the GitHub check run fails, drop the flag (D58).
- **Approvals.** Whoever approves `sar-mot-kpis-infra-nonprod` builds needs `roles/cloudbuild.builds.approver` on `ci-cd-511313`.
- **Prod triggers.** Both prod pipelines get their own approved manual triggers running as `cb-deploy-prod`: `cloudbuild-prod.yaml` (promotion) and `cloudbuild-infra-prod.yaml` (foundation, D55). The commands are in "Prod (P8)" below. `cloudbuild-infra.yaml` refuses any `_TARGET` other than `nonprod`.
- **Prod guard (D58).** The YAML guard is defence in depth; the real control is IAM. `cb-deploy-nonprod` must have **no role on `apigee-prod-511508`**, because a manual trigger can be run on a branch whose YAML or env file was edited.

### IAM required per build service account

All builds use `options.logging: CLOUD_LOGGING_ONLY`, so every `cb-*` account needs
`roles/logging.logWriter` on `ci-cd-511313`. The trigger creator needs `roles/iam.serviceAccountUser`
on the `cb-*` account it attaches.

| Account | Needs | Source |
|---|---|---|
| `cb-validate` | `roles/logging.logWriter` (ci-cd-511313) only. No Apigee, Integration, SQL or Secret Manager access: the PR build only reads the repo and the public npm/Maven registries. | cicd-workspace |
| `cb-deploy-nonprod` | On `apigee-nonprod-511322`: `roles/apigee.apiAdminV2` and `roles/apigee.environmentAdmin` (proxy import/deploy, KVMs, debug mask: VERIFY the debugmask PATCH permission on the first run); `roles/integrations.integrationAdmin` (apply, test, publish, rollback); `roles/connectors.admin`; `roles/cloudsql.admin` (`gcloud sql import sql`); `roles/storage.objectAdmin` on `gs://apigee-nonprod-511322-sar-kpi-seed`; `roles/iam.serviceAccountUser` on `sa-kpi-proxy-runtime` and `sa-kpi-connector` (deploy with the runtime SA); `roles/secretmanager.secretAccessor` on the four secrets `sar-mot-poc-app-api-key`, `sar-mot-poc-app-api-secret`, `sar-mot-poc-other-app-api-key`, `sar-mot-poc-other-app-api-secret` (Newman). For `cloudbuild-infra.yaml` it also needs to enable APIs, create service accounts, set IAM policy, create Cloud SQL / PSC resources and secrets (`roles/serviceusage.serviceUsageAdmin`, `roles/iam.serviceAccountAdmin`, `roles/resourcemanager.projectIamAdmin`, `roles/compute.networkAdmin`, `roles/secretmanager.admin`), or a human runs `infra/` once. On `ci-cd-511313`: `roles/logging.logWriter`. | D17, D28, infra/02 (steps 5–8), cicd-workspace DEPLOYMENT |
| `cb-deploy-prod` | On `apigee-prod-511508`: the bootstrap roles (a human grants these), then what `infra/02` and `infra/06` grant. On `apigee-nonprod-511322`: **read-only** access to the staging deployments and revisions, through a custom role (D60). On `ci-cd-511313`: `roles/logging.logWriter`. Full list and commands: "Prod (P8)" below. | D59–D63 |

**Where the roles come from:**
- **Apigee roles:** from cicd-workspace.
- **Integration, Connectors, Cloud SQL, bucket and runtime-SA grants:** applied by `infra/02-service-accounts-iam.sh`.
- **Newman secret access:**
  - `infra/05-apigee-products-apps.sh` creates the four secrets and grants `cb-deploy-nonprod` access to them itself, so one fresh `infra/01..05` run is enough (D56).
  - `infra/02` also grants access on secrets that already exist.
  - **If the secrets were created some other way, or later, re-run `infra/02` or `infra/05` before the first main build.** Otherwise `test-dev` gets a 403 reading them, and dev is rolled back.

**`infra/02` exits 3** (the infra build then stops before 03–05; fix the cause and re-run, since every script is idempotent) when:
- the Application Integration service agent is missing (Quick setup, D28; the agent needs `roles/connectors.invoker`), or
- the IAM policy or a Newman secret cannot be read (permission/API error, reported as such, D56).

## Rollback and manual intervention (dev and staging)

This section covers `cloudbuild-main.yaml` and the shared rollback scripts. For prod, see
"Rollback behaviour and manual intervention" under "Prod (P8)" below. The mechanism is the same,
but prod manual steps are **Console only**.

### What the pipeline rolls back automatically (per environment)

| Failure | Step that handles it | Result |
|---|---|---|
| `db-load-<env>`, `token*`, `install-integrationcli`, `record-prev-int-<env>` | none: the build stops | Nothing in that environment was changed. The database is expand-only. |
| Integration apply or post-apply assertion | `check-int-<env>` | Rolls back **only the integration**. It is skipped if the ACTIVE version is still the previous one. The proxy is untouched; exit 1. |
| Proxy deploy/promote, `wait-<env>`, `verify-sa-<env>`, Newman `test-<env>` | `check-<env>-test` | `scripts/rollback.sh` (proxy: redeploy the previous revision, or undeploy the failed one if there was none), **then** `scripts/rollback-integration.sh`, then the restored integration id is re-read (D29); exit 1 (D54). |
| Dev fails | as above | Staging is never touched. |
| Staging fails | as above, on staging | Dev keeps the new commit, which passed dev. Staging returns to its previous revision and version. |

### How the integration rollback works (`scripts/rollback-integration.sh`, D25, D29)

1. GET the previous version and strip the output-only fields.
2. POST its content as a **new DRAFT version** (log: `Creating a new DRAFT version from version <prev>...`).
3. Publish that draft (log: `Publishing restored version <id>...`).
4. Poll every 5 s, for up to 300 s, until it is ACTIVE. The restored version gets a **new id**,
   which the pipeline records again in `int_<env>_after_rollback.txt`.

If there is no previous version, it unpublishes the failed version and checks that it is no longer
ACTIVE. Nothing is ever deleted (AGENTS.md rule 3).

**Known gaps (deferred from P7, noted here as planned):**

- **Orphan DRAFT after a failed restore.** If step 2 succeeds but the publish (3) or the ACTIVE
  wait (4) fails, the new version stays behind as a DRAFT, or as a version that is not yet ACTIVE.
  Its id is in the `Publishing restored version <id>` log line. The script then unpublishes the
  failed version as a safety net and exits non-zero ("manual intervention required"). So the
  integration can be left with **no ACTIVE version**. Expect the rolled-back proxy to answer every
  valid request with 500 (catalog row 13) until a person publishes a version. Fix:
  1. In the Console (Application Integration → `sar-kpi-get-<env>` → versions), or with
     `integrationcli`, check the version list.
  2. Publish the orphan draft (it has the previous content) or a copy of the previous version.
  3. Confirm that exactly one version is ACTIVE with the expected `userLabel`.
  4. Run `bash tests/run-newman.sh <env> --folder "Happy paths"`.
  Leftover drafts are harmless. Delete them only by hand, with approval.
- **Polling noise.** If the version read fails during the ACTIVE wait, the poll loop prints the
  API error every 5 s. Only the final `did not reach ACTIVE within 300s` line means failure.
- A missing `kpiCode` would become the literal `"undefined"` in `JS-BuildConnectorInput`. The proxy
  always sets it (`AM-SetKpiCode`), so this cannot happen through the API.

### Cases that need a person

In non-prod, a person may run the scripts from a workstation with the values from the build log.
Every deploy, undeploy or unpublish is an approval step (AGENTS.md rule 3). The recorded values are
in the logs of `record-prev-int-<env>` / `record-prev-<env>` (`Currently active revision in
<env>: …`), in `apply-int-<env>` / `assert-int-<env>`, and in the rollback messages. `summary` runs
only on success.

| Situation | Log signature | What is live | What to do |
|---|---|---|---|
| Proxy rollback failed | `Proxy rollback FAILED: manual intervention required.` | The failed revision, or nothing | `bash scripts/rollback.sh apigee-nonprod-511322 <env> sar-mot-kpis-v1 <prev_revision> <failed_revision>`, or redeploy the previous revision with `scripts/deploy-revision.sh … <rev>` (it passes the runtime SA) |
| Integration rollback failed | `Integration rollback FAILED: manual intervention required.` | Possibly no ACTIVE version (orphan DRAFT above) | Fix as for the orphan DRAFT, or re-run `bash scripts/rollback-integration.sh apigee-nonprod-511322 us-central1 sar-kpi-get-<env> <prev_version> <failed_version>` |
| Hard failure after the integration publish and before the proxy deploy: `token-proxy-<env>`, `debugmask-<env>`, `record-prev-<env>`, `create-kvm-<env>` (D54(b)) | the step fails and the build stops | The **new** integration with the **old** proxy; this pair is not guaranteed to be compatible | `bash scripts/rollback-integration.sh apigee-nonprod-511322 us-central1 sar-kpi-get-<env> <prev_int> <new_int>` |
| Build TIMEOUT, CANCELLED, or a Cloud Build failure after the publish | build status, not a script message | The new integration, and maybe the new proxy revision, with no test verdict | Both rollbacks by hand, proxy first, then the integration |
| Two main builds at once (D58) | two overlapping `sar-mot-kpis-main` builds | Whichever deploy or rollback ran last | Wait for both builds to finish, then re-run `sar-mot-kpis-main` on the latest `main`. Merge one PR at a time. |
| `scripts/fi-restore.sh` failed after fault injection (D46) | the `fi-restore.sh` recovery hint | A scratch revision with a broken config on dev | Re-run `bash scripts/fi-restore.sh`. If it refuses because the state is stale, redeploy the baseline revision from `.fi-state/` with `scripts/deploy-revision.sh`. Scratch revisions and KVMs stay listed in `.fi-state/history.log`. |
| A changed connection definition | — | The old connection: the pipeline applies with `--skip-connectors=true` | Apply the connection by hand (P3 procedure) or with an infra run |
| Bad data or schema | — | The database is **never** rolled back (rule 9) | Fix forward with a new expand-only migration or seed that still works with the previous proxy and integration |

## Prod (P8)

**Status: files only, NOT RUN.** Nothing in this section has been executed. Under AGENTS.md
rule 2, no agent and no workstation command changes `apigee-prod-511508`. Prod changes only through
the two prod pipelines, which run on Cloud Build with manual approval. The steps marked 👤
are the only exceptions: one-time bootstrap and verification steps that a **human prod admin**
runs from the Console or Cloud Shell. Agents never run them.

| File | Trigger | Service account | What it does |
|---|---|---|---|
| `cloudbuild-infra-prod.yaml` | `sar-mot-kpis-infra-prod`: manual, approval required | `cb-deploy-prod` | guard (`_TARGET=prod`, `TRIGGER_NAME`) → integrationcli → `infra/01`, `02` (exit 3 is deferred to the last step), `03` (Cloud SQL, **billable**), `04` (PSC endpoint attachment, **billable**) → `scripts/create-connection.sh prod` → `infra/06` (product and apps) → `check-infra-02` |
| `cloudbuild-prod.yaml` | `sar-mot-kpis-prod`: manual, approval required | `cb-deploy-prod` | guard (pins all 7 substitutions and `TRIGGER_NAME`; needs `SHORT_SHA`/`COMMIT_SHA`) → find the READY staging revision → `check-release-commit.sh` (the stamp must equal this build's commit) → record the previous prod revision and integration → `db/load.sh prod` → integration apply/assert (rolls back only the integration on failure) → `copy-revision` staging → prod (byte for byte; no stamp, no Maven; the imported prod revision is read back and its description compared) → versioned prod KVMs (same commit suffix) → debug mask → deploy with `sa-kpi-proxy-runtime@apigee-prod-511508` → wait → runtime-SA check → smoke (`Happy paths`) → `check-prod` (on failure: proxy, then integration) → summary |

Design and reasons: D59 (guard), D60 (read access to non-prod), D61 (tenant and endpoint IP
resolved at runtime), D62 (smoke subset), D63 (product, apps, secrets), D64 (commit check), D65 (helper
scripts are copies), D66 (rollback), D67 (final-review fixes and the residual risks below).

**Residual risks accepted for the POC (D67), read before you approve anything:**

- **The prod build SA is powerful.** `cb-deploy-prod` keeps the bootstrap roles of command A
  (`projectIamAdmin`, `iam.serviceAccountAdmin`, `secretmanager.admin`, `storage.admin`, …) and
  `roles/apigee.developerAdmin`, and it also runs every release build. `projectIamAdmin` alone lets
  it grant itself any role. So any commit promoted through `cloudbuild-prod.yaml` runs with these
  rights. Follow-ups: a separate infra SA (`cb-infra-prod`) for `cloudbuild-infra-prod.yaml`, and a
  release SA with only `apiAdminV2`, `environmentAdmin`, `integrationAdmin`, `cloudsql` import and the
  smoke secrets.
- **It can read the MOT handover credentials.** No direct grant is made on
  `sar-mot-app-api-key`/`-secret`, but `developerAdmin` (a developer-app GET returns
  `consumerKey`/`consumerSecret`) and `secretmanager.admin` (includes `versions.access` on every
  secret) both expose them while `cb-deploy-prod` holds those roles.
- **Only IAM stops an unapproved prod build.** Approval applies to triggers only. Anyone with
  `iam.serviceAccountUser` (actAs) on `cb-deploy-prod` plus `cloudbuild.builds.create` on
  `ci-cd-511313` can `gcloud builds submit --service-account=…cb-deploy-prod…` with any config and no
  approval. The `TRIGGER_NAME`/`SHORT_SHA` checks in the guards stop a mistaken `builds submit` of
  the committed files, not a deliberate one: Cloud Build lets the submitter supply `TRIGGER_NAME`,
  `COMMIT_SHA` and `SHORT_SHA`, and can bring its own config. So the actAs grant for the trigger
  creator is **temporary** (commands D, E, F).
- **"Staging passed" is checked by the approver, not the pipeline** (D64(4)). Follow-up: read the
  build id from the stamp and require that Cloud Build build to be `SUCCESS` for this `COMMIT_SHA`
  (needs `roles/cloudbuild.builds.viewer` for `cb-deploy-prod` on `ci-cd-511313`).
- **A timeout, cancel or Cloud Build failure after the integration publish is not rolled back**
  (see "Rollback behaviour").

### Prerequisites (👤, before the first prod run)

1. **The commit you promote must contain P8.** `cloudbuild-prod.yaml` builds the commit it runs
   on: the pipeline file, `integration/prod/`, `db/` and `infra/env/prod.env` all come from that
   commit. A commit from before P8 cannot be promoted. So P8 must be merged to `main`, pushed,
   and taken green to staging by `cloudbuild-main.yaml` (the P7 triggers above) before the first
   promotion.
2. **Application Integration Quick setup** in the Console for `apigee-prod-511508` / `us-central1`
   (D28). It creates the integrations service agent and provisions the Connectors runtime, which
   `infra/02` (`connectors.invoker`), `infra/04` (tenant resolution) and `create-connection.sh`
   all need.
3. **`MOT_DEVELOPER_EMAIL`** (D63). No pipeline step passes it in `env:`, so setting it in the build
   environment does nothing. The only route is to edit the `MOT_DEVELOPER_EMAIL` line in
   `infra/env/prod.env`, then commit and push it to `main` **before** the first infra-prod run.
   If you change it after a run, `infra/06` creates a second developer and a second `mot-app`, and
   the existing secrets keep the first app's credentials, because a secret that already has a
   version is never overwritten. Decide the D41 question at the same time (see D63): either the
   email is recorded as not sensitive, or the rate identifier is hashed.
   `infra/06` **refuses** an `@example.com` address such as the placeholder (exit 1, before any
   call; D67). The refusal happens late in the infra-prod run, after the billable Cloud SQL
   instance, the endpoint attachment and the connection exist; fix the email and re-run (every
   script is idempotent, and since the D67 fix `infra/03` no longer rotates the DB password on a
   re-run). For a throw-away demo only, commit `ALLOW_PLACEHOLDER_MOT_EMAIL="1"` to
   `infra/env/prod.env`; no pipeline step passes environment variables through, so that is the
   only way to set it.
4. **Bootstrap roles for `cb-deploy-prod` on `apigee-prod-511508`.** This is chicken and egg:
   `infra/02` cannot grant `cb-deploy-prod` the roles it needs to run `infra/02` itself. **Required:**
   `roles/serviceusage.serviceUsageAdmin` (infra/01), `roles/iam.serviceAccountAdmin` (create the
   runtime SAs and set their IAM), `roles/resourcemanager.projectIamAdmin` (project bindings),
   `roles/secretmanager.admin` (DB and app secrets and their IAM), `roles/storage.admin` (seed
   bucket and its IAM). **Recommended as well:** `roles/cloudsql.admin`, `roles/connectors.admin`,
   `roles/integrations.integrationAdmin`, `roles/apigee.apiAdminV2`,
   `roles/apigee.environmentAdmin` and `roles/apigee.developerAdmin`. `infra/02` grants these too,
   idempotently, but `infra/03` and `infra/06` run minutes after it, and a grant may not have
   propagated by then. **VERIFY:** `roles/compute.networkAdmin` is in the non-prod list above, but no
   infra script calls the Compute API (Cloud SQL PSC is `cloudsql.admin`, the endpoint attachment is
   `connectors.admin`). Grant it only if infra/03 or infra/04 fails on a `compute.*` permission.
   Command A below.
5. **`cb-deploy-nonprod` has no role on `apigee-prod-511508`** (D58, D59). This is the real prod
   guard. Command B below must print nothing. Also check in the Console (IAM → Policy Analyzer)
   that it has no resource-level binding (service account, secret, bucket) in the prod project.
6. **Read-only access for `cb-deploy-prod` to the staging proxy in `apigee-nonprod-511322`**
   (D60, supersedes D55). The promotion has to list the staging deployment
   (`apigee.deployments.list`), read the revision's deployment state (`apigee.deployments.get`),
   and read and export the revision (`apigee.proxyrevisions.get`). Use the custom role in command C.
   **Do not** use `roles/apigee.readOnlyAdmin` unless you accept the exposure: it is "Viewer of all
   apigee resources", which includes developer apps, whose GET returns the non-prod test apps'
   consumer keys and secrets.
7. **Cloud Build access on `ci-cd-511313`.**
   - `cb-deploy-prod` has `roles/logging.logWriter` (both prod pipelines use `CLOUD_LOGGING_ONLY`).
   - The person who creates the triggers has `roles/iam.serviceAccountUser` on `cb-deploy-prod`
     **only while creating them**. Remove it right after (command E, below the trigger commands),
     then check that nobody else holds actAs on `cb-deploy-prod` (command F). Anyone who keeps it
     can run an unapproved prod build with `gcloud builds submit` (D67). Alternatively, a prod
     admin who already must hold actAs creates the triggers.
   - Every approver has `roles/cloudbuild.builds.approver`. Approvers need **no** actAs.
   - **VERIFY:** that `gcloud builds triggers run` needs only `cloudbuild.builds.create` (the
     Cloud Build IAM page maps `triggers.run` to it) and not actAs on the trigger's SA. If a run
     is refused after command E, grant `serviceAccountUser` to the runner for the run only, then
     remove it again with command E.
   Command D below.

Commands A–F are **NOT RUN**. A human prod admin (A, B), non-prod admin (C) or CI/CD admin (D, E, F) runs them in Cloud Shell or the Console. E and F follow the trigger commands below.

```bash
PROD=apigee-prod-511508
NONPROD=apigee-nonprod-511322
CICD=ci-cd-511313
CB_PROD="cb-deploy-prod@${CICD}.iam.gserviceaccount.com"

# A. 👤 Bootstrap roles for cb-deploy-prod on the prod project (required, then recommended)
for ROLE in roles/serviceusage.serviceUsageAdmin roles/iam.serviceAccountAdmin \
            roles/resourcemanager.projectIamAdmin roles/secretmanager.admin roles/storage.admin \
            roles/cloudsql.admin roles/connectors.admin roles/integrations.integrationAdmin \
            roles/apigee.apiAdminV2 roles/apigee.environmentAdmin roles/apigee.developerAdmin; do
  gcloud projects add-iam-policy-binding "${PROD}" \
    --member="serviceAccount:${CB_PROD}" --role="${ROLE}" --condition=None --quiet
done

# B. 👤 cb-deploy-nonprod must hold NO project-level role on prod: expect empty output
gcloud projects get-iam-policy "${PROD}" \
  --flatten="bindings[].members" \
  --filter="bindings.members:serviceAccount:cb-deploy-nonprod@${CICD}.iam.gserviceaccount.com" \
  --format="value(bindings.role)"

# C. 👤 Read-only staging access for cb-deploy-prod on the NON-PROD org (D60; needs approval)
gcloud iam roles create sarKpiPromotionReader --project="${NONPROD}" \
  --title="SAR KPI promotion reader" \
  --description="Read staging proxy deployments and revisions for the prod promotion (P8, D60)" \
  --permissions=apigee.deployments.list,apigee.deployments.get,apigee.proxyrevisions.get \
  --stage=GA --quiet
gcloud projects add-iam-policy-binding "${NONPROD}" \
  --member="serviceAccount:${CB_PROD}" \
  --role="projects/${NONPROD}/roles/sarKpiPromotionReader" --condition=None --quiet

# D. 👤 Cloud Build project: log writer, trigger creator (TEMPORARY: removed by command E right
#    after the prod triggers exist), approvers
gcloud projects add-iam-policy-binding "${CICD}" \
  --member="serviceAccount:${CB_PROD}" --role=roles/logging.logWriter --condition=None --quiet
gcloud iam service-accounts add-iam-policy-binding "${CB_PROD}" --project="${CICD}" \
  --member="user:<TRIGGER_CREATOR_EMAIL>" --role=roles/iam.serviceAccountUser --quiet
gcloud projects add-iam-policy-binding "${CICD}" \
  --member="user:<APPROVER_EMAIL>" --role=roles/cloudbuild.builds.approver --condition=None --quiet
```

**VERIFY (command C):** each permission is documented on its method (`deployments.list` for
`environments.apis.deployments.list`, `deployments.get` for
`environments.apis.revisions.deployments.get`, `proxyrevisions.get` for `apis.revisions.get`,
including `?format=bundle`; D60). Not checked: whether all three may be used in a custom role. If
role creation refuses one, fall back to `roles/apigee.readOnlyAdmin` **with the exposure noted above**,
and record that in DECISIONS.

### Prod triggers (NOT RUN)

These use the same `REPO` as the P7 trigger block above. Both triggers have `--require-approval`.
**Do not pass `--substitutions`:** both pipelines refuse any value other than their file defaults.

```bash
PROJECT=ci-cd-511313
REGION=us-central1
CONN=github-apigee-poc
REPO="projects/${PROJECT}/locations/${REGION}/connections/${CONN}/repositories/sar-mot-kpis"

# 4. Prod foundation: manual, with approval (creates billable resources)
gcloud builds triggers create manual \
  --name=sar-mot-kpis-infra-prod \
  --description="SAR MOT KPIs: prod foundation (billable; approval required)" \
  --repository="${REPO}" \
  --branch=main \
  --build-config=cloudbuild-infra-prod.yaml \
  --service-account="projects/${PROJECT}/serviceAccounts/cb-deploy-prod@${PROJECT}.iam.gserviceaccount.com" \
  --require-approval \
  --region="${REGION}" --project="${PROJECT}" --quiet

# 5. Prod release: manual, with approval (promotes the READY staging revision byte for byte)
gcloud builds triggers create manual \
  --name=sar-mot-kpis-prod \
  --description="SAR MOT KPIs: promote the staging revision to prod (approval required)" \
  --repository="${REPO}" \
  --branch=main \
  --build-config=cloudbuild-prod.yaml \
  --service-account="projects/${PROJECT}/serviceAccounts/cb-deploy-prod@${PROJECT}.iam.gserviceaccount.com" \
  --require-approval \
  --region="${REGION}" --project="${PROJECT}" --quiet

# E. 👤 Right after 4 and 5: remove the trigger creator's TEMPORARY actAs on cb-deploy-prod
#    (an IAM removal: a human runs it on purpose; AGENTS.md rule 3)
gcloud iam service-accounts remove-iam-policy-binding \
  "cb-deploy-prod@${PROJECT}.iam.gserviceaccount.com" --project="${PROJECT}" \
  --member="user:<TRIGGER_CREATOR_EMAIL>" --role=roles/iam.serviceAccountUser --quiet

# F. 👤 Who can still act as cb-deploy-prod? Expect NO user/group in serviceAccountUser or
#    serviceAccountTokenCreator, except prod admins who must hold it (record them). Also check the
#    project-level grants of those two roles on ci-cd-511313 (they cover every SA there).
gcloud iam service-accounts get-iam-policy \
  "cb-deploy-prod@${PROJECT}.iam.gserviceaccount.com" --project="${PROJECT}" \
  --format="table(bindings.role,bindings.members)"
gcloud projects get-iam-policy "${PROJECT}" --flatten="bindings[].members" \
  --filter="bindings.role:(roles/iam.serviceAccountUser OR roles/iam.serviceAccountTokenCreator)" \
  --format="table(bindings.role,bindings.members)"
```

Both guards also pin `TRIGGER_NAME` (`sar-mot-kpis-infra-prod` / `sar-mot-kpis-prod`): a plain
`gcloud builds submit` of the committed files leaves it empty and is refused before any cloud
call. That is **mistake-proofing only** (D67): Cloud Build lets a submitter set `TRIGGER_NAME`,
`COMMIT_SHA` and `SHORT_SHA` with `--substitutions`, or bring its own config. Commands E and F are
the control.

The flags `--require-approval`, `--repository` (2nd gen, which needs an explicit `--region`),
`--branch`, `--build-config` and `--service-account` on `triggers create manual`, and `--sha` on
`triggers run`, were checked against the current gcloud reference (D64). Still VERIFY on the first
run: that a manual or `--sha` run sets `SHORT_SHA`, `COMMIT_SHA` and `TRIGGER_NAME`. If it does not, `guard-target`
refuses the run and nothing is touched.

### Run order

1. Prerequisites 1–7, the two prod triggers, then commands E and F (remove the temporary actAs).
2. Run `sar-mot-kpis-infra-prod` and approve it (**billable**: Cloud SQL `sar-kpi-sql-prod`
   `db-custom-1-3840` and the PSC endpoint attachment `sar-kpi-sql-prod-ea`):
   `gcloud builds triggers run sar-mot-kpis-infra-prod --branch=main --region=us-central1 --project=ci-cd-511313`.
   Approve it in the Console (Cloud Build → History → the build → **Approve**).
   - If `check-infra-02` fails (infra/02 exit 3: the Quick setup is missing or something was not readable), fix the cause and run the trigger again. Every script is idempotent. Since D67, `infra/03` keeps the existing DB password on a re-run (before, every run added a new secret version and changed the password, while `sar-kpi-db-prod` stays pinned to the version it was created with) and stops if it cannot list the secret's versions.
   - `infra/02` runs before `infra/03` creates the DB secret, so the metadata-only `secretmanager.viewer` grant on `sar-kpi-db-reader-password` lands only on a **second** run. The first `create-connection` works without it, because it relies on `secretmanager.admin`. Run the trigger a second time before you remove `secretmanager.admin` from `cb-deploy-prod`.
   - From the build log, note the Connectors tenant project (infra/04), the endpoint attachment IP (`ACCEPTED`), and the connection `sar-kpi-db-prod` (`ACTIVE`).
3. Confirm the staging build for the commit is green (next section).
4. Run `sar-mot-kpis-prod` **at that commit** and approve it:
   `gcloud builds triggers run sar-mot-kpis-prod --sha=<40-hex COMMIT_SHA> --region=us-central1 --project=ci-cd-511313`.
   `--branch=main` also works, but only while `main`'s HEAD is still the commit in staging.
5. Check the `summary` step: commit, source revision and description, and the prod revision and integration version before and after.
6. Hand over the `mot-app` credentials (below).

### Before approving `sar-mot-kpis-prod`: is the commit green in staging?

The pipeline's `check-commit` proves only one thing: the revision that is **READY in staging** carries this build's commit
stamp, so prod gets exactly that bundle. It does **not** prove that staging *passed*. If the
staging Newman run failed and its rollback also failed ("manual intervention", exit 1), the failed
revision can stay READY in staging with this commit's stamp. **The approver is the only control
for this case.** Approve only if:

- the **most recent** `sar-mot-kpis-main` build has status `SUCCESS`;
- its `COMMIT_SHA` is the commit you are promoting;
- no `sar-mot-kpis-main` build is running (`--ongoing`).

```bash
gcloud builds list --region=us-central1 --project=ci-cd-511313 --limit=5 \
  --filter='substitutions.TRIGGER_NAME="sar-mot-kpis-main"' \
  --format="table(id,status,substitutions.COMMIT_SHA,createTime)"
gcloud builds list --region=us-central1 --project=ci-cd-511313 --ongoing
```

The `substitutions.TRIGGER_NAME` filter is **VERIFY**. If it returns nothing, use the Console
instead: Cloud Build → History, filter by trigger `sar-mot-kpis-main`. Then check the pending
`sar-mot-kpis-prod` build: its `COMMIT_SHA` must be the same commit. If they differ, the pipeline
stops by itself at `check-commit`, before prod is touched.

**Follow-up (D67, review M4):** the stamp already names the staging build (`… | build <id>`).
`check-release-commit.sh` could GET that Cloud Build build and require `status == SUCCESS` and
`substitutions.COMMIT_SHA` = this commit, failing closed. It needs
`roles/cloudbuild.builds.viewer` for `cb-deploy-prod` on `ci-cd-511313`. Until then the approver
check above is the only control; it would stay as a second control afterwards.

### Rollback behaviour and manual intervention

- **Before any prod change** (guard, find-staging-revision, check-commit, record-prev-*): a
  failure stops the build. Nothing in prod was changed.
- **`db-load-prod`**: the first prod change. It is expand-only and **never rolled back** (rule 9).
  A failure stops the build, and the prod proxy and integration are untouched.
- **Integration apply or assert fails**: `check-int-prod` rolls back only the integration. It
  restores the previous content as a new version (D25, D29), or unpublishes if there was none. The
  proxy is not touched. Exit 1.
- **Any later step fails** (token, copy-revision, KVMs, debug mask, deploy, wait, runtime-SA check,
  smoke): `check-prod` rolls back the **proxy first** (only if a deploy was requested,
  `prod_proxy_touched`), **then** the integration. Exit 1.
- **First prod run** (nothing deployed before): the previous revision and version are empty, so a
  failure **undeploys** the new proxy revision and **unpublishes** `sar-kpi-get-prod`. Prod then has
  nothing live. This is expected (D66).
- **Build TIMEOUT, CANCELLED, or a Cloud Build failure** (worker, image pull, a step killed for a
  non-script reason) **after the integration publish.** The rollback lives in `check-int-prod` and
  `check-prod`; when the build is aborted they never run, so the new integration, and possibly the
  new proxy revision, stay live **without** smoke verification (D67, review M5). Treat it like a
  failed rollback (next item): a manual rollback with the recorded values. Follow-up: wrap the long
  commands (`wait-for-deployment`, Newman, integrationcli) in coreutils `timeout` inside their steps,
  so a hang sets the flag instead of aborting the build.
- **Rollback failed** ("Proxy/Integration rollback FAILED: manual intervention required" or
  "state is UNKNOWN" in the log). The values are in the build log: `check-int-prod` prints
  `prev_prod_revision`, `prev_int_prod` and `new_int_prod` ("Recorded for rollback") before the
  proxy phase starts, `copy-revision-prod` prints the imported revision, and the failure branches
  of `check-int-prod` and `check-prod` print them all again ("Recorded: …"). `summary` does **not**
  run after a failure. A first-run proxy failure where the deploy itself failed may also log a false
  "Proxy rollback FAILED" (it tries to undeploy a revision that was never deployed; review L2,
  noted): check the Console before acting. There is
  **no rollback-only pipeline**, and rule 2 forbids running `scripts/rollback*.sh` against prod from a
  workstation. So a human prod operator acts in the Console:
  - Apigee → Proxies → `sar-mot-kpis-v1` → deploy the previous revision to `prod` with service
    account `sa-kpi-proxy-runtime@apigee-prod-511508.iam.gserviceaccount.com`, or undeploy the
    failed revision if there was none.
  - Application Integration → `sar-kpi-get-prod` → open the previous version, then publish its
    content as a new version (an old version cannot be re-published by id, D29). If there was no
    previous version, unpublish.
  Then fix forward: correct the cause on `main`, take it green through staging, and promote again.
- **Orphan DRAFT (P9 note).** A failed integration restore can leave a new DRAFT, or a version
  that is not yet ACTIVE, and `sar-kpi-get-prod` with **no ACTIVE version** after the fallback
  unpublish ("Rollback and manual intervention (dev and staging)" above explains the mechanism). In
  prod the fix is Console only: publish the orphan draft (it has the previous content) or a copy of
  the previous version, then confirm that exactly one version is ACTIVE.
- **The database is never rolled back.** `kpis_prod` keeps the expand-only schema and seed of the
  failed run, which is safe under rule 9.

### Handing over the MOT credentials (👤, out of band)

`infra/06` stores the `mot-app` key and secret only in prod Secret Manager, as
`sar-mot-app-api-key` and `sar-mot-app-api-secret`. The build SA gets **no direct grant** on them
(its only direct `secretAccessor` grants are the two smoke secrets). It **can** still read them
while it holds `roles/apigee.developerAdmin` (a developer-app GET returns the credentials) or
`roles/secretmanager.admin` (command A), so any commit promoted through `cloudbuild-prod.yaml` could
read them (D67). Removing `secretmanager.admin` after the infra runs narrows this; `developerAdmin`
stays until the release SA is split (follow-up). A person with `roles/secretmanager.secretAccessor` on those two secrets
reads them in the Console and hands them to MOT through the agreed secure channel, never through git,
chat, email in clear text or a build log. Record who received them and when, outside this repo. The
pipeline smoke run uses the separate `mot-smoke-app`. Its secrets
`sar-mot-smoke-app-api-key` / `-secret` are the only secrets `cb-deploy-prod` is granted directly.

### First-run VERIFY list (record each result in DECISIONS)

1. The runtimeConfig `serviceDirectory` of `apigee-prod-511508` has the shape
   `projects/<x>-tp/locations/us-central1/namespaces/connectors/services/runtime` (D61). If it does not, infra/04 and the
   integration apply fail closed, and prod stays blocked.
2. The endpoint attachment reaches `ACCEPTED` with an `endpointIp`, and the connection
   `sar-kpi-db-prod` reaches `ACTIVE` with the referenced secret version, without extra caller IAM.
3. integrationcli's connection overrides keep the resolved `serviceName` (`assert-integration-prod` checks it).
4. The Apigee role set (`apiAdminV2`, `environmentAdmin`, `developerAdmin`) covers import, deploy,
   KVMs, the debug-mask PATCH and creating the developers and apps.
5. The integrations service agent appears in the prod IAM policy after the Quick setup (`infra/02` pre-check).
6. The API product can name `sar-mot-kpis-v1` before its first prod deployment (`infra/06`).
7. `db-custom-1-3840` / `POSTGRES_15` is accepted with the default edition.
8. The custom role in command C covers the staging read and the bundle export (`find-staging-revision`, `check-commit`, `copy-revision`).
9. The Apigee revision GET returns the stamped `description` unchanged, in staging and for the imported prod revision, so `check-commit` and both `cmp`s in `copy-revision-prod` pass.
10. A manual or `--sha` trigger run sets `SHORT_SHA` (7 hex, the stamp length) and `COMMIT_SHA`.
11. `prod.35.201.86.122.nip.io` reaches the **prod** org's `prod` environment. It resolves to the same IP as the dev hostname, so the prod org needs its own env group with this hostname and load-balancer routing. Otherwise the smoke run hits the wrong org and fails (401 or 404), and the release rolls back.
12. `kpis_prod` holds the same seed as dev and staging after `db/load.sh prod`. The `Happy paths` smoke asserts exact values (D62).
13. Total build time stays within the 5400 s timeouts: Cloud SQL, PSC and connection creation in infra-prod; DB import and integration tests in the release.
14. `cmp` exists in `cloud-sdk:slim` (diffutils).
15. A manual or `--sha` trigger run sets `TRIGGER_NAME` to the trigger's name (both `guard-target`s refuse otherwise), and `gcloud builds triggers run` works for the runner after command E removed the trigger creator's actAs.

### What YOU must run/approve

<!-- Keep identical to the checklist at the end of the P8 section in docs/PLAN.md. -->

1. 👤 Review and merge `p8-prod` into `main`.
2. 👤 Decide the real MOT developer email. Edit the `MOT_DEVELOPER_EMAIL` line in `infra/env/prod.env`, then commit (`P8: set MOT developer email`). At the same time, decide D41 (D63): either record that the email is not sensitive, or hash the rate identifier. Hashing is a proxy change, so it goes through dev and staging first. `infra/06` refuses an `@example.com` email unless `ALLOW_PLACEHOLDER_MOT_EMAIL="1"` is committed on purpose (D67).
3. 👤 Create the GitHub repository `apigee-poc/sar-mot-kpis`, run `git remote add origin https://github.com/apigee-poc/sar-mot-kpis.git`, and push `main`. Create the Cloud Build GitHub connection and the three P7 triggers ("CI/CD triggers (not created yet)").
4. 👤 Let `sar-mot-kpis-main` take the merged commit green through dev and staging.
5. 👤 Console **Quick setup** for Application Integration in `apigee-prod-511508` / `us-central1` (D28).
6. 👤 Prod admin: run command A, the bootstrap roles for `cb-deploy-prod` on `apigee-prod-511508`.
7. 👤 Prod admin: run command B and confirm the output is **empty** (`cb-deploy-nonprod` has no role on prod). Also check Policy Analyzer for resource-level bindings.
8. 👤 Non-prod admin: approve and run command C, the custom read-only role for `cb-deploy-prod` on `apigee-nonprod-511322` (D60, supersedes D55).
9. 👤 Run command D: `logging.logWriter` for `cb-deploy-prod`, a **temporary** `serviceAccountUser` for the trigger creator, and `cloudbuild.builds.approver` for each approver, all on `ci-cd-511313`.
10. 👤 Create the triggers `sar-mot-kpis-infra-prod` and `sar-mot-kpis-prod` ("Prod triggers (NOT RUN)").
11. 👤 Right after that, run command E (remove the trigger creator's `serviceAccountUser` on `cb-deploy-prod`) and command F (nobody else can act as `cb-deploy-prod`, except prod admins you record). Anyone who keeps actAs can run an unapproved prod build (D67).
12. 👤 Run `sar-mot-kpis-infra-prod` and **approve** it (billable). Re-run it until `check-infra-02` passes (a re-run keeps the DB password, D67), and once more before `secretmanager.admin` is ever removed from `cb-deploy-prod` (the DB secret viewer grant). Note the tenant project, the endpoint IP and the connection state. Removing `secretmanager.admin` afterwards is recommended (while held, every release build can read every prod secret, D67); grant it again before any later infra-prod run.
13. 👤 Make sure `prod.35.201.86.122.nip.io` routes to the prod org's `prod` environment (VERIFY 11).
14. 👤 Confirm that the most recent `sar-mot-kpis-main` build is `SUCCESS` for the commit you will promote and that none is running ("Before approving").
15. 👤 Run `sar-mot-kpis-prod --sha=<that commit>` and **approve** it. Check the `summary` step. On failure, a timeout or a cancel, follow "Rollback behaviour and manual intervention".
16. 👤 Hand the `mot-app` credentials to MOT out of band.
17. 👤 Report the first-run VERIFY results (DEPLOYMENT.md "First-run VERIFY list") so they can be recorded in DECISIONS. Then mark P8 `DONE`.
