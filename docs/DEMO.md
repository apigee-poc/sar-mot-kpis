# Acceptance demo — script and notes

**Status: TO BE RECORDED by the user. Nothing in this file has been recorded or run yet.**
An agent prepared it offline (P9). Parts 3 and 4 need the pipelines to exist and run first. Record
each part as a separate clip; that makes it easier to retake one. After recording, add the clip
links and the build ids to the "Recording log" at the end, and update `docs/ACCEPTANCE.md`.

| Part | Shows | Environment | Prerequisite (👤) |
|---|---|---|---|
| 1 | Success cases (4 happy paths) | staging (or dev) | Non-prod is live (true today for dev) |
| 2 | Three error cases | staging (or dev) | as part 1 |
| 3 | A failing commit rolled back automatically | dev (staging untouched) | P7 triggers exist: git remote, Cloud Build connection, `sar-mot-kpis-pr` and `sar-mot-kpis-main` (DEPLOYMENT.md "CI/CD triggers (not created yet)") |
| 4 | Prod promotion | prod (through the pipeline only) | the whole P8 checklist up to item 14 (DEPLOYMENT.md "What YOU must run/approve") |

## Before recording: keep secrets off the screen

- Never show a key, a secret, a token or a password: not in the terminal, not in the Console,
  and not in Postman's environment panel. AGENTS.md rule 4 applies to recordings too.
- Load the credentials into shell variables **silently**, before the recording starts or with the
  terminal hidden. Never `echo` them. They are passed to `curl` as headers, so they are visible in
  the local process list while curl runs (the same accepted POC risk as D44).
- Use a fresh terminal with a short prompt and a large font.
- Cloud Build logs show no secrets: the scripts never print them, and the stamped description holds
  only the commit and build id.

```bash
# --- setup, run off camera (Git Bash; needs gcloud auth and secretAccessor on these secrets) ---
ENV_HOST="https://staging.35.201.86.122.nip.io"     # or https://35.201.86.122.nip.io for dev
BASE="/mot-kpis/business-domain/v1"
API_KEY="$(gcloud secrets versions access latest --secret=sar-mot-poc-app-api-key --project=apigee-nonprod-511322)"
API_SECRET="$(gcloud secrets versions access latest --secret=sar-mot-poc-app-api-secret --project=apigee-nonprod-511322)"

# kpi <METHOD> <path?query> [extra curl args]: one request with every required header.
# X-Request-Id is a fresh UUID, X-Request-Timestamp is "now" in UTC (the allowed skew is 300 s),
# X-Operator-Id matches ^[12]\d{9}$ (the test value of the Postman environments).
kpi() {
  local method="$1" path="$2"; shift 2
  local rid; rid="$(node -e 'console.log(require("crypto").randomUUID())')"
  echo ">>> ${method} ${path}   X-Request-Id: ${rid}"
  curl -sS -X "${method}" "${ENV_HOST}${BASE}${path}" \
    -H "X-API-Key: ${API_KEY}" -H "X-API-Secret: ${API_SECRET}" \
    -H "X-Request-Id: ${rid}" \
    -H "X-Request-Timestamp: $(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
    -H "X-Operator-Id: 1000124102" \
    -D - "$@"
  echo
}
```

`-D -` prints the response headers, so the `X-Request-Id` echo is visible. Pipe the body through
`node -e` or `jq` for pretty JSON if you like. The body never contains credentials.

## Part 1 — Success cases (about 2 min)

Narration: "MOT calls one read-only endpoint. Apigee checks the key, the secret and the headers,
calls Application Integration, which queries the private Cloud SQL database through Integration
Connectors."

1. Show `api/sar-mot-kpis-oas.yaml` briefly: the path, the five headers, and the `KpiRecord` schema.
2. Run the four happy paths:

   ```bash
   kpi GET "/kpis/total_freight?year=2025"            # 200, data = Q1–Q3 2025
   kpi GET "/kpis/total_freight?year=2025&quarter=3"  # 200, one record, actual 1512750
   kpi GET "/kpis/total_freight?year=2026"            # 200, "data": []  (no data is not an error)
   kpi GET "/kpis/total_freight?year=2024"            # 200, four quarters
   ```

