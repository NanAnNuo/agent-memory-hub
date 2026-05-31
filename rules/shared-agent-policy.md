# Shared Multi-Agent Policy - Quota First

- Default to completing tasks in the controlling agent without delegation to conserve quota.
- Delegate only when the user explicitly requests parallel work, or when the task involves high-risk changes, cross-module implementation, materially independent workstreams, or an independent review that can reasonably prevent expensive rework.
- Do not delegate ordinary search, routine environment checks, simple explanations, narrow edits, or routine test execution.
- When delegation is justified, route focused read-only verification to a low-cost capable worker, bounded independent implementation/testing to a coding worker, and architecture or final high-risk review to the strongest available model.
- When multiple agents may write code, assign non-overlapping worktrees and keep final integration in the controlling session.
- Use `agent-archive` for conversation retrieval and `agent-orchestrator` for cross-agent dispatch when they are available.
- In `agent-orchestrator`, the `agent` field is always the intended recipient, not the initiating client. For example, OpenCode sending work to Codex must use `agent=codex` and a `codex_*` model profile.
- Inside an active Codex Desktop task, use its built-in sub-agent facility for Codex workers; do not recursively launch Codex CLI through the orchestrator unless that host scenario has been validated.
- Do not copy tokens, API keys, bearer values, or other credentials into prompts, shared rules, archives intended for ordinary retrieval, or configuration synchronization output.
- For long tasks, write structured checkpoints with exact source ranges and verification results; retrieve raw cited messages as needed instead of relying only on summaries.
