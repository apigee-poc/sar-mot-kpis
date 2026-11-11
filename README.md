# sar-mot-kpis — starter kit

Agent-ready plan for the SAR → MOT KPI Data Sharing POC (Apigee X → Application Integration → Integration Connectors → private Cloud SQL), with CI/CD in Cloud Build.

1. Create the GitHub repo `apigee-poc/sar-mot-kpis` and copy these files to its root (including the hidden `.claude/` and `.agent/` folders).
2. Open the folder in VS Code (Claude Code in the terminal) or Antigravity.
3. Paste the session opener from `docs/PROMPTS.md`, then the P0 prompt.

| File | Purpose |
|---|---|
| `AGENTS.md` | Rules and fixed facts for any agent |
| `CLAUDE.md`, `.claude/settings.json` | Claude Code entry point and permission guardrails |
| `.agent/rules/sar-mot-kpis.md` | Antigravity workspace rule |
| `docs/PLAN.md` | Phases P0–P9 with acceptance criteria |
| `docs/ERROR-CATALOG.md` | Every error case → status, KVM key, message |
| `docs/DECISIONS.md` | Decisions so far; agents append findings |
| `docs/PROMPTS.md` | One prompt per phase |
| `api/sar-mot-kpis-oas.yaml` | OAS v1.0.1 (404 and 502 added) |
