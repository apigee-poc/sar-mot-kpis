# SAR MOT KPI POC — Implementation Handoff

> Generated: 2026-11-11  
> Last git commit: `acb6ba6 docs: mark P3 as DONE`  
> Session stopped by user after P3 was verified complete.

---

## Phase Status Summary

| Phase | Title | Status | Commit |
|---|---|---|---|
| P0 | Repo bootstrap | ✅ DONE | `505f7b7` |
| P1 | Non-prod foundation (APIs, SAs, IAM) | ✅ DONE | `cbf1347` |
| P2 | Private Cloud SQL + mock data | ✅ DONE | `b5813cf` |
| P3 | Integration Connector (private) | ✅ DONE | `8987442` |
| P4 | Application Integration | ⏳ TODO | — |
| P5 | Apigee proxy | ⏳ TODO | — |
| P6 | Tests (unit, Newman, integration) | ⏳ TODO | — |
| P7 | CI/CD pipelines (PR + non-prod) | ⏳ TODO | — |
| P8 | Prod foundation + prod pipeline | ⏳ TODO | — |
| P9 | Documentation + acceptance demo | ⏳ TODO | — |

---

## Repository Layout (current state)

```
d:\apigee\sar-mot-kpis\
├── AGENTS.md, CLAUDE.md, README.md
├── .agent/rules/sar-mot-kpis.md
├── .claude/settings.json
├── .gitattributes, .gitignore
├── api/
│   └── sar-mot-kpis-oas.yaml              ← OAS contract (v1.0.1)
├── db/
│   ├── migrations/V001__create_kpi_records.sql
│   ├── seed/total_freight.sql             ← 7 rows (2024 Q1-4, 2025 Q1-3)
│   └── load.sh                            ← idempotent GCS import
├── deploy/shared-pom.xml
├── docs/
│   ├── DECISIONS.md                       ← D1–D19 all recorded
│   ├── DEPLOYMENT.md
│   ├── ERROR-CATALOG.md
│   ├── HANDOFF.md                         ← this file
│   ├── PLAN.md
│   └── PROMPTS.md
├── infra/
│   ├── env/nonprod.env
│   ├── 01-enable-apis.sh
│   ├── 02-service-accounts-iam.sh
│   ├── 03-cloudsql-private.sh
│   └── 04-psc-endpoint-attachment.sh
├── integration/
│   └── connectors/
│       ├── sar-kpi-db-dev.json            ← ACTIVE, host 10.128.0.2:5432, db kpis_dev
│       └── sar-kpi-db-staging.json        ← ACTIVE, host 10.128.0.2:5432, db kpis_staging
├── package.json, package-lock.json
├── scripts/
│   ├── copy-revision.sh
│   ├── create-versioned-kvm.sh
│   ├── deploy-revision.sh
│   ├── get-deployed-revision.sh
│   ├── rollback.sh
│   └── wait-for-deployment.sh
├── src/main/apigee/apiproxies/sar-mot-kpis-v1/
│   ├── pom.xml
│   └── apiproxy/
│       ├── sar-mot-kpis-v1.xml            ← placeholder only
│       └── proxies/default.xml            ← placeholder only
└── tests/unit/sample.test.js              ← placeholder (1 passing)
```

**Missing (needed for P4–P9):**
- `integration/src/sar-kpi-get.json`
- `integration/overrides/<env>/overrides.json`
- `integration/test-cases/`
- `infra/05-apigee-products-apps.sh`
- Full proxy policies in `src/main/apigee/apiproxies/sar-mot-kpis-v1/apiproxy/`
- `src/main/apigee/environments/<env>/kvms/`
- `src/main/apigee/environments/<env>/debugmask.json`
- `tests/sar-mot-kpis.postman_collection.json`
- `tests/<env>.postman_environment.json`
- `cloudbuild-infra.yaml`, `cloudbuild-pr.yaml`, `cloudbuild-main.yaml`, `cloudbuild-prod.yaml`
- `scripts/get-published-integration-version.sh`
- `scripts/rollback-integration.sh`

---

## GCP Resources (all verified)

