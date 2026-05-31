# Agent Memory Hub

Local memory workbench for Codex, Claude Code, and OpenCode. This project is a fork of the original Agent Collaboration Hub and adds:

- EverCore semantic agent memory sync and search.
- A local visual dashboard for conversations, memory, skill candidates, and exports.
- Human-approved skill promotion with strict global/project separation.
- Desktop shortcut launcher for Hub + EverCore.

## Quick Start

```powershell
npm install
npm run check
.\scripts\install-desktop-shortcut.ps1
```

Then open **Agent Memory Hub** from the Windows desktop.
On this Windows profile the reliable desktop entry is `Agent Memory Hub.cmd`; it starts the local service and opens the visual dashboard.

## EverCore

Defaults:

- `AGENT_HUB_EVERCORE_ROOT=D:\桌面\工作文件夹\项目\日常通用任务处理\EverOS\methods\EverCore`
- `AGENT_HUB_EVERCORE_URL=http://127.0.0.1:1995`
- `AGENT_HUB_EVERCORE_USER_ID=agent-hub-local`

The launcher starts Docker Compose in the EverCore root and starts the EverCore API when the port is not already listening. It does not create or manage `.env`; copy EverCore `env.template` to `.env` and fill the required LLM/vector keys first.

## Skill Rules

- Global skills are written to both `C:\Users\22289\.codex\skills\learned-<slug>\SKILL.md` and `C:\Users\22289\AppData\Local\Claude-3p\skills\learned-<slug>\SKILL.md`.
- Project skills are written to `<project>\.project-skills\<slug>\SKILL.md`.
- Project skills are not included by `-PublishPortableSkills`.
- Every skill promotion requires explicit `approved=true`.

## Dashboard Features

- Conversation search across Codex, Claude, and OpenCode archives.
- Session detail view with redacted source anchors.
- EverCore `agent_memory` search for cases and skills.
- Skill candidate review and approval.
- Redacted Markdown and JSON session export.

## Checks

```powershell
npm run check
```
