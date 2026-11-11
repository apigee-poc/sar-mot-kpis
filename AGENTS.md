# AGENTS.md — SAR MOT KPI Data Sharing POC

This file is the single source of rules for any coding agent working in this repo
(Claude Code reads it via `CLAUDE.md`; Antigravity via `.agent/rules/`).
Read it fully at the start of every session, then read `docs/PLAN.md` and continue
from the first phase whose status is not `DONE`.

## What we are building

A read-only API that exposes approved SAR KPIs to MOT, implemented as:

```
Client → Apigee X proxy (sar-mot-kpis-v1)
       → Application Integration (sar-kpi-get-<env>, API trigger)
       → Integration Connectors (sar-kpi-db-<env>, PostgreSQL, private via PSC)
       → Cloud SQL for PostgreSQL (private, mock data)
```

The contract is `api/sar-mot-kpis-oas.yaml`. Every response — success or error —
must match it exactly. Error behaviour is defined in `docs/ERROR-CATALOG.md`.

## Fixed facts (do not change without asking)

| Item | Value |
|---|---|
| Region (all services) | `us-central1` |
| CI/CD project | `ci-cd-511313` |
| Non-prod project / Apigee org | `apigee-nonprod-511322` (envs `dev`, `staging`) |
| Prod project / Apigee org | `apigee-prod-511508` (env `prod`) |
| Hostnames | dev `35.201.86.122.nip.io`, staging `staging.35.201.86.122.nip.io`, prod `prod.35.201.86.122.nip.io` |
| Proxy name / base path | `sar-mot-kpis-v1` / `/mot-kpis/business-domain/v1` |
| First resource | `GET /kpis/total_freight` (kpiCode `total_freight`) |
| Integration name | `sar-kpi-get-<env>` (dev, staging, prod) |
| Connection name | `sar-kpi-db-<env>` |
| Cloud SQL | `sar-kpi-sql-nonprod` (dbs `kpis_dev`, `kpis_staging`), `sar-kpi-sql-prod` (db `kpis_prod`), private IP / PSC only |
| Config KVM | `sar-mot-kpis-config-<SHORT_SHA>` (versioned, same mechanism as `cicd-workspace`) |
| Error-message KVM | `sar-mot-kpis-errors-<SHORT_SHA>` (versioned) |
| Build service accounts | `cb-validate`, `cb-deploy-nonprod`, `cb-deploy-prod` (existing, in `ci-cd-511313`) |
| New service accounts | `sa-kpi-proxy-runtime` (Apigee → Integration), `sa-kpi-connector` (connection runtime) — one per project |

## Reference repositories (patterns to copy, not to modify)

- `https://github.com/apigee-poc/cicd-workspace` — pipeline, scripts, Maven parent POM,
  versioned KVMs, Newman tests, rollback, prod promotion by copying the staging revision.
- `https://github.com/apigee-poc/pet-poc` — error handling pattern:
  `AM-SetTraceAndTimestamp` → `RF-*` sets `custom.errorCode` →
  `DefaultFaultRule` (`AM-SetLookupKey` → `KVM-GetErrorMessage` → `AM-BuildErrorResponse`).

Deliberate differences from pet-poc (already decided — see `docs/DECISIONS.md`):
`error.code` is an **integer HTTP status**; `header.timestamp` is **ISO-8601 UTC**;
trace ID comes from the **required `X-Request-Id`** header and is echoed back as a
response header on every response; `X-API-Secret` is validated against the app's
client secret.

## Rules of engagement

1. **Work one phase at a time.** At the end of a phase: run its acceptance checks,
   update its status in `docs/PLAN.md`, summarise what changed, and **stop for human
   review**. Do not start the next phase on your own.
2. **Never touch prod directly.** No command may target `apigee-prod-511508` from a
   workstation. Prod changes only happen through `cloudbuild-prod.yaml` with manual approval.
3. **Ask before anything billable or destructive.** Show the exact command and wait for
   approval before creating Cloud SQL instances, PSC/endpoint attachments, or before any
   `delete`, `undeploy`, IAM removal, or `--force`.
4. **No secrets in git, logs or chat.** Passwords live in Secret Manager only. Never `echo`
   or `cat` a secret. `X-API-Secret` and `X-Operator-Id` must be in `debugmask.json`.
5. **Verify, don't guess.** Product behaviour that is marked `VERIFY` in the plan must be
   checked against current Google Cloud documentation (or by a real test) before you rely
   on it. Record the finding in `docs/DECISIONS.md`.
6. **gcloud hygiene.** Always pass `--project`, `--region us-central1` (where applicable)
   and `--quiet` in scripts. Use the least-privileged role that works.
7. **Definition of done for any code change:** `npm run lint` passes with 0 errors and
   0 warnings, JavaScript unit tests pass, and the relevant Postman/Newman tests pass.
8. **Keep it generic.** Design for more KPIs: kpiCode is a parameter end to end; adding a
   KPI must only need a proxy flow, a KVM allowlist entry and data.
9. **Database changes are expand-only.** The database is never rolled back by the pipeline,
   so a schema change must keep working with the previous proxy + integration version.
10. **Commit messages:** `<phase-id>: <what>` (e.g. `P5: add query param validation`).