| Resource | Location / ID | State |
|---|---|---|
| Cloud SQL instance | `sar-kpi-sql-nonprod` (POSTGRES_15, db-f1-micro, PSC-only, us-central1) | RUNNABLE |
| Database dev | `kpis_dev` — 7 rows in `kpi_records` | ✅ |
| Database staging | `kpis_staging` — 7 rows in `kpi_records` | ✅ |
| SQL user | `kpi_reader` — password in Secret Manager | ✅ |
| Secret | `sar-kpi-db-reader-password` (version 1, 20 chars, no newline) in `apigee-nonprod-511322` | ✅ |
| GCS seed bucket | `gs://apigee-nonprod-511322-sar-kpi-seed/` | ✅ |
| PSC endpoint attachment | `sar-kpi-sql-nonprod-ea` → IP `10.128.0.2` → Cloud SQL PSC service attachment | ACTIVE |
| Connectors tenant project | `ef911070c468726ff-tp` (allowlisted in Cloud SQL PSC) | — |
| Connector dev | `sar-kpi-db-dev` in `apigee-nonprod-511322/us-central1` | ACTIVE |
| Connector staging | `sar-kpi-db-staging` in `apigee-nonprod-511322/us-central1` | ACTIVE |
| SA proxy runtime | `sa-kpi-proxy-runtime@apigee-nonprod-511322.iam.gserviceaccount.com` | ✅ |
| SA connector | `sa-kpi-connector@apigee-nonprod-511322.iam.gserviceaccount.com` | ✅ |

**Application Integration:** nothing deployed yet — `integrationcli integrations list` returns `{}`.  
**Apigee proxy:** placeholder only, not deployed to any environment.

---

## Key Technical Decisions (from docs/DECISIONS.md, D1–D19)

| # | Decision |
|---|---|
| D17 | Apigee service agent granted `roles/iam.serviceAccountTokenCreator` on `sa-kpi-proxy-runtime` to allow OIDC token minting for IntegrationEndpoint calls |
| D18 | Connectors tenant project `ef911070c468726ff-tp` added to Cloud SQL PSC allowlist; discovered via `gcloud integrations connectors get-runtime-config` |
| D19 | PostgreSQL connector uses `"host": "10.128.0.2"` (endpoint attachment IP) in `destinationConfigs` — NOT `serviceAttachment` or `endpointAttachment` URI, which both resolve to `localhost` internally |

---

## Critical Environment Notes

### Shell for gcloud on this machine
- **Use Git Bash** at `C:\Program Files\Git\bin\bash.exe`
- **Do NOT use WSL** (`execvpe(/bin/bash) failed` — broken on this machine)
- `~/.bashrc` must export:
  ```bash
  export CLOUDSDK_PYTHON='C:\Users\ENVNT.DESKTOP-125116U\AppData\Local\Google\Cloud SDK\google-cloud-sdk\platform\bundledpython\python.exe'
  ```

### integrationcli
- Installed at `C:\Users\ENVNT.DESKTOP-125116U\tools\integrationcli` (v0.86.0), in PATH
- Always pass `-t $(gcloud auth print-access-token)` (PowerShell: `$token = gcloud auth print-access-token; integrationcli ... -t $token`)
- SA flag is `--sa` (not `-s`); value is short name without `@project.iam.gserviceaccount.com`

### integrationcli folder layout (verified)
```
integration/
├── src/<name>.json              # integration definition
├── overrides/<env>/overrides.json
├── connectors/<name>.json
└── test-cases/
```

---

## P4 — Application Integration (next phase)

### What to build
Integration `sar-kpi-get` with:
- **API trigger:** `api_trigger/sar-kpi-get`
- **Input parameters:** `kpiCode` (STRING), `year` (INT), `quarter` (INT, nullable — 0 means absent)
- **Output parameter:** `data` (JSON_VALUE)

### SQL query (task: ExecuteCustomQuery)
```sql
SELECT quarter, year, actual, load_time
FROM kpi_records
WHERE kpi_code = ?
  AND year = ?
  AND (CAST(? AS SMALLINT) IS NULL OR quarter = ?)
ORDER BY quarter
```
Query parameters: `[kpiCode VARCHAR, year INT, quarter INT, quarter INT]`

### Task flow
1. **`DM-BuildConnectorInput`** (FieldMappingTask) — build the `connectorInputPayload` JSON
2. **`CON-QueryKpiRecords`** (GenericConnectorTask) — `EXECUTE_ACTION / ExecuteCustomQuery`  
   Connection: `projects/apigee-nonprod-511322/locations/us-central1/connections/sar-kpi-db-dev` (overridden per env)
