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
| P4 | Application Integration | ✅ DONE | `3400476` |
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
- `integration/<env>/{src,overrides,tests,test-configs}` — added in P4 (see "integrationcli folder layout")
- `infra/05-apigee-products-apps.sh`
- Full proxy policies in `src/main/apigee/apiproxies/sar-mot-kpis-v1/apiproxy/`
- `src/main/apigee/environments/<env>/kvms/`
- `src/main/apigee/environments/<env>/debugmask.json`
- `tests/sar-mot-kpis.postman_collection.json`
- `tests/<env>.postman_environment.json`
- `cloudbuild-infra.yaml`, `cloudbuild-pr.yaml`, `cloudbuild-main.yaml`, `cloudbuild-prod.yaml`
- `scripts/get-published-integration-version.sh`, `scripts/rollback-integration.sh` — added in P4

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

### integrationcli folder layout (verified against v0.86.0 source — D20, D21)
One apply root per env, applied with `-f ./integration/<env>` and **no `-e`**:
```
integration/
├── connectors/sar-kpi-db-<env>.json        # P3, applied separately (--skip-connectors=true)
└── <env>/                                  # dev | staging (| prod in P8)
    ├── src/sar-kpi-get-<env>.json          # exactly one file; file name = integration name
    ├── overrides/overrides.json            # connection + trigger again (defence in depth)
    ├── tests/<name>.json                   # TestCase definitions (displayName = <name>)
    └── test-configs/<name>.json            # executeTest bodies {"inputParameters": {...}}
```
- With `-e E`, apply reads `src` from `F/src` (shared) and everything else from `F/E/`; it keeps
  only the first `*.json` under `src/` and names the integration after it, so a shared src cannot
  produce per-env names. Overrides cannot rename an integration.
- `--run-tests=true` fails if `test-configs/` is missing.
- **`--userlabel` is silently ignored** in v0.86.0 (registered `userlabel`, read as `user-label`).
  Stamp `"userLabel"` into a temp copy of the src JSON instead (D23; see deploy commands).
- Do not commit `src/javascript/*.js` from a scaffold: apply would replace the inline scripts with them.

---

## P4 — Application Integration

### What to build
Integrations `sar-kpi-get-dev` and `sar-kpi-get-staging` (source: `integration/<env>/src/`) with:
- **API trigger:** `api_trigger/sar-kpi-get-<env>` (per env, D22)
- **Input parameters:** `kpiCode` (STRING), `year` (INT), `quarter` (INT, default `0` = all quarters; never null — P5 omits it or sends 0)
- **Output parameter:** `data` (JSON_VALUE) = `{"records": [KpiRecord…]}`, default `{"records": []}` (D26)

### SQL query (task: ExecuteCustomQuery)
```sql
SELECT quarter, year, actual, load_time
FROM kpi_records
WHERE kpi_code = ?
  AND year = ?
  AND (CAST(? AS SMALLINT) IS NULL OR quarter = ?)
ORDER BY quarter
```
Query parameters: `[kpiCode VARCHAR, year INTEGER, quarter INTEGER, quarter INTEGER]`, quarter 0 sent as `null` (D24). `INT` is not a connector data type.

### Task flow (D24)
1. **`JS-BuildConnectorInput`** (JavaScriptTask) — builds `` `Task_2_connectorInputPayload` `` =
   `{query, queryParameters:[{value,dataType}], timeout: 30, maxRows: 10}`, quarter 0 → `null`.
   (Data Mapping cannot express the conditional NULL.)
2. **`CON-QueryKpiRecords`** (GenericConnectorTask) — `EXECUTE_ACTION / ExecuteCustomQuery`.
   Each env's src hard-codes `projects/apigee-nonprod-511322/locations/us-central1/connections/sar-kpi-db-<env>`;
   the override sets it again.
