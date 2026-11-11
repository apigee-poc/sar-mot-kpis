@AGENTS.md

## Claude Code notes

- Start each session with: "Read AGENTS.md and docs/PLAN.md, then tell me which phase is next and what you will do."
- Use plan mode (Shift+Tab) for the first pass of every phase; switch to edit mode only after the plan is approved.
- Permissions are pre-set in `.claude/settings.json`: read-only and lint/test commands run freely; every `gcloud`, `integrationcli`, `mvn` deploy and `curl` call asks first; destructive commands are denied.
- Ready-made prompts for each phase are in `docs/PROMPTS.md`.
