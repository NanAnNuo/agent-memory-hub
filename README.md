# Agent Memory Hub

[简体中文](#简体中文) | [English](#english)

---

## 简体中文

Agent Memory Hub 是一个本地优先的 Agent 记忆工作台，用来统一保存 Codex、Claude、OpenCode 的历史会话，生成可检索的长期记忆，并把高价值经验沉淀为隔离的 Hub skill。

它的重点不是替代 Agent，而是让 Agent 在开始任务前能通过 MCP 找回项目历史、经验规则和上下文包。

本项目不需要 Docker，不依赖 EverCore。默认使用 SQLite；可选使用 LanceDB 做语义检索。

[Switch to English](#english)

### 适合谁使用

- 你经常同时使用 Codex、Claude、OpenCode。
- 你希望 Agent 记住长期项目背景，而不是每次从零开始。
- 你希望多个 Agent 共享同一套历史会话、记忆和 skill。
- 你希望 skill 先进入人工审核，不自动污染 Codex/Claude/OpenCode 原生 skill 目录。
- 你需要从被删除或找不到的 Agent 会话中恢复上下文。

### 一分钟开始

```powershell
git clone https://github.com/NanAnNuo/agent-memory-hub.git
cd agent-memory-hub
npm install
npm run build
npm run dashboard
```

启动后打开终端输出的本地地址。

默认数据目录：

```text
%USERPROFILE%\.memory-hub
```

### 推荐使用方式

第一次使用建议按这个顺序：

1. 启动 Dashboard。
2. 点击“同步会话”，把 Codex/Claude/OpenCode 历史会话导入 Hub。
3. 在“会话”页按项目查看历史对话。
4. 在“设置”页配置 DeepSeek 或 OpenAI-compatible LLM。
5. 在“记忆”页检索历史经验。
6. 在“Skills”页审核候选 skill。
7. 将 Hub MCP 接入 Claude / Codex，让 Agent 开始任务前自动查询 Hub。

### 启动 Dashboard

开发模式：

```powershell
npm run dashboard
```

如果还没有构建：

```powershell
npm run build
npm run dashboard
```

Dashboard 默认监听：

```text
http://127.0.0.1:43121
```

API 需要本地 token。桌面启动脚本会自动创建 token 并打开带 token 的页面。

### 创建桌面入口

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-desktop-shortcut.ps1
```

执行后桌面会出现：

```text
Agent Memory Hub.cmd
```

双击它会启动 Hub 并打开浏览器页面。

### 接入 Claude Desktop

发布包用户可直接双击解压目录中的 `Register-MCP.cmd`。源码运行时使用下面命令：

先确保已经构建：

```powershell
npm run build
```

然后注册 MCP：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-integrations.ps1 -RegisterMcp -AllowExistingCredentialUse
```

该脚本会写入 Claude-3p 配置：

```text
%LOCALAPPDATA%\Claude-3p\claude_desktop_config.json
```

会添加两个 MCP server：

```text
agent-archive
agent-orchestrator
```

修改后需要完全退出并重启 Claude Desktop / Claude-3p。

在 Claude 新对话中可以这样触发：

```text
先用 Agent Memory Hub MCP 恢复当前项目上下文，再继续。
```

如果 Claude 没有调用 Hub，可以更明确地说：

```text
请先调用 agent-archive / memory_search 搜索当前项目历史会话和 Hub skills。
```

### 接入 Codex

注册 MCP：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-integrations.ps1 -RegisterMcp -AllowExistingCredentialUse
```

脚本会在检测到 `codex` CLI 时注册：

```text
agent-archive
agent-orchestrator
```

之后 Codex 可以通过 MCP 搜索历史会话、构建记忆、读取 Hub skill 和生成上下文恢复包。

### 同步会话

Dashboard 中点击：

```text
总览 -> 立即同步
```

或：

```text
会话 -> 同步会话
```

CLI 导入：

```powershell
npm run ingest
```

默认会尝试读取：

```text
%USERPROFILE%\.codex\sessions
%USERPROFILE%\.claude\projects
%USERPROFILE%\.local\share\opencode\opencode.db
```

可通过环境变量增加来源：

```powershell
$env:AGENT_HUB_TRANSCRIPT_ROOTS="D:\path\to\sessions;D:\another\root"
$env:AGENT_HUB_OPENCODE_DATABASES="D:\path\to\opencode.db"
```

### 后台自动同步

在 Dashboard 设置页开启：

```text
设置 -> 记忆与同步 -> 开机启动同步服务
```

开启后会创建 Windows 用户级登录启动任务。后台同步只负责归档和生成候选，不会自动批准或发布 skill。

### 配置 LLM

进入：

```text
设置 -> 模型配置
```

填写：

```text
Base URL
API Key
```

然后点击：

```text
导入模型
```

Hub 会调用 OpenAI-compatible 接口：

```text
GET /v1/models
```

如果模型列表接口不可用，可以在“手动模型名”中填写模型名。

DeepSeek 示例：

```text
Base URL: https://api.deepseek.com
Model: deepseek-chat
```

API key 会被遮蔽，不会写入导出内容、日志或 skill 文件。

### 使用记忆检索

在 Dashboard：

```text
记忆 -> 输入 query -> 检索记忆
```

未配置 embedding 时使用 SQLite FTS 关键词检索。配置 embedding 后会写入 LanceDB，用于语义检索。

MCP 中可用的典型工具包括：

```text
memory_search
memory_build_from_session
memory_get_context_pack
hub_skill_search
hub_skill_list
hub_skill_get
hub_skill_context_pack
```

### 沉淀 Skill

Hub 不会把 skill 直接写进 Codex、Claude 或 OpenCode 原生目录。

批准后的 skill 只保存到：

```text
%USERPROFILE%\.memory-hub\skills\global\<slug>\SKILL.md
%USERPROFILE%\.memory-hub\skills\projects\<project-hash>\<slug>\SKILL.md
```

候选 skill 的来源：

1. Hub 根据同步后的会话自动生成候选。
2. Agent 通过 MCP 主动创建候选。
3. 用户在 Dashboard 手动创建候选。

候选进入列表前会经过质量门槛。只有具备明确功能、应用场景、可复用步骤和验证结果的经验才应该保留。

清理低价值候选：

```powershell
node dist/cli.js prune-skills
```

### 审核 Skill

进入：

```text
Skills -> 待审核候选
```

可以执行：

- 批准写入 Hub
- 不通过并删除
- 查看证据和应用场景
- 禁用或删除已发布 Hub skill

### 导出会话

进入：

```text
会话 -> 打开某个会话 -> 导出
```

支持：

```text
Markdown
JSON
```

CLI：

```powershell
node dist/cli.js export --session-id <id> --format markdown
node dist/cli.js export --session-id <id> --format json
```

导出默认使用脱敏内容，不导出 raw sensitive payload。

### 恢复上下文

如果某个 Claude/Codex 原生会话被删除，但 Hub 已经同步过，你可以：

1. 在 Hub 会话页找到对应会话。
2. 点击“导出”。
3. 点击“生成恢复上下文”。
4. 把生成的 context pack 粘贴到新的 Agent 会话中。

通过 MCP 也可以让 Agent 调用：

```text
memory_get_context_pack
hub_skill_context_pack
```

### 打包为 Windows 可执行入口

```powershell
npm run package:win
```

输出：

```text
release\AgentMemoryHub-win-x64
```

运行：

```text
release\AgentMemoryHub-win-x64\AgentMemoryHub.exe
```

发布目录包含内置 Node、生产依赖、前端页面和编译产物。由于 SQLite 和 LanceDB 有 native 依赖，本项目采用“自包含目录 + exe 启动器”，不强行做脆弱的单文件 exe。

### 常用命令

```powershell
npm install
npm run build
npm run dashboard
npm run check
npm run ingest
npm run package:win
node dist/cli.js prune-skills
```

### 常见问题

#### Claude 看不到 MCP 工具

确认配置文件中存在 `agent-archive` 和 `agent-orchestrator`：

```text
%LOCALAPPDATA%\Claude-3p\claude_desktop_config.json
```

然后完全退出并重启 Claude Desktop / Claude-3p。

#### Hub 页面打不开

先检查 dashboard 是否启动：

```powershell
npm run dashboard
```

再确认端口：

```text
127.0.0.1:43121
```

#### Skill 候选太多

运行：

```powershell
node dist/cli.js prune-skills
```

也可以在 Dashboard 的 Skills 页面手动“不通过并删除”。

#### 不想消耗 LLM token

保持默认即可。后台同步默认不使用 LLM。

只有设置：

```powershell
$env:AGENT_HUB_SYNC_USE_LLM="true"
```

后台同步才会用 LLM 做摘要和提炼。

### 开发检查

```powershell
npm run check
```

该命令会执行 TypeScript 构建、单元测试和 Dashboard UI 流程测试。

### 安全说明

- Dashboard 只绑定 `127.0.0.1`。
- API 路由需要本地 bearer token。
- API key 会遮蔽显示。
- 导出默认使用脱敏文本。
- `.env`、本地数据库、发布包、日志和运行时数据不会进入 git。

### License

MIT

---

## English

Agent Memory Hub is a local-first memory workbench for Codex, Claude, and OpenCode. It archives agent conversations, builds searchable long-term memory, and turns high-value reusable experience into isolated Hub skills.

The goal is not to replace agents. The goal is to let agents recover project history, memory, skills, and context packs through MCP before starting a task.

Docker and EverCore are not required. SQLite is used by default. LanceDB is optional for semantic retrieval.

[切换到简体中文](#简体中文)

### Who Is This For

- You use Codex, Claude, and OpenCode together.
- You want agents to remember long-running project context.
- You want multiple agents to share the same archive, memory, and skills.
- You want skills to be reviewed before publication.
- You need to recover context from deleted or missing native agent sessions.

### One-Minute Start

```powershell
git clone https://github.com/NanAnNuo/agent-memory-hub.git
cd agent-memory-hub
npm install
npm run build
npm run dashboard
```

Open the local URL printed by the dashboard process.

Default data directory:

```text
%USERPROFILE%\.memory-hub
```

### Recommended Workflow

1. Start the Dashboard.
2. Click sync to import Codex/Claude/OpenCode sessions.
3. Browse historical conversations by project.
4. Configure a DeepSeek or OpenAI-compatible LLM in Settings.
5. Search historical memory.
6. Review skill candidates.
7. Connect Hub MCP to Claude or Codex so agents can query Hub before working.

### Start Dashboard

```powershell
npm run dashboard
```

If the project has not been built:

```powershell
npm run build
npm run dashboard
```

Default address:

```text
http://127.0.0.1:43121
```

Dashboard API routes require a local token. Desktop launcher scripts create the token and open the browser automatically.

### Create Desktop Entry

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-desktop-shortcut.ps1
```

This creates:

```text
Agent Memory Hub.cmd
```

Double-click it to start Hub and open the browser.

### Connect Claude Desktop

Packaged users can double-click `Register-MCP.cmd` in the extracted release directory. Source users can run:

Build first:

```powershell
npm run build
```

Register MCP:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-integrations.ps1 -RegisterMcp -AllowExistingCredentialUse
```

The script updates:

```text
%LOCALAPPDATA%\Claude-3p\claude_desktop_config.json
```

It adds:

```text
agent-archive
agent-orchestrator
```

Fully quit and restart Claude Desktop / Claude-3p after changing the config.

In Claude, use:

```text
Use Agent Memory Hub MCP to recover this project's context before continuing.
```

If Claude does not call Hub automatically, be more explicit:

```text
Call agent-archive / memory_search first and search this project's historical sessions and Hub skills.
```

### Connect Codex

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-integrations.ps1 -RegisterMcp -AllowExistingCredentialUse
```

When the `codex` CLI is available, the script registers:

```text
agent-archive
agent-orchestrator
```

### Sync Sessions

In Dashboard:

```text
Overview -> Sync now
Conversations -> Sync conversations
```

CLI:

```powershell
npm run ingest
```

Default sources:

```text
%USERPROFILE%\.codex\sessions
%USERPROFILE%\.claude\projects
%USERPROFILE%\.local\share\opencode\opencode.db
```

Add extra sources:

```powershell
$env:AGENT_HUB_TRANSCRIPT_ROOTS="D:\path\to\sessions;D:\another\root"
$env:AGENT_HUB_OPENCODE_DATABASES="D:\path\to\opencode.db"
```

### Background Sync

Enable in Dashboard:

```text
Settings -> Memory & Sync -> Start sync service on login
```

Background sync archives sessions and generates candidates. It does not approve or publish skills automatically.

### Configure LLM

Open:

```text
Settings -> Model configuration
```

Fill:

```text
Base URL
API Key
```

Then click:

```text
Import models
```

Hub calls:

```text
GET /v1/models
```

If model import is unavailable, use the manual model field.

DeepSeek example:

```text
Base URL: https://api.deepseek.com
Model: deepseek-chat
```

API keys are masked and are not written into exports, logs, or skill files.

### Search Memory

In Dashboard:

```text
Memory -> enter query -> search
```

Without embeddings, Hub uses SQLite FTS keyword search. With embeddings configured, Hub writes vectors into LanceDB.

Typical MCP tools:

```text
memory_search
memory_build_from_session
memory_get_context_pack
hub_skill_search
hub_skill_list
hub_skill_get
hub_skill_context_pack
```

### Capture Skills

Hub does not write skills into Codex, Claude, or OpenCode native skill directories.

Approved skills are stored only under:

```text
%USERPROFILE%\.memory-hub\skills\global\<slug>\SKILL.md
%USERPROFILE%\.memory-hub\skills\projects\<project-hash>\<slug>\SKILL.md
```

Skill candidates can come from:

1. Automatic Hub memory building.
2. Agent-created MCP candidates.
3. Manual Dashboard creation.

Candidates should have a clear function, usage scenario, reusable steps, and evidence.

Prune low-value candidates:

```powershell
node dist/cli.js prune-skills
```

### Review Skills

Open:

```text
Skills -> Pending candidates
```

Available actions:

- Approve into Hub
- Reject and delete
- Review evidence and usage scenario
- Disable or delete published Hub skills

### Export Conversations

Open:

```text
Conversations -> open a session -> Export
```

Supported formats:

```text
Markdown
JSON
```

CLI:

```powershell
node dist/cli.js export --session-id <id> --format markdown
node dist/cli.js export --session-id <id> --format json
```

Exports use redacted content by default.

### Restore Context

If a native Claude/Codex session was deleted but Hub already synced it:

1. Find the session in Hub.
2. Open Export.
3. Generate a restore context pack.
4. Paste the context pack into a new agent session.

MCP tools can also generate context packs:

```text
memory_get_context_pack
hub_skill_context_pack
```

### Build Windows Package

```powershell
npm run package:win
```

Output:

```text
release\AgentMemoryHub-win-x64
```

Run:

```text
release\AgentMemoryHub-win-x64\AgentMemoryHub.exe
```

The release folder includes bundled Node, production dependencies, frontend files, and compiled output. Because SQLite and LanceDB use native dependencies, this project ships a self-contained folder plus exe launcher instead of a fragile single-file executable.

### Useful Commands

```powershell
npm install
npm run build
npm run dashboard
npm run check
npm run ingest
npm run package:win
node dist/cli.js prune-skills
```

### FAQ

#### Claude Cannot See MCP Tools

Check:

```text
%LOCALAPPDATA%\Claude-3p\claude_desktop_config.json
```

It should contain `agent-archive` and `agent-orchestrator`. Then fully quit and restart Claude Desktop / Claude-3p.

#### Hub Page Does Not Open

Start manually:

```powershell
npm run dashboard
```

Then check:

```text
127.0.0.1:43121
```

#### Too Many Skill Candidates

Run:

```powershell
node dist/cli.js prune-skills
```

Or reject candidates manually in the Skills page.

#### Avoid LLM Token Usage

Keep the default settings. Background sync does not use LLM by default.

It uses LLM only when:

```powershell
$env:AGENT_HUB_SYNC_USE_LLM="true"
```

### Development Check

```powershell
npm run check
```

This runs TypeScript build, unit tests, and the Dashboard UI flow test.

### Security Notes

- Dashboard binds only to `127.0.0.1`.
- API routes require a local bearer token.
- API keys are masked in responses.
- Exports use redacted text by default.
- `.env`, local databases, release bundles, logs, and runtime data are ignored by git.

### License

MIT
