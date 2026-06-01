# Agent Memory Hub

[中文](#简体中文) | [English](#english)

---

## 简体中文

Agent Memory Hub 是一个本地优先的 Agent 记忆工作台，面向 Codex、Claude 和 OpenCode。它可以归档 Agent 对话，构建可检索的长期记忆，将可复用 skill 与原生 Agent 目录隔离，并提供浏览器可视化页面用于审核、导出和恢复上下文。

项目可完整运行在本机，不需要 Docker，也不依赖 EverCore。

[Switch to English](#english)

### 核心功能

- 统一管理 Codex、Claude、OpenCode 的历史会话归档。
- 使用 SQLite 保存本地归档，支持 FTS 检索、敏感信息脱敏、删除、导出、备份和恢复。
- 可选 LanceDB 向量索引，用于语义记忆；未配置 embedding 时自动降级为 SQLite FTS。
- Skill 候选进入审核前会经过严格质量门槛，减少低价值和噪声沉淀。
- 批准后的 skill 只保存在 Hub 数据目录，不写入 Codex、Claude、OpenCode 或业务项目目录。
- 提供 MCP 工具，用于归档检索、本地记忆搜索、上下文恢复包和 Hub skill 查询。
- 支持 DeepSeek/OpenAI-compatible 模型配置，并可从 `GET /v1/models` 导入模型列表。
- 支持 Windows 自包含发布包，包含 `AgentMemoryHub.exe` 和内置 Node 运行时。

### 页面

Dashboard 包含：

- 总览：同步状态、本地记忆状态、会话数量、最近任务。
- 会话：项目/线程/会话侧栏、分页对话详情、调用链区分、导出和上下文恢复。
- 记忆：本地 case 与 skill hint 检索。
- Skills：候选审核、批准、不通过删除、Hub skill 禁用/删除。
- 设置：LLM 配置、后台同步、实用功能开关、备份恢复、健康检查。

### 环境要求

- Windows 10/11：用于打包启动器和后台服务脚本。
- Node.js 22+：用于开发。
- 推荐 npm 11+。

运行数据默认保存在仓库外：

- Windows 默认：`%USERPROFILE%\.memory-hub`
- 可通过 `AGENT_HUB_DATA_DIR` 覆盖。

### 快速开始

```powershell
npm install
npm run build
npm run dashboard
```

打开 dashboard 进程输出的本地 URL。桌面启动脚本会自动创建并使用本地访问 token。

### Windows 桌面入口

创建桌面启动命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-desktop-shortcut.ps1
```

该命令会在桌面创建 `Agent Memory Hub.cmd`。双击后会启动本地 dashboard 并打开浏览器。

### Windows 打包

构建自包含 Windows 目录：

```powershell
npm run package:win
```

输出目录：

```text
release\AgentMemoryHub-win-x64
```

双击运行：

```text
AgentMemoryHub.exe
```

发布包包含：

- `AgentMemoryHub.exe`
- 内置 `node.exe`
- 生产依赖 `node_modules`
- `dist`
- `web`
- config、rules、scripts

SQLite 和 LanceDB 等 native 依赖会作为文件保留在发布目录中，不强行塞入脆弱的单文件 exe。

### 配置

大部分配置可在 Dashboard 的 Settings 页面完成。

支持的环境变量：

| 变量 | 说明 |
| --- | --- |
| `AGENT_HUB_DATA_DIR` | Hub 数据目录。 |
| `AGENT_HUB_LANCEDB_DIR` | LanceDB 向量目录。 |
| `AGENT_HUB_SKILLS_DIR` | Hub 管理的 skill 目录。 |
| `AGENT_HUB_DASHBOARD_PORT` | Dashboard 端口，默认 `43121`。 |
| `AGENT_HUB_LLM_BASE_URL` | 初始 LLM base URL。 |
| `AGENT_HUB_LLM_MODEL` | 初始 LLM 模型。 |
| `AGENT_HUB_LLM_API_KEY` | 初始 LLM API key。 |
| `AGENT_HUB_EMBEDDING_BASE_URL` | 可选 embedding base URL。 |
| `AGENT_HUB_EMBEDDING_MODEL` | 可选 embedding 模型。 |
| `AGENT_HUB_EMBEDDING_API_KEY` | 可选 embedding API key。 |
| `AGENT_HUB_TRANSCRIPT_ROOTS` | 额外 transcript 根目录，使用 `;` 分隔。 |
| `AGENT_HUB_OPENCODE_DATABASES` | 额外 OpenCode 数据库，使用 `;` 分隔。 |
| `AGENT_HUB_SYNC_USE_LLM` | 设为 `true` 时允许后台同步消耗 LLM token。 |

API key 会在 API 响应中被遮蔽，不应被导出、写入日志或写入生成的 skill。

### Skill 隔离

批准后的 skill 只写入 Hub 数据目录：

```text
%USERPROFILE%\.memory-hub\skills\global\<slug>\SKILL.md
%USERPROFILE%\.memory-hub\skills\projects\<project-hash>\<slug>\SKILL.md
```

不会写入：

- `.codex\skills`
- `.agents\skills`
- Claude skill 目录
- OpenCode skill 目录
- 目标业务项目目录

Agent 应通过 MCP 工具加载 Hub skill，例如 `hub_skill_search`、`hub_skill_list`、`hub_skill_get` 和 `hub_skill_context_pack`。

### MCP 工具

Archive MCP server 提供：

- 会话导入、检索、导出
- 脱敏归档访问
- 记忆构建与检索
- 上下文恢复包生成
- Skill 候选审核
- Hub skill 查询

先构建：

```powershell
npm run build
```

入口文件：

```text
dist\archive-main.js
dist\orchestrator-main.js
```

### CLI

```powershell
npm run ingest
node dist/cli.js export --session-id <id> --format markdown
node dist/cli.js export --session-id <id> --format json
node dist/cli.js prune-skills
```

`prune-skills` 会使用当前质量门槛重新检查 pending skill 候选，并删除低价值候选。

### 开发

```powershell
npm install
npm run check
```

`npm run check` 会执行：

- TypeScript 构建
- 单元测试
- Dashboard UI 流程测试

### 安全说明

- Dashboard 只绑定到 `127.0.0.1`。
- API 路由需要本地 bearer token。
- MCP 读取 raw sensitive archive 时需要显式确认。
- 导出默认使用脱敏内容。
- `.env`、本地数据库、发布包、日志和运行时数据均被 git 忽略。

### 许可证

MIT

---

## English

Agent Memory Hub is a local-first memory workbench for Codex, Claude, and OpenCode. It archives agent conversations, builds searchable long-term memory, keeps reusable skills isolated from native agent directories, and provides a browser dashboard for review, export, and context recovery.

The project runs fully on your own machine. Docker and EverCore are not required.

[切换到中文](#简体中文)

### Highlights

- Unified dashboard for Codex, Claude, and OpenCode conversation archives.
- Local SQLite archive with FTS search, redaction, deletion, export, and backup/restore.
- Optional LanceDB vector index for semantic memory; automatically falls back to SQLite FTS when embeddings are not configured.
- Reviewable skill candidates with a strict quality gate to reduce noisy or low-value memories.
- Hub-managed skills stored only under the Hub data directory, never in Codex, Claude, OpenCode, or business project skill folders.
- MCP tools for archive retrieval, local memory search, context packs, and Hub skill lookup.
- DeepSeek/OpenAI-compatible LLM settings with model import from `GET /v1/models`.
- Windows self-contained package with `AgentMemoryHub.exe` and bundled Node runtime.

### Screens

The dashboard includes:

- Overview: sync status, local memory status, session counts, recent tasks.
- Conversations: project/thread/session sidebar, paginated conversation details, call-chain distinction, export and context-pack actions.
- Memory: local case and skill-hint search.
- Skills: candidate review, approval, rejection, Hub skill disable/delete.
- Settings: LLM configuration, background sync, useful feature toggles, backup/restore, health check.

### Requirements

- Windows 10/11 for the bundled launcher and background service scripts.
- Node.js 22+ for development.
- npm 11+ recommended.

Runtime data is stored outside the repository:

- Windows default: `%USERPROFILE%\.memory-hub`
- Override with: `AGENT_HUB_DATA_DIR`

### Quick Start

```powershell
npm install
npm run build
npm run dashboard
```

Open the URL printed by the dashboard process. The desktop launcher scripts create and use a local access token automatically.

### Windows Desktop Entry

Create a desktop command launcher:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-desktop-shortcut.ps1
```

This creates `Agent Memory Hub.cmd` on the desktop. Launching it starts the local dashboard and opens the browser.

### Windows Package

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

### Configuration

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

### Skill Isolation

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

### MCP Tools

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

### CLI

```powershell
npm run ingest
node dist/cli.js export --session-id <id> --format markdown
node dist/cli.js export --session-id <id> --format json
node dist/cli.js prune-skills
```

`prune-skills` rechecks pending skill candidates with the current quality gate and deletes low-value candidates.

### Development

```powershell
npm install
npm run check
```

`npm run check` performs:

- TypeScript build
- unit tests
- dashboard UI flow test

### Security Notes

- The dashboard binds to `127.0.0.1`.
- API routes require a local bearer token stored in the Hub data directory.
- Raw sensitive archive reads require explicit confirmation through MCP.
- Export uses redacted content by default.
- `.env`, local databases, release bundles, logs, and runtime data are ignored by git.

### License

MIT
