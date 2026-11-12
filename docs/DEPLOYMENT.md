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

## Apigee environment settings

### Debug masks (AGENTS.md rule 4)

- Source of truth: `src/main/apigee/environments/<env>/debugmask.json` (local, dev, staging, prod).
- Applied with:
  `PATCH https://apigee.googleapis.com/v1/organizations/<org>/environments/<env>/debugmask?updateMask=variables`
  with the body `{"variables": [...]}` taken from that file.
- Dev was applied by hand this way in P5 and verified in a debug session (D40). Staging and prod
  are not masked yet: the P7 pipeline must run exactly this call for every environment before
  deploying the proxy.

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
- **Prod triggers are P8.** Both get their own approved manual triggers running as `cb-deploy-prod`: `cloudbuild-prod.yaml` (promotion) and `cloudbuild-infra-prod.yaml` (foundation, D55). `cloudbuild-infra.yaml` refuses any `_TARGET` other than `nonprod`.
- **Prod guard (D58).** The YAML guard is defence in depth; the real control is IAM. `cb-deploy-nonprod` must have **no role on `apigee-prod-511508`**, because a manual trigger can be run on a branch whose YAML or env file was edited.

### IAM required per build service account

All builds use `options.logging: CLOUD_LOGGING_ONLY`, so every `cb-*` account needs
`roles/logging.logWriter` on `ci-cd-511313`. The trigger creator needs `roles/iam.serviceAccountUser`
on the `cb-*` account it attaches.

| Account | Needs | Source |
|---|---|---|
| `cb-validate` | `roles/logging.logWriter` (ci-cd-511313) only. No Apigee, Integration, SQL or Secret Manager access: the PR build only reads the repo and the public npm/Maven registries. | cicd-workspace |
| `cb-deploy-nonprod` | On `apigee-nonprod-511322`: `roles/apigee.apiAdminV2` and `roles/apigee.environmentAdmin` (proxy import/deploy, KVMs, debug mask: VERIFY the debugmask PATCH permission on the first run); `roles/integrations.integrationAdmin` (apply, test, publish, rollback); `roles/connectors.admin`; `roles/cloudsql.admin` (`gcloud sql import sql`); `roles/storage.objectAdmin` on `gs://apigee-nonprod-511322-sar-kpi-seed`; `roles/iam.serviceAccountUser` on `sa-kpi-proxy-runtime` and `sa-kpi-connector` (deploy with the runtime SA); `roles/secretmanager.secretAccessor` on the four secrets `sar-mot-poc-app-api-key`, `sar-mot-poc-app-api-secret`, `sar-mot-poc-other-app-api-key`, `sar-mot-poc-other-app-api-secret` (Newman). For `cloudbuild-infra.yaml` it also needs to enable APIs, create service accounts, set IAM policy, create Cloud SQL / PSC resources and secrets (`roles/serviceusage.serviceUsageAdmin`, `roles/iam.serviceAccountAdmin`, `roles/resourcemanager.projectIamAdmin`, `roles/compute.networkAdmin`, `roles/secretmanager.admin`), or a human runs `infra/` once. On `ci-cd-511313`: `roles/logging.logWriter`. | D17, D28, infra/02 (steps 5–8), cicd-workspace DEPLOYMENT |
| `cb-deploy-prod` | The prod equivalents on `apigee-prod-511508` (P8). | P8 |

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