3. Point out: `header.isSuccess: true`; `header.traceId` equals the `X-Request-Id` that was sent
   and the `X-Request-Id` response header; the ISO-8601 UTC `timestamp`; `loadTime` in UTC.
4. Optional: run the whole suite on screen. It reads the credentials itself and never prints them.
   `npm run test:staging` (or `npm run test:dev`). Expected: 24 requests, 0 failures. The 10
   fault-injection requests are skipped.

## Part 2 — Three error cases (about 2 min)

Narration: "Every error uses the same envelope. `error.code` is the integer HTTP status, the
message comes from a versioned KVM, and the trace ID is always returned."

```bash
# 1. Bad query parameter -> 400 ERR-400-PARAMS (catalog row 12)
kpi GET "/kpis/total_freight?year=2025&quarter=5"

# 2. Wrong secret -> 401 (catalog row 4). The message does not say whether the key or the secret was wrong.
API_SECRET_SAVED="${API_SECRET}"; API_SECRET="wrong-secret"
kpi GET "/kpis/total_freight?year=2025"
API_SECRET="${API_SECRET_SAVED}"; unset API_SECRET_SAVED

# 3. Known path, wrong verb -> 405 with "Allow: GET" (catalog row 11).
#    --data "" sends Content-Length: 0; without a body the Google front end answers 411.
kpi POST "/kpis/total_freight?year=2025" --data ""
```

Expected messages are verbatim from `docs/ERROR-CATALOG.md`:

| Case | Status | `error.message` |
|---|---|---|
| quarter=5 | 400 | Query parameter 'quarter' must be an integer between 1 and 4, and 'year' must be a valid 4-digit Gregorian year (2000-2099). |
| wrong secret | 401 | Invalid or missing credentials in 'X-API-Key' or 'X-API-Secret' headers. |
| POST | 405 | HTTP method not allowed. Only 'GET' operations are supported on this endpoint. |

Optional extras: `kpi GET "/kpis/nope?year=2025"` gives 404 (row 10). Show
`docs/ACCEPTANCE.md` to say that all 16 rows are covered (rows 6, 7, 13 and 16 by fault injection
on dev; rows 14 and 15 waived to unit tests).

## Part 3 — A failing commit is rolled back automatically (about 5 min, plus build time)

Goal (PLAN P7 acceptance): a commit that passes lint and unit tests but breaks the API reaches dev.
Newman fails, the pipeline rolls dev back (proxy first, then integration), and **staging is not
touched**.

A broken unit test is **not** a good demo. `cloudbuild-main.yaml` would stop at `unit-tests`,
before anything is deployed, so nothing would be rolled back. Use a configuration mistake that the
static tests allow but the live suite catches: a dev quota of 2 requests per minute. The Newman run
then gets 429 from its third credentialed request onwards.

1. Show that dev and staging are green: the last `sar-mot-kpis-main` build is SUCCESS. Note the
   dev and staging proxy revisions and integration versions from its `summary` step.
2. Create the breaking change on a branch:

   ```bash
   git switch -c demo/break-dev-quota main
   # In src/main/apigee/environments/dev/kvms/sar-mot-kpis-config.json change
   #   { "name": "quotaLimit", "value": "1000" }   ->   { "name": "quotaLimit", "value": "2" }
   npm run lint && npm run test:unit      # must pass: kvm-contract checks quotaLimit only against ^[1-9][0-9]*$ (no cross-env comparison)
   git commit -am "DEMO: break dev quota (expected to roll back)"
   git push -u origin demo/break-dev-quota
   ```

3. Open the PR. Show `sar-mot-kpis-pr` going green (the change is statically valid). Merge it.
   **Merge nothing else** until part 3 is finished (concurrent builds, D58).
