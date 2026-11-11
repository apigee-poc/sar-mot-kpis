# Fault injection on dev (P6, catalog rows 6, 7, 13, 16)

These runs prove the error rows that a normal deploy cannot produce (D39 recipes, D45). They
run on **dev only** (`apigee-nonprod-511322` / `dev` are hard-coded in the scripts), **one
scenario at a time**, and every deploy needs approval (AGENTS.md rule 3). Rows 14 and 15 are
waived (D44).

Each scenario deploys a scratch revision whose config KVM differs from the normal dev config in
exactly one entry. The requests in `Fault injection (needs scratch config)` are **skipped**
unless the run sets `--env-var faultScenario=<scenario>`, so a full-collection run against a
normal deploy never sends them.

## Procedure (per scenario)

```bash
bash scripts/fi-deploy.sh fi06          # records the baseline once, deploys the scratch revision, waits READY + 60 s
bash tests/run-newman.sh dev --folder "FI-06 SpikeArrest 429" --env-var faultScenario=fi06
bash scripts/fi-restore.sh              # redeploys the baseline revision and checks it is live
```

Several scenarios may be run back to back before one restore: the baseline is recorded only by
the first `fi-deploy.sh` and kept until `fi-restore.sh` succeeds. Do not send other requests
with the test app during a run (rate windows are per app).

| Scenario | Config override | Folder (`--folder`) | `faultScenario` | Requests run | Expected |
|---|---|---|---|---|---|
| `fi06` | `spikeArrestRate=2pm` | `FI-06 SpikeArrest 429` | `fi06` | 5 | A 200 (data = 2025 full year); B, C, D 200 or 429; E **429** "Rate limit has been exceeded." |
| `fi07` | `quotaLimit=2` (interval 1 minute, unchanged) | `FI-07 Quota 429` | `fi07` | 3 | A waits for a minute with ≥ 20 s left; A 200, B 200, C **429** "Rate limit has been exceeded." |
| `fi13` | `triggerName=api_trigger/does-not-exist` | `FI-13 Integration failure 500` | `fi13` | 1 | **500** "An unexpected error occurred. Quote the traceId when contacting support." |
| `fi16` | `spikeArrestRate=abc` | `FI-16 Unmapped fault 500` | `fi16` | 1 | **500** same message as row 13 (ERR-SYS-500) |
| `fi16b` | `quotaTimeUnit=fortnight` | `FI-16 Unmapped fault 500` | `fi16b` | 1 | fallback for row 16, only if `fi16` returned 200 |

**0 executed requests means the scenario did not run** (requests skipped: `faultScenario` missing or wrong), even though Newman exits 0. `tests/run-newman.sh` refuses an FI folder without the matching `faultScenario`, refuses the parent folder, and refuses FI folders outside dev. The JUnit report of a scenario run is `reports/newman-dev-<scenario>.xml`, so back-to-back scenarios keep their own evidence.

All shared contract checks apply to every request (schema, `error.code` number = status,
timestamp, trace ID = `X-Request-Id`).

Expected script output, in order: `Baseline recorded: revision N` (or `... (kept)`), the KVM
creation lines for `sar-mot-kpis-config-<scenario>-<sha>-<minutes>` and `...-errors-...`,
`Override set: ...`, `Deploying ...`, the `wait-for-deployment` state lines ending in `READY`,
`Revision M is READY; waiting 60s ...`. `fi-restore.sh` ends with `Restored revision N`.

## Notes

- **fi13:** start a debug session before the run and record whether the IntegrationEndpoint
  raised a fault (and its `fault.name`) or returned a non-2xx response (V3/V9, D39). Rows 13 and
  16 have the same client message, so the HTTP response alone cannot show which path ran.
- **fi16:** an invalid `<Rate>` value is expected to raise `FailedToResolveSpikeArrestRate`
  (500), which has no entry in the error KVM, so `AM-SetSystemError` returns `ERR-SYS-500`. The
  docs do not state what a resolved-but-invalid rate does (VERIFY, D45). If the request returns
  **200**, the rate fell back to the literal `30pm`: restore and run `fi16b`. Record the fault
  name seen in a debug session in `docs/DECISIONS.md`.
- **fi06:** with `UseEffectiveCount=true` SpikeArrest uses a sliding one-minute window, so up to
  2 requests can pass; the counts sync across message processors asynchronously, hence the
  tolerant B–D and the strict 429 on E.
- **Safety:** `fi-deploy.sh` refuses to run if `src/main/apigee/apiproxies` has uncommitted
  changes, because it always reverts the `__KVM_VERSION__` stamp with `git checkout`.
  The access token is passed to Maven as `-Dbearer` (visible in the local process list while
  Maven runs) and is filtered out of Maven's output.
- **Cleanup:** nothing is deleted automatically. Scratch revisions and KVMs are listed in
  `.fi-state/history.log` (gitignored); delete them by hand after approval.
