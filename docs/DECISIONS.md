# Decisions log

Agents: append new findings at the bottom (date, decision, reason, source).
Never edit a past entry; supersede it with a new one.

| # | Decision | Reason |
|---|---|---|
| D1 | One monorepo `apigee-poc/sar-mot-kpis`, with infra in `infra/` and its own manual pipeline | A single commit SHA versions DB, connector, integration and proxy together. Infra changes rarely and needs higher privileges. |
| D2 | Region `us-central1` for Cloud SQL, Connectors and Application Integration | Supported by all three services. |
| D3 | Environment-suffixed names (`sar-kpi-get-dev`, `-staging`, `-prod`) | Application Integration has no environments inside a project. `dev` and `staging` share project `apigee-nonprod-511322`. |
| D4 | Integration name, project and region are read by the proxy from the versioned config KVM | The proxy bundle stays byte-identical across environments, and rollback of the proxy also rolls back which integration it calls. |
| D5 | `error.code` is the integer HTTP status | Required by the OAS. pet-poc's string codes become internal KVM lookup keys only. |
| D6 | `header.timestamp` uses ISO-8601 UTC | Required by the OAS. pet-poc's epoch value does not conform. |
| D7 | `X-Request-Id` is required, validated as UUID, used as `traceId` and echoed as a response header | Required by the OAS. |
| D8 | `X-API-Secret` is compared with the app's consumer secret after VerifyAPIKey | The OAS requires key + secret. VerifyAPIKey alone ignores the secret. |
| D9 | 404 and 502 added to the OAS (v1.0.1) | Needed for unknown paths and malformed backend output. |
| D10 | Cloud SQL is private only (Private Service Connect), with the connector reaching it via an endpoint attachment | POC security requirement: no public IP. |
| D11 | Mock data is loaded with `gcloud sql import sql` from a GCS bucket | Works against a private instance without giving Cloud Build network access to the VPC. |
| D12 | Connector uses a read-only DB user `kpi_reader`, with its password in Secret Manager | Least privilege. The API is read-only. |
| D13 | Prod is in scope and uses the same artifacts promoted by commit SHA, with a manual trigger and approval | Mirrors `cicd-workspace`. Nothing is rebuilt for prod. |
| D14 | Rate limits (SpikeArrest, Quota) and allowed clock skew are read from the config KVM | Per-environment tuning without redeploying. |
| D15 | Single generic table `kpi_records` keyed by (`kpi_code`, `year`, `quarter`) | Adding a KPI needs only data plus a proxy flow. |
| D16 | Runtime service account attachment via Maven plugin `<apigee.googletoken.email>` and REST API query param `serviceAccount` | `apigee-edge-maven-plugin` 2.5.2 maps `<apigee.googletoken.email>` to the `serviceAccount` query parameter on proxy deployment. `deploy-revision.sh` passes `serviceAccount=${SA}` directly in the REST API call, defaulting to `sa-kpi-proxy-runtime@${ORG}.iam.gserviceaccount.com`. | Official `apigee-edge-maven-plugin` documentation and Apigee deployments REST API spec. |
| D17 | Least-privileged IAM roles for cb-deploy-nonprod and Apigee service agent in non-prod | `cb-deploy-nonprod` granted `roles/integrations.integrationAdmin`, `roles/connectors.admin`, `roles/cloudsql.admin` (required for DB creation and `gcloud sql import sql`), `roles/iam.serviceAccountUser` on both proxy and connector SAs, and `roles/storage.objectAdmin` on seed bucket. Apigee service agent (`service-<NUM>@gcp-sa-apigee.iam.gserviceaccount.com`) granted `roles/iam.serviceAccountTokenCreator` on `sa-kpi-proxy-runtime`. `sa-kpi-connector` granted `roles/secretmanager.secretAccessor` on the DB password secret only. | Official Google Cloud Apigee documentation on attaching service accounts and Application Integration invoker requirements. |