4. In Cloud Build → History, follow `sar-mot-kpis-main`:
   - `apply-int-dev` / `assert-int-dev` pass, so the integration is published with the new label;
   - `create-kvm-dev` creates `sar-mot-kpis-config-<SHA>` with `quotaLimit` 2, and `deploy-dev`
     deploys a new revision;
   - `test-dev` prints `Dev tests failed!` (429 "Rate limit has been exceeded." on most requests);
   - `check-dev-test` prints `Rolling back the proxy, then the integration...`, then
     `SUCCESS: Rollback complete. Revision <prev> is active and READY in dev.`, then the integration
     `SUCCESS: Rollback complete. Version <new id> (content of <prev>) is ACTIVE ...`, then
     `Pipeline halted: dev failed and dev was rolled back; staging was not touched.`;
   - no staging step ran. The build status is FAILURE.
5. Prove the result on camera:
   - Apigee → Proxies → `sar-mot-kpis-v1` → Deployments: dev is on the previous revision, and
     staging is unchanged.
   - Run `npm run test:dev` (or `kpi` against dev): green again.
6. Revert through the normal flow: `git revert <demo commit>` on a branch, PR, merge. The next
   `sar-mot-kpis-main` build must be green through dev **and** staging.

If a rollback prints `manual intervention required`, stop the demo and follow DEPLOYMENT.md
"Rollback and manual intervention (dev and staging)".

## Part 4 — Prod promotion (about 5 min, plus build time)

Goal (PLAN P8 acceptance): prod gets **byte for byte** the revision that passed staging, after an
approval. Prod is changed only by the pipeline (AGENTS.md rule 2).

Prerequisite: the P8 checklist items 1–14 in DEPLOYMENT.md "What YOU must run/approve" are done.
That includes the prod triggers, commands E/F and an approved `sar-mot-kpis-infra-prod` run.

1. Show the "Before approving" check: the most recent `sar-mot-kpis-main` build is SUCCESS for the
   commit you promote, and none is running.

   ```bash
   gcloud builds list --region=us-central1 --project=ci-cd-511313 --limit=5 \
     --filter='substitutions.TRIGGER_NAME="sar-mot-kpis-main"' \
     --format="table(id,status,substitutions.COMMIT_SHA,createTime)"
   gcloud builds list --region=us-central1 --project=ci-cd-511313 --ongoing
   ```

2. Start the release at that commit. The trigger waits for approval:
   `gcloud builds triggers run sar-mot-kpis-prod --sha=<40-hex COMMIT_SHA> --region=us-central1 --project=ci-cd-511313`
3. Show the pending build. As an approver: Cloud Build → History → the build → **Approve**.
4. Walk through the log:
   - `guard-target`;
   - `find-staging-revision` (READY staging revision);
   - `check-commit` (the stamp `sar-mot-kpis-v1 | commit <SHORT_SHA> | build <id>` equals this build's commit);
   - `db-load-prod`;
   - `apply-int-prod` / `assert-int-prod`;
   - `copy-revision-prod` (no Maven, no stamp; the imported prod revision is read back and its description compared);
   - `create-kvm-prod`, `debugmask-prod`, `deploy-prod`, `wait-prod`, `verify-sa-prod`
     (`sa-kpi-proxy-runtime@apigee-prod-511508`);
   - `smoke-prod` (`Happy paths`, 4 requests);
   - `check-prod`.
5. Show the `summary` step: commit, source revision and description, and the prod revision and
   integration version before and after.
6. Do **not** call prod with the MOT credentials on camera. The smoke run is the evidence. The
   `mot-app` credentials are handed over out of band (DEPLOYMENT.md).

If the release fails, `check-prod` rolls back automatically. A timeout, a cancel or a failed
rollback needs the Console-only steps in DEPLOYMENT.md "Rollback behaviour and manual
intervention".

## Recording log (fill in after recording)

| Part | Date | Clip link | Build id(s) | Revisions / versions | Result |
|---|---|---|---|---|---|
| 1 Success cases | | | n/a | | |
| 2 Error cases | | | n/a | | |
| 3 Failing commit rolled back | | | main (break), main (revert) | | |
| 4 Prod promotion | | | prod release | | |
