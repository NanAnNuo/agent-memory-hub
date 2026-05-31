# Agent Memory Hub

Local memory workbench for Codex, Claude, and OpenCode.

## Features

- Unified sidebar for archived agent conversations.
- Local SQLite archive with FTS search and redacted export.
- Lightweight local memory items for cases, skill hints, and optional profiles.
- Hub-managed skill promotion under the Hub data directory only.
- DeepSeek/OpenAI-compatible settings with model import from `/v1/models`.
- MCP tools for archive search, local memory, context packs, and Hub skills.

## Launch

Use the desktop entry `Agent Memory Hub.cmd`, or run:

```powershell
npm run build
npm run dashboard
```

The launcher starts only Agent Memory Hub. Docker and EverCore are not required.

## Data Locations

- Archive database: `C:\Users\22289\.memory-hub\archive.db`
- Local vector directory: `C:\Users\22289\.memory-hub\lancedb`
- Hub skills: `C:\Users\22289\.memory-hub\skills`
- Exports: `C:\Users\22289\.memory-hub\exports`

Approved skills are never written to Codex, Claude, OpenCode, or business project skill directories. Agents should load them through the Hub MCP tools.

## Settings

The Settings page supports DeepSeek/OpenAI-compatible providers:

- `base_url`
- API key
- model imported from `GET /v1/models`
- optional embedding endpoint/model
- optional profile memory
- optional background sync flag

API keys are masked in API responses and must not be exported, logged, or written into generated skills.

## Skill Rules

- Global skills: `C:\Users\22289\.memory-hub\skills\global\<slug>\SKILL.md`
- Project skills: `C:\Users\22289\.memory-hub\skills\projects\<project-hash>\<slug>\SKILL.md`
- Project scope is enforced by metadata and MCP filtering, not by writing into the project folder.