3. **`JS-TransformOutput`** (JavaScriptTask) — reads `` `Task_2_connectorOutputPayload` ``
   (auto-generated variables need backticks), maps rows to `KpiRecord` (`Number()` for numbers,
   `load_time` → `YYYY-MM-DDTHH:MM:SSZ`) and sets `data` with `event.setParameter("data", {records: result})`
   (`{records: []}` when no rows); it throws on bad input. In dev, both a bare JS array and
   `JSON.stringify(array)` on a JSON_VALUE variable fail with "The value assigned to data is not a
   Json value"; only a plain object is accepted (D26). The scripts live inline in the src JSON and are unit-tested in
   `tests/unit/integration-sar-kpi-get.test.js`.

All three tasks use `failurePolicy` and `synchronousCallFailurePolicy` `FATAL`.

### Overrides files
`integration/<env>/overrides/overrides.json` (dev shown; staging uses `-staging`):
```json
{
  "trigger_overrides": [
    { "triggerNumber": "1", "triggerType": "API", "apiPath": "sar-kpi-get-dev",
      "properties": { "Trigger name": "sar-kpi-get-dev" } }
  ],
  "connection_overrides": [
    { "taskId": "2", "task": "GenericConnectorTask",
      "parameters": { "connectionName": "sar-kpi-db-dev" } }
  ],
  "integration_overrides": {
    "databasePersistencePolicy": "DATABASE_PERSISTENCE_POLICY_UNSPECIFIED",
    "enableVariableMasking": false,
    "cloudLoggingDetails": { "cloudLoggingSeverity": "CLOUD_LOGGING_SEVERITY_UNSPECIFIED", "enableCloudLogging": false }
  }
}
```

### Test cases (integration/<env>/tests/ + integration/<env>/test-configs/, same file names)
| File | kpiCode | year | quarter | Expected rows |
|---|---|---|---|---|
| `test-2025-full-year.json` | total_freight | 2025 | 0 (all) | 3 rows |
| `test-2025-q3.json` | total_freight | 2025 | 3 | 1 row (actual=1512750) |
| `test-2026-empty.json` | total_freight | 2026 | 0 (all) | 0 rows (`data: {"records": []}`) |
| `test-2024-full-year.json` | total_freight | 2024 | 0 (all) | 4 rows |

### Deploy commands (PowerShell)
`--userlabel` is ignored by integrationcli v0.86.0 (D23), so the label is stamped into a temp copy
of each env's apply root, which is then applied **without `-e`** (D20).
```powershell
$SHORT_SHA = git rev-parse --short HEAD
$token = gcloud auth print-access-token

foreach ($e in 'dev', 'staging') {
  $tmp = Join-Path $env:TEMP "sar-kpi-apply-$e"
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Copy-Item -Recurse ./integration/$e $tmp
  node -e "const f=process.argv[1];const j=JSON.parse(require('fs').readFileSync(f,'utf8'));j.userLabel=process.argv[2];require('fs').writeFileSync(f,JSON.stringify(j,null,2))" "$tmp/src/sar-kpi-get-$e.json" $SHORT_SHA
  if ($LASTEXITCODE -ne 0) { throw "userLabel stamp failed for $e" }
  integrationcli integrations apply -f $tmp `
    --skip-connectors=true --wait=true --run-tests=true `
    -p apigee-nonprod-511322 -r us-central1 -t $token
  if ($LASTEXITCODE -ne 0) { throw "apply failed for $e" }   # never apply staging after a failed dev
}
```
After apply, check that the published version's task 2 `connectionName` ends in `sar-kpi-db-<env>`
and its `userLabel` is the SHORT_SHA.

### New scripts required for P4
- `scripts/get-published-integration-version.sh` — mirrors `get-deployed-revision.sh` (records the ACTIVE version before apply)
- `scripts/rollback-integration.sh` — mirrors `rollback.sh`, but publishing a new version moves the
  old one to SNAPSHOT and an old version cannot be re-published by id (D29): it copies the previous version's content into a **new draft** and publishes that;
  with no previous version it unpublishes the failed one (D25)