3. **`JS-TransformOutput`** (JavaScriptTask) — map rows to OAS shape:
   ```javascript
   function executeScript(event) {
     var raw = event.getParameter('Task_2_connectorOutputPayload');
     var rows = JSON.parse(raw || '[]');
     var result = rows.map(function(r) {
       return {
         quarter: r.quarter,
         year: r.year,
         actual: parseFloat(r.actual),
         loadTime: new Date(r.load_time).toISOString().replace(/\.\d{3}Z$/, 'Z')
       };
     });
     event.setParameter('data', JSON.stringify(result));
   }
   ```

### Overrides files
`integration/overrides/dev/overrides.json`:
```json
{
  "task_overrides": [],
  "connection_overrides": [
    {
      "taskId": "2",
      "task": "GenericConnectorTask",
      "parameters": { "connectionName": "sar-kpi-db-dev" }
    }
  ],
  "param_overrides": [],
  "integration_overrides": {
    "databasePersistencePolicy": "DATABASE_PERSISTENCE_POLICY_UNSPECIFIED",
    "enableVariableMasking": false
  }
}
```
`integration/overrides/staging/overrides.json` — same but `connectionName: sar-kpi-db-staging`.

### Test cases (integration/test-cases/)
| File | kpiCode | year | quarter | Expected rows |
|---|---|---|---|---|
| `test-2025-full-year.json` | total_freight | 2025 | null | 3 rows |
| `test-2025-q3.json` | total_freight | 2025 | 3 | 1 row (actual=1512750) |
| `test-2026-empty.json` | total_freight | 2026 | null | 0 rows (`data: []`) |
| `test-2024-full-year.json` | total_freight | 2024 | null | 4 rows |

### Deploy commands (PowerShell)
```powershell
$SHORT_SHA = git rev-parse --short HEAD
$token = gcloud auth print-access-token

# dev
integrationcli integrations apply -f ./integration -e dev `
  --userlabel=$SHORT_SHA --skip-connectors=true --wait=true --run-tests=true `
  -p apigee-nonprod-511322 -r us-central1 -t $token

# staging
integrationcli integrations apply -f ./integration -e staging `
  --userlabel=$SHORT_SHA --skip-connectors=true --wait=true --run-tests=true `
  -p apigee-nonprod-511322 -r us-central1 -t $token
```

### New scripts required for P4
- `scripts/get-published-integration-version.sh` — mirrors `get-deployed-revision.sh`
- `scripts/rollback-integration.sh` — mirrors `rollback.sh`

### P4 Acceptance checks
- [ ] Both integrations published, label = SHORT_SHA
- [ ] All 4 test cases pass in both dev and staging
- [ ] API execution returns `data` in OAS shape
- [ ] `docs/PLAN.md` P4 status updated to `DONE (<sha>)`
- [ ] Commit: `git commit -m "P4: application integration sar-kpi-get dev and staging"`

---

## P5 — Apigee Proxy (after P4)

### What to build
Full proxy at `src/main/apigee/apiproxies/sar-mot-kpis-v1/apiproxy/` following `pet-poc` naming.

### Policy table
See `docs/PLAN.md` lines 210–232 for the full table. Key policies:

| Policy | Type | Purpose |
|---|---|---|
| `AM-SetTraceAndTimestamp` | AssignMessage | Set `custom.traceId = messageid`, `custom.timestamp` = ISO-8601 UTC |
| `KVM-GetConfig` | KeyValueMapOperations | Read from `sar-mot-kpis-config-__KVM_VERSION__` |
| `RF-InvalidRequestId` | RaiseFault | Missing or non-UUID X-Request-Id → ERR-400-REQUESTID |
| `AM-SetClientTraceId` | AssignMessage | Overwrite `custom.traceId` with `X-Request-Id` header |
| `VA-VerifyApiKey` | VerifyAPIKey | Verify `request.header.x-api-key` |
| `RF-InvalidSecret` | RaiseFault | X-API-Secret ≠ client_secret → ERR-401-SECRET |
| `SA-SpikeArrest` | SpikeArrest | Rates from KVM |
| `Q-ImposeQuota` | Quota | Rates from KVM |
| `JS-ValidateRequestTimestamp` | JavaScript | ISO parse + clock-skew check |
| `RF-InvalidRequestTimestamp` | RaiseFault | ERR-400-TIMESTAMP |
| `RF-InvalidOperatorId` | RaiseFault | Regex `^[12]\d{9}$` → ERR-400-OPERATOR |
| `RF-InvalidQueryParams` | RaiseFault | year/quarter validation → ERR-400-PARAMS |
| `AM-SetKpiCode` | AssignMessage | Set `kpi.code = total_freight` |
| `SIR-SetIntegrationRequest` | SetIntegrationRequest | Integration name/project/region from KVM |
| `RF-IntegrationError` | RaiseFault | Non-2xx from integration → ERR-500-INTEGRATION |
| `EV-ExtractIntegrationOutput` | ExtractVariables | JSONPath to `data` output param |
| `RF-BadGateway` | RaiseFault | Missing/non-array/too-many items → ERR-502-GATEWAY |
| `AM-BuildKpiResponse` | AssignMessage | Build 200 response |
| `RF-MethodNotAllowed` | RaiseFault | ERR-405-METHOD |
| `RF-ResourceNotFound` | RaiseFault | ERR-404-RESOURCE |
| `AM-SetLookupKey` + `KVM-GetErrorMessage` + `AM-BuildErrorResponse` | DefaultFaultRule | Integer error.code, escapeJSON message |
| `AM-SetResponseRequestIdHeader` | AssignMessage | Echo X-Request-Id on every response |

