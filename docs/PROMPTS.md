# Per-phase prompts

Paste one prompt per session, in order. Each prompt assumes the agent has read `AGENTS.md`.
In Claude Code, start in plan mode. In Antigravity, use Planning mode and review the plan
artifact before letting it execute.

**Session opener (every time):**
> Read AGENTS.md, docs/PLAN.md, docs/ERROR-CATALOG.md and docs/DECISIONS.md. Tell me which
> phase is next, what you will create or change, which commands need my approval, and which
> VERIFY items you will resolve. Don't execute anything yet.

**P0:**
> Do phase P0. Clone https://github.com/apigee-poc/cicd-workspace into /tmp for reference and
> copy what P0 lists, renaming hello-v1 to sar-mot-kpis-v1. Show me the diff of
> deploy-revision.sh before saving it. Finish with npm ci and npm run lint.

**P1:**
> Do phase P1. Write the infra scripts first and show them to me. Run nothing until I
> approve. After running, show the resulting IAM bindings.

**P2:**
> Do phase P2. Start by resolving the VERIFY item about the Connectors tenant project for
> --allowed-psc-projects and record it in DECISIONS.md. Show the Cloud SQL create command
> and its estimated tier before running it. Then write the migration, seed and load.sh, run
> load.sh dev twice, and prove the row count stays at 7.

**P3:**
> Do phase P3. Resolve VERIFY item 1 against current Google docs first and record the
> outcome. Then create the endpoint attachment (after my approval) and both connections.

**P4:**
> Do phase P4. I've built the first version of the integration in the Console (or: build it
> from JSON). Scaffold it into integration/, refactor to one source plus per-env overrides,
> add the test cases and the two rollback scripts, then apply dev and staging with
> --run-tests.

**P5:**
> Do phase P5 following the policy table in PLAN.md and every row of ERROR-CATALOG.md. Use
> https://github.com/apigee-poc/pet-poc as the style reference for the fault-handling chain,
> applying the differences listed in AGENTS.md. Deploy to the local emulator and show me
> curl output for each error case that doesn't need the integration.

**P6:**
> Do phase P6. Build the Postman collection with one request per catalog row plus the four
> success cases, with schema assertions. Run unit tests and the local subset, then ask me
> before running against dev.

**P7:**
> Do phase P7. Write cloudbuild-pr.yaml and cloudbuild-main.yaml from the step list in
> PLAN.md, reusing the cicd-workspace scripts. Give me the gcloud commands to create the
> triggers, but don't run them.

**P8:**
> Do phase P8 up to the files only: cloudbuild-prod.yaml and the prod env files. List
> exactly what I must run or approve myself. Never execute anything against
> apigee-prod-511508.

**P9:**
> Do phase P9. Write README.md, DEPLOYMENT.md and ACCEPTANCE.md from the actual state of
> the repo and the last pipeline runs.