### P4 Acceptance checks
- [ ] Both integrations published, label = SHORT_SHA
- [ ] All 4 test cases pass in both dev and staging
- [ ] API execution returns `data.records` in OAS `KpiRecord[]` shape
- [ ] `docs/PLAN.md` P4 status updated to `DONE (<sha>)`
- [ ] Commit: `git commit -m "P4: application integration sar-kpi-get dev and staging"`

---

## P5 — Apigee Proxy (after P4)

### What to build
Full proxy at `src/main/apigee/apiproxies/sar-mot-kpis-v1/apiproxy/` following `pet-poc` naming.

### Policy table
See the policy table in `docs/PLAN.md` section "P5 — Apigee proxy" for the full table. Key policies:

| Policy | Type | Purpose |
|---|---|---|
| `AM-SetTraceAndTimestamp` | AssignMessage | Set `custom.traceId = {createUuid()}` (D33), `custom.timestamp` = ISO-8601 UTC |
| `KVM-GetConfig` | KeyValueMapOperations | Read from `sar-mot-kpis-config-__KVM_VERSION__` (incl. per-env integration name + trigger name) |
| `JS-ValidateRequestInputs` | JavaScript | Validates X-Request-Id, X-Operator-Id, year, quarter; always sets the `custom.*Valid` flags (D34) |
| `RF-InvalidRequestId` | RaiseFault | `custom.requestIdValid != "true"` (non-UUID X-Request-Id; a missing header is replaced by a platform UUID on Apigee X, D35) → ERR-400-REQUESTID |
| `AM-SetClientTraceId` | AssignMessage | Overwrite `custom.traceId` with `X-Request-Id` header |
| `VA-VerifyApiKey` | VerifyAPIKey | Verify `request.header.x-api-key` |
| `RF-InvalidSecret` | RaiseFault | X-API-Secret ≠ client_secret → ERR-401-SECRET |
| `SA-SpikeArrest` | SpikeArrest | Rates from KVM |
| `Q-ImposeQuota` | Quota | Rates from KVM |
| `JS-ValidateRequestTimestamp` | JavaScript | ISO parse + clock-skew check |
| `RF-InvalidRequestTimestamp` | RaiseFault | ERR-400-TIMESTAMP |
| `RF-InvalidOperatorId` | RaiseFault | `custom.operatorIdValid != "true"` (`^[12]\d{9}$`) → ERR-400-OPERATOR |
| `RF-InvalidQueryParams` | RaiseFault | `custom.yearValid` / `custom.quarterValid != "true"` → ERR-400-PARAMS |
| `AM-SetKpiCode` | AssignMessage | Set `kpi.code = total_freight` |
| `SIR-SetIntegrationRequest` | SetIntegrationRequest | Integration name, trigger name (`api_trigger/sar-kpi-get-<env>`, D22), project, region from KVM |
| `RF-IntegrationError` | RaiseFault | Non-2xx from integration → ERR-500-INTEGRATION |
| `EV-ExtractIntegrationOutput` | ExtractVariables | JSONPath `$.outputParameters.data.records` (D26) |
| `RF-BadGateway` | RaiseFault | `data.records` missing/non-array/> 4 items → ERR-502-GATEWAY |
| `AM-BuildKpiResponse` | AssignMessage | Build 200 response; OAS `data` = the `records` array |
| `RF-MethodNotAllowed` | RaiseFault | ERR-405-METHOD |
| `RF-ResourceNotFound` | RaiseFault | ERR-404-RESOURCE |
| `AM-SetLookupKey` + `KVM-GetErrorMessage` + `AM-BuildErrorResponse` | DefaultFaultRule | Integer error.code, escapeJSON message |
| `AM-SetResponseRequestIdHeader` | AssignMessage | Set X-Request-Id = traceId on every response (the platform still returns the client-sent value, D35) |

### VERIFY items for P5
1. Exact response shape of IntegrationEndpoint — where `data` sits in the JSON (needs debug session).
   The integration output `data` is the object `{"records": [...]}` (D26); confirm the path
   (expected `$.outputParameters.data.records`) and that `records` arrives as a JSON array, not a
   string. If it arrives as a string, `JSON.parse` it in a JS policy before `RF-BadGateway`.
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