### VERIFY items for P5
1. Exact response shape of IntegrationEndpoint — where `data` sits in the JSON (needs debug session)
2. Default HTTP statuses of VerifyAPIKey/SpikeArrest/Quota faults — may need overrides
3. Message-template syntax for ISO timestamp in AssignMessage

### Environment files needed
- `src/main/apigee/environments/{local,dev,staging,prod}/kvms/sar-mot-kpis-config.json`
- `src/main/apigee/environments/{local,dev,staging,prod}/kvms/sar-mot-kpis-errors.json`
- `src/main/apigee/environments/{local,dev,staging,prod}/debugmask.json`
  - Must mask: `request.header.X-API-Key`, `request.header.X-API-Secret`, `request.header.X-Operator-Id`

### infra/05-apigee-products-apps.sh
- API product `sar-mot-kpis-product` — paths `/kpis/**`, envs `dev` + `staging`
- Developer `mot-poc@example.com`
- App `mot-poc-app`
- Second product WITHOUT `/kpis/**` path (for 403 test)
- Credentials → Secret Manager, never committed

### P5 Acceptance checks
- [ ] `npm run lint` passes 0 errors, 0 warnings
- [ ] All error paths verified against `docs/ERROR-CATALOG.md`
- [ ] `debugmask.json` committed and masking verified in trace
- [ ] Commit: `git commit -m "P5: apigee proxy sar-mot-kpis-v1"`

---

## P6–P9 Summary

**P6 — Tests**
- Mocha unit tests: every branch of `JS-ValidateRequestTimestamp`
- Postman collection: one request per error-catalog row + all 200 happy-path cases
- Environment files for local/dev/staging/prod (credentials injected by pipeline, not stored)

**P7 — CI/CD**
- `cloudbuild-infra.yaml` (manual, runs `infra/0*.sh`)
- `cloudbuild-pr.yaml` (validate: lint + unit + OAS lint + Maven package)
- `cloudbuild-main.yaml` (deploy: stamp KVM version → lint → db/load → connectors → integration → proxy → Newman; rollback on failure; promote same revision to staging)
- All in project `ci-cd-511313` using existing `cb-validate`, `cb-deploy-nonprod` SAs

**P8 — Prod**
- 👤 Provision App Integration in prod project `apigee-prod-511508`
- 👤 Run `cloudbuild-infra.yaml --substitutions _TARGET=prod`
- `cloudbuild-prod.yaml` manual + approval gate — promotes byte-for-byte what passed staging

**P9 — Docs**
- `README.md`, `docs/DEPLOYMENT.md`, `docs/ACCEPTANCE.md` (one row per error-catalog case with evidence)

---

## Rules for the Next Agent

1. **Read `AGENTS.md` and `docs/PLAN.md` first** — they are authoritative.
2. **Start from P4** — P0–P3 are complete, all GCP resources are in place.
3. **Work one phase at a time** — update `docs/PLAN.md` status and stop for human review after each.
4. **Never touch prod** (`apigee-prod-511508`) from workstation.
5. **Ask before billable/destructive** — show exact command and wait.
6. **No secrets in git/logs/chat** — passwords in Secret Manager only.
7. **Git Bash for gcloud** — `C:\Program Files\Git\bin\bash.exe` with `CLOUDSDK_PYTHON` set.
8. **integrationcli token** — always fresh: `$token = gcloud auth print-access-token`.
9. **Commit format:** `<phase-id>: <what>` (e.g., `P4: application integration sar-kpi-get`).
10. **Definition of done:** `npm run lint` 0/0, unit tests pass, relevant Newman tests pass.
