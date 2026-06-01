# Agent Memory Hub

Agent Memory Hub is a local-first memory workbench for Codex, Claude, and OpenCode. It archives agent conversations, builds searchable long-term memory, keeps reusable skills isolated from native agent directories, and provides a browser dashboard for review, export, and context recovery.

The project is designed to run fully on your own machine. Docker and EverCore are not required.

## Highlights

- Unified dashboard for Codex, Claude, and OpenCode conversation archives.
- Local SQLite archive with FTS search, redaction, deletion, export, and backup/restore.
- Optional LanceDB vector index for semantic memory; automatically falls back to SQLite FTS when embeddings are not configured.
- Reviewable skill candidates with a strict quality gate to reduce noisy or low-value memories.
- Hub-managed skills stored only under the Hub data directory, never in Codex, Claude, OpenCode, or business project skill folders.
- MCP tools for archive retrieval, local memory search, context packs, and Hub skill lookup.
- DeepSeek/OpenAI-compatible LLM settings with model import from `GET /v1/models`.
- Windows self-contained package with `AgentMemoryHub.exe` and bundled Node runtime.

## Screens

The dashboard includes:

- Overview: sync status, local memory status, session counts, recent tasks.
- Conversations: project/thread/session sidebar, paginated conversation details, call-chain distinction, export and context-pack actions.
- Memory: local case and skill-hint search.
- Skills: candidate review, approval, rejection, Hub skill disable/delete.
- Settings: LLM configuration, background sync, useful feature toggles, backup/restore, health check.

## Requirements

- Windows 10/11 for the bundled launcher and background service scripts.
- Node.js 22+ for development.
- npm 11+ recommended.

Runtime data is stored outside the repository:

- Windows default: `%USERPROFILE%\.memory-hub`
- Override with: `AGENT_HUB_DATA_DIR`

## Quick Start

```powershell
npm install
npm run build
npm run dashboard
```

Open the URL printed by the dashboard process. The desktop launcher scripts create and use a local access token automatically.

## Windows Desktop Entry

Create a desktop command launcher:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-desktop-shortcut.ps1
```

This creates `Agent Memory Hub.cmd` on the desktop. Launching it starts the local dashboard and opens the browser.

## Windows Package

Build a self-contained Windows folder:

```powershell
npm run package:win
```

Output:

```text
release\AgentMemoryHub-win-x64
```

Double-click:

```text
AgentMemoryHub.exe
```

The package includes:

- `AgentMemoryHub.exe`
- bundled `node.exe`
- production `node_modules`
- `dist`
- `web`
- config, rules, and scripts

Native dependencies such as SQLite and LanceDB are kept as files in the package instead of being forced into a fragile single-file executable.

## Configuration

Most settings are configured in the dashboard Settings page.

Supported environment variables:

| Variable | Purpose |
| --- | --- |
| `AGENT_HUB_DATA_DIR` | Hub data directory. |
| `AGENT_HUB_LANCEDB_DIR` | LanceDB vector directory. |
| `AGENT_HUB_SKILLS_DIR` | Hub-managed skills directory. |
| `AGENT_HUB_DASHBOARD_PORT` | Dashboard port, default `43121`. |
| `AGENT_HUB_LLM_BASE_URL` | Initial LLM base URL. |
| `AGENT_HUB_LLM_MODEL` | Initial LLM model. |
| `AGENT_HUB_LLM_API_KEY` | Initial LLM API key. |
| `AGENT_HUB_EMBEDDING_BASE_URL` | Optional embedding base URL. |
| `AGENT_HUB_EMBEDDING_MODEL` | Optional embedding model. |
| `AGENT_HUB_EMBEDDING_API_KEY` | Optional embedding API key. |
| `AGENT_HUB_TRANSCRIPT_ROOTS` | Extra transcript roots separated by `;`. |
| `AGENT_HUB_OPENCODE_DATABASES` | Extra OpenCode databases separated by `;`. |
| `AGENT_HUB_SYNC_USE_LLM` | Set to `true` to allow background sync to spend LLM tokens. |

API keys are masked in API responses and must not be exported, logged, or written into generated skills.

## Skill Isolation

Approved skills are stored only in the Hub data directory:

```text
%USERPROFILE%\.memory-hub\skills\global\<slug>\SKILL.md
%USERPROFILE%\.memory-hub\skills\projects\<project-hash>\<slug>\SKILL.md
```

They are not written to:

- `.codex\skills`
- `.agents\skills`
- Claude skill directories
- OpenCode skill directories
- target business project folders

Agents should load Hub skills through MCP tools such as `hub_skill_search`, `hub_skill_list`, `hub_skill_get`, and `hub_skill_context_pack`.

## MCP Tools

The archive MCP server exposes tools for:

- conversation ingest/search/export
- redacted archive access
- memory build/search
- context-pack generation
- skill candidate review
- Hub skill lookup

Build first:

```powershell
npm run build
```

Then use:

```text
dist\archive-main.js
dist\orchestrator-main.js
```

## CLI

```powershell
npm run ingest
node dist/cli.js export --session-id <id> --format markdown
node dist/cli.js export --session-id <id> --format json
node dist/cli.js prune-skills
```

`prune-skills` rechecks pending skill candidates with the current quality gate and deletes low-value candidates.

## Development

```powershell
npm install
npm run check
```

`npm run check` performs:

- TypeScript build
- unit tests
- dashboard UI flow test

## Security Notes

- The dashboard binds to `127.0.0.1`.
- API routes require a local bearer token stored in the Hub data directory.
- Raw sensitive archive reads require explicit confirmation through MCP.
- Export uses redacted content by default.
- `.env`, local databases, release bundles, logs, and runtime data are ignored by git.

## License

MIT
