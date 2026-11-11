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

Rollback on a failed Newman run: `scripts/rollback.sh` (proxy) **then** `scripts/rollback-integration.sh`
(integration), then the integration version is recorded again (the restored version gets a new id, D29).
A failed integration apply or post-apply assertion rolls back only the integration and stops before the
proxy. The database is never rolled back (expand-only, AGENTS.md rule 9). Details: D48–D53.

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

The prod trigger (`cloudbuild-prod.yaml`, `cb-deploy-prod`, manual with approval) is P8.

### IAM required per build service account

All builds use `options.logging: CLOUD_LOGGING_ONLY`, so every `cb-*` account needs
`roles/logging.logWriter` on `ci-cd-511313`. The trigger creator needs `roles/iam.serviceAccountUser`
on the `cb-*` account it attaches.

| Account | Needs | Source |
|---|---|---|
| `cb-validate` | `roles/logging.logWriter` (ci-cd-511313) only. No Apigee, Integration, SQL or Secret Manager access: the PR build only reads the repo and the public npm/Maven registries. | cicd-workspace |
| `cb-deploy-nonprod` | On `apigee-nonprod-511322`: `roles/apigee.apiAdminV2` and `roles/apigee.environmentAdmin` (proxy import/deploy, KVMs, debug mask: VERIFY the debugmask PATCH permission on the first run); `roles/integrations.integrationAdmin` (apply, test, publish, rollback); `roles/connectors.admin`; `roles/cloudsql.admin` (`gcloud sql import sql`); `roles/storage.objectAdmin` on `gs://apigee-nonprod-511322-sar-kpi-seed`; `roles/iam.serviceAccountUser` on `sa-kpi-proxy-runtime` and `sa-kpi-connector` (deploy with the runtime SA); `roles/secretmanager.secretAccessor` on the four secrets `sar-mot-poc-app-api-key`, `sar-mot-poc-app-api-secret`, `sar-mot-poc-other-app-api-key`, `sar-mot-poc-other-app-api-secret` (Newman). For `cloudbuild-infra.yaml` it also needs to enable APIs, create service accounts, set IAM policy, create Cloud SQL / PSC resources and secrets (`roles/serviceusage.serviceUsageAdmin`, `roles/iam.serviceAccountAdmin`, `roles/resourcemanager.projectIamAdmin`, `roles/compute.networkAdmin`, `roles/secretmanager.admin`), or a human runs `infra/` once. On `ci-cd-511313`: `roles/logging.logWriter`. | D17, D28, infra/02 (steps 5–8), cicd-workspace DEPLOYMENT |
| `cb-deploy-prod` | The prod equivalents on `apigee-prod-511508` (P8). | P8 |

The Apigee roles come from cicd-workspace; the Integration, Connectors, Cloud SQL, bucket and
runtime-SA grants are applied by `infra/02-service-accounts-iam.sh`, which also grants the Newman secret
access (only for secrets that exist; run it again after `infra/05`). The Application Integration
service agent needs `roles/connectors.invoker` (D28); `infra/02` exits 3 if the agent is missing.
