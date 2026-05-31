const $ = (id) => document.getElementById(id);
const escapeHtml = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));
const time = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "--";

const hashToken = new URLSearchParams(location.hash.replace(/^#/, "")).get("token");
if (hashToken) {
  sessionStorage.setItem("agentMemoryHubToken", hashToken);
  history.replaceState(null, "", location.pathname);
}
const dashboardToken = sessionStorage.getItem("agentMemoryHubToken");
let latestSessions = [];
let selectedSessionId = "";
let selectedSession = null;
let currentSessionCursor = 0;
let currentSessionHasMore = false;

async function api(path, options = {}) {
  if (!dashboardToken) throw new Error("请通过桌面入口或启动脚本打开 Agent Memory Hub");
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}), Authorization: `Bearer ${dashboardToken}` }
  });
  if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
  return response.json();
}

function badge(value) {
  return `<span class="badge ${escapeHtml(value)}">${escapeHtml(value)}</span>`;
}

function item(title, meta, body, actions = "") {
  return `<div class="item"><div class="meta">${meta}</div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(body)}</p>${actions}</div>`;
}

async function refresh() {
  try {
    const [status, sessions, tasks, candidates, skills, settings] = await Promise.all([
      api("/api/status"),
      loadSessions(),
      api("/api/tasks"),
      api("/api/candidates?status=pending"),
      api("/api/skills?includeDisabled=true"),
      api("/api/settings")
    ]);
    $("pulse").classList.toggle("off", false);
    $("syncState").textContent = "Hub / Local Memory 在线";
    $("syncTime").textContent = `最近同步 ${time(status.sync.lastSyncAt)}`;
    $("stats").innerHTML = [
      ["总会话", status.totalSessions],
      ["Codex", status.counts.codex ?? 0],
      ["Claude", status.counts.claude ?? 0],
      ["OpenCode", status.counts.opencode ?? 0],
      ["Hub Skills", status.hubSkills]
    ].map(([label, value]) => `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`).join("");
    $("localMemoryStatus").innerHTML = `
      <dl>
        <dt>SQLite</dt><dd>archive.db</dd>
        <dt>LanceDB</dt><dd>${escapeHtml(status.localMemory.lanceDbDir)}</dd>
        <dt>Skills</dt><dd>${escapeHtml(status.localMemory.skillsDir)}</dd>
        <dt>Mode</dt><dd>${status.localMemory.degraded ? "FTS fallback" : "Semantic ready"}</dd>
      </dl>`;
    renderSessions(sessions);
    $("taskCount").textContent = `${tasks.length} 条`;
    $("tasks").innerHTML = tasks.map((task) => item(task.title, `${badge(task.agent)}${escapeHtml(task.status)} / ${escapeHtml(time(task.updatedAt))}`, task.modelProfile)).join("") || `<div class="empty">暂无任务</div>`;
    renderCandidates(candidates);
    renderSkills(skills);
    renderSettings(settings);
  } catch (error) {
    $("pulse").classList.add("off");
    $("syncState").textContent = "连接异常";
    $("syncTime").textContent = error.message;
  }
}

async function loadSessions() {
  const client = $("clientFilter")?.value || "";
  const project = $("projectFilter")?.value || "";
  latestSessions = await api(`/api/sessions?client=${encodeURIComponent(client)}&project=${encodeURIComponent(project)}`);
  return latestSessions;
}

function renderSessions(sessions) {
  $("sessionCount").textContent = `${sessions.length} 条`;
  $("sessions").innerHTML = sessions.length ? renderProjectTree(sessions) : `<div class="empty">暂无会话</div>`;
  document.querySelectorAll("[data-session]").forEach((button) => button.addEventListener("click", () => showSession(button.dataset.session)));
  document.querySelectorAll("[data-delete-session]").forEach((button) => button.addEventListener("click", async (event) => {
    event.stopPropagation();
    await deleteSession(button.dataset.deleteSession);
  }));
}

function renderProjectTree(sessions) {
  const projects = groupByProject(sessions);
  const forceOpen = Boolean($("projectFilter").value.trim() || $("search").value.trim());
  return projects.map((project, index) => `
    <details class="project-node" ${forceOpen || index < 6 ? "open" : ""}>
      <summary>
        <span class="tree-check"></span>
        <span class="tree-caret">›</span>
        <span class="folder-icon"></span>
        <span class="tree-title"><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(project.path)}</small></span>
        <span class="count-pill">${project.sessions.length}</span>
      </summary>
      <div class="thread-list">${project.threads.map(renderThread).join("")}</div>
    </details>
  `).join("");
}

function renderThread(thread) {
  const session = thread.sessions[0];
  if (thread.sessions.length === 1) return renderSessionLeaf(session, "main");
  return `
    <details class="thread-node" open>
      <summary>
        <span class="tree-caret">›</span>
        <span class="thread-icon">#</span>
        <span class="tree-title"><strong>${escapeHtml(session.title || thread.name)}</strong><small>${relativeTime(newestTimestamp(thread.sessions))} · ${thread.sessions.length - 1} 个子线程 · ${formatBytes(sumBytes(thread.sessions))}</small></span>
      </summary>
      <div class="child-list">${thread.sessions.map((child) => renderSessionLeaf(child, "child")).join("")}</div>
    </details>`;
}

function renderSessionLeaf(session, kind) {
  const active = selectedSessionId === session.sessionId ? " active" : "";
  return `
    <button class="session-row ${kind}${active}" data-session="${escapeHtml(session.sessionId)}">
      <span class="session-dot"></span>
      <span class="session-copy">
        <strong>${escapeHtml(session.title || session.sourceSessionId || session.sessionId)}</strong>
        <small>${relativeTime(session.lastTimestamp)} · 0 个子线程 · ${formatBytes(session.textBytes || 0)}</small>
      </span>
      <span class="session-meta">${badge(session.client)}</span>
      <span class="session-actions">
        <span class="session-time">${escapeHtml(time(session.lastTimestamp))}</span>
        <span class="delete-session" data-delete-session="${escapeHtml(session.sessionId)}" title="删除对话">删除</span>
      </span>
    </button>`;
}

function groupByProject(sessions) {
  const map = new Map();
  for (const session of sessions) {
    const path = session.project || "no project";
    const key = path.toLowerCase();
    if (!map.has(key)) map.set(key, { name: projectName(path), path, sessions: [], threadMap: new Map(), threads: [] });
    const project = map.get(key);
    project.sessions.push(session);
    const threadKey = session.sourceSessionId || session.sessionId;
    if (!project.threadMap.has(threadKey)) project.threadMap.set(threadKey, { name: threadKey, sessions: [] });
    project.threadMap.get(threadKey).sessions.push(session);
  }
  return [...map.values()].map((project) => ({
    ...project,
    threads: [...project.threadMap.values()].sort((a, b) => newestTimestamp(b.sessions).localeCompare(newestTimestamp(a.sessions)))
  })).sort((a, b) => b.sessions.length - a.sessions.length || a.name.localeCompare(b.name));
}

function projectName(path) {
  if (path === "no project") return path;
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function newestTimestamp(sessions) {
  return sessions.map((session) => session.lastTimestamp || "").sort().at(-1) || "";
}

async function showSession(sessionId) {
  selectedSessionId = sessionId;
  selectedSession = latestSessions.find((session) => session.sessionId === sessionId) || null;
  currentSessionCursor = 0;
  currentSessionHasMore = false;
  const data = await api(`/api/session?id=${encodeURIComponent(sessionId)}&offset=0&limit=180`);
  currentSessionCursor = data.nextOffset;
  currentSessionHasMore = data.hasMore;
  $("exportSessionId").value = sessionId;
  $("resultCount").textContent = `${data.manifest.eventCount} 条事件`;
  $("details").className = "callchain tall";
  $("details").innerHTML = renderSessionHeader(data.manifest) + data.messages.map(renderEvent).join("") + renderLoadMore();
  renderSessions(latestSessions);
}

async function loadMoreSessionEvents() {
  if (!selectedSessionId || !currentSessionHasMore) return;
  const data = await api(`/api/session?id=${encodeURIComponent(selectedSessionId)}&offset=${currentSessionCursor}&limit=180`);
  currentSessionCursor = data.nextOffset;
  currentSessionHasMore = data.hasMore;
  document.querySelector(".load-more-row")?.remove();
  $("details").insertAdjacentHTML("beforeend", data.messages.map(renderEvent).join("") + renderLoadMore());
}

async function deleteSession(sessionId) {
  const session = latestSessions.find((item) => item.sessionId === sessionId);
  const title = session?.title || session?.sourceSessionId || sessionId;
  if (!confirm(`删除对话：${title}\n此操作会从 Hub 归档中移除，并阻止后续自动重新导入该会话。`)) return;
  await api(`/api/session?id=${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  if (selectedSessionId === sessionId) {
    selectedSessionId = "";
    selectedSession = null;
    $("details").className = "feed tall empty";
    $("details").textContent = "选择会话或搜索关键词";
    $("resultCount").textContent = "待查询";
  }
  renderSessions(await loadSessions());
}

function renderSessionHeader(manifest) {
  return `
    <section class="session-open-header">
      <div>
        <strong>${escapeHtml(selectedSession?.title || manifest.sourceSessionId || manifest.sessionId)}</strong>
        <p>编号：${escapeHtml(manifest.sessionId)}${manifest.sourceSessionId ? ` / 源编号：${escapeHtml(manifest.sourceSessionId)}` : ""}</p>
      </div>
      <small>${badge(manifest.client)}${escapeHtml(time(manifest.lastTimestamp))} · ${formatBytes(selectedSession?.textBytes || 0)}</small>
    </section>`;
}

function renderLoadMore() {
  return currentSessionHasMore ? `<div class="load-more-row"><button id="loadMoreEvents" type="button">加载更多调用链</button></div>` : "";
}

function renderEvent(event) {
  const kind = eventKind(event);
  const title = kind === "assistant" ? "Agent" : kind === "user" ? "User" : event.role || event.eventType || "event";
  return `
    <article class="chain-event ${kind}">
      <div class="chain-rail"><span></span></div>
      <div class="chain-card">
        <header><strong>${escapeHtml(title)}</strong><small>${escapeHtml(time(event.timestamp))} / ${escapeHtml(event.client)}#${event.lineNumber}</small></header>
        <pre>${escapeHtml(event.searchableText || "(无文本)")}</pre>
      </div>
    </article>`;
}

function eventKind(event) {
  const role = String(event.role || "").toLowerCase();
  const type = String(event.eventType || "").toLowerCase();
  const text = String(event.searchableText || "").trim().toLowerCase();
  if (role === "user") return "user";
  if (role === "assistant") return looksLikeToolText(text) ? "tool" : "assistant";
  if (role === "tool" || type.includes("tool") || looksLikeToolText(text)) return "tool";
  if (role === "system" || role === "developer" || type === "system" || type === "developer") return "control";
  return "event";
}

function looksLikeToolText(text) {
  return text.startsWith("[call") || text.startsWith("[tool") || text.startsWith("tool_call") || text.startsWith("function_call") || text.startsWith("<tool") || text.startsWith("{\"cmd\"") || text.startsWith("{\"tool\"");
}

function renderCandidates(candidates) {
  $("candidateCount").textContent = `${candidates.length} 条`;
  $("candidates").innerHTML = candidates.map((candidate) => item(
    candidate.title,
    `${badge(candidate.scope)}${escapeHtml(candidate.type)} / ${escapeHtml(candidate.promotionTarget)}`,
    `${candidate.lesson}\n\n${candidate.reuseRule}`,
    `<button class="mini promote" data-candidate="${escapeHtml(candidate.candidateId)}">批准写入 Hub</button>`
  )).join("") || `<div class="empty">暂无候选</div>`;
  document.querySelectorAll("[data-candidate]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api("/api/candidates/promote", { method: "POST", body: JSON.stringify({ candidateId: button.dataset.candidate, approved: true }) });
      await refresh();
    });
  });
}

function renderSkills(skills) {
  $("skillCount").textContent = `${skills.length} 条`;
  $("hubSkills").innerHTML = skills.map((skill) => item(
    skill.title,
    `${badge(skill.scope)}${escapeHtml(skill.status)} / ${escapeHtml(skill.projectRoot || "global")}`,
    `${skill.reuseRule}\n${skill.path}`,
    `<button class="mini" data-disable-skill="${escapeHtml(skill.skillId)}">禁用</button><button class="mini danger" data-delete-skill="${escapeHtml(skill.skillId)}">删除</button>`
  )).join("") || `<div class="empty">暂无 Hub skill</div>`;
  document.querySelectorAll("[data-disable-skill]").forEach((button) => button.addEventListener("click", async () => {
    await api(`/api/skills/${encodeURIComponent(button.dataset.disableSkill)}/disable`, { method: "POST" });
    await refresh();
  }));
  document.querySelectorAll("[data-delete-skill]").forEach((button) => button.addEventListener("click", async () => {
    await api(`/api/skills/${encodeURIComponent(button.dataset.deleteSkill)}`, { method: "DELETE" });
    await refresh();
  }));
}

function renderSettings(settings) {
  $("llmBaseUrl").value = settings.llmBaseUrl || "";
  $("llmModel").innerHTML = settings.llmModel ? `<option value="${escapeHtml(settings.llmModel)}">${escapeHtml(settings.llmModel)}</option>` : `<option value="">先导入模型</option>`;
  $("manualModel").value = settings.manualModelEntry ? settings.llmModel || "" : "";
  $("embeddingBaseUrl").value = settings.embeddingBaseUrl || "";
  $("embeddingModel").value = settings.embeddingModel || "";
  $("profileMemoryEnabled").checked = Boolean(settings.profileMemoryEnabled);
  $("backgroundSyncEnabled").checked = Boolean(settings.backgroundSyncEnabled);
  $("settingsStatus").textContent = JSON.stringify({ ...settings, llmApiKey: settings.llmApiKey ? "[masked]" : "", embeddingApiKey: settings.embeddingApiKey ? "[masked]" : "" }, null, 2);
}

function sumBytes(sessions) {
  return sessions.reduce((sum, session) => sum + (session.textBytes || 0), 0);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 1024 * 100 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function relativeTime(value) {
  if (!value) return "--";
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return time(value);
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab,.view").forEach((node) => node.classList.remove("active"));
    tab.classList.add("active");
    $(tab.dataset.view).classList.add("active");
  });
});

$("sessionFilters").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = $("search").value.trim();
  if (!query) {
    renderSessions(await loadSessions());
    return;
  }
  const results = await api(`/api/search?q=${encodeURIComponent(query)}`);
  $("resultCount").textContent = `${results.length} 条命中`;
  $("details").className = "callchain tall";
  $("details").innerHTML = results.map((result) => `
    <article class="chain-event ${escapeHtml(eventKind(result))}">
      <div class="chain-rail"><span></span></div>
      <div class="chain-card">
        <header><strong>${escapeHtml(result.role || "match")}</strong><small>${badge(result.client)}${escapeHtml(time(result.timestamp))} / #${result.lineNumber}</small></header>
        <pre>${escapeHtml(result.text || "(无文本)")}</pre>
      </div>
    </article>`).join("") || `<div class="empty">没有匹配内容</div>`;
});

document.addEventListener("click", async (event) => {
  if (event.target?.id === "loadMoreEvents") await loadMoreSessionEvents();
});

$("refresh").addEventListener("click", async () => {
  await api("/api/sync/run", { method: "POST" });
  await refresh();
});
$("runSync").addEventListener("click", async () => {
  await api("/api/sync/run", { method: "POST" });
  await refresh();
});

$("memoryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await api(`/api/memory/search?q=${encodeURIComponent($("memoryQuery").value)}&project=${encodeURIComponent($("memoryProject").value)}`);
  $("memoryCases").classList.remove("empty");
  $("memorySkills").classList.remove("empty");
  $("memoryCases").innerHTML = result.cases.map((entry) => item(entry.title, `${badge(entry.scope)}${entry.sourceAnchor || ""}`, entry.summary)).join("") || `<div class="empty">无 case</div>`;
  $("memorySkills").innerHTML = [...result.skills, ...result.profiles].map((entry) => item(entry.title, `${badge(entry.type)}${entry.sourceAnchor || ""}`, entry.summary)).join("") || `<div class="empty">无 skill/profile</div>`;
});

$("candidateForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await createCandidate();
});
$("createCandidate").addEventListener("click", createCandidate);

async function createCandidate() {
  await api("/api/candidates", {
    method: "POST",
    body: JSON.stringify({
      title: $("candTitle").value,
      scope: $("candScope").value,
      projectRoot: $("candProject").value,
      reuseRule: $("candRule").value,
      lesson: $("candLesson").value,
      evidence: $("candEvidence").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    })
  });
  HTMLFormElement.prototype.reset.call($("candidateForm"));
  renderCandidates(await api("/api/candidates?status=pending"));
}

$("exportForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await api("/api/export", { method: "POST", body: JSON.stringify({ sessionId: $("exportSessionId").value, format: $("exportFormat").value }) });
  $("exportPreview").textContent = result.content.slice(0, 6000);
  const blob = new Blob([result.content], { type: result.contentType });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = result.filename;
  link.click();
  URL.revokeObjectURL(link.href);
});

$("contextPack").addEventListener("click", async () => {
  const result = await api("/api/context-pack", { method: "POST", body: JSON.stringify({ sessionId: $("exportSessionId").value }) });
  $("exportPreview").textContent = result.content;
});

$("buildMemory").addEventListener("click", async () => {
  const result = await api("/api/memory/build", { method: "POST", body: JSON.stringify({ sessionId: $("exportSessionId").value }) });
  $("exportPreview").textContent = JSON.stringify(result, null, 2);
});

$("importModels").addEventListener("click", async () => {
  const result = await api("/api/settings/import-models", { method: "POST", body: JSON.stringify({ baseUrl: $("llmBaseUrl").value, apiKey: $("llmApiKey").value }) });
  $("llmModel").innerHTML = result.models.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.id)}</option>`).join("") || `<option value="">未返回模型</option>`;
  $("settingsStatus").textContent = JSON.stringify(result, null, 2);
});

$("settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const manual = $("manualModel").value.trim();
  const saved = await api("/api/settings", {
    method: "POST",
    body: JSON.stringify({
      llmProvider: "deepseek",
      llmBaseUrl: $("llmBaseUrl").value,
      llmApiKey: $("llmApiKey").value,
      llmModel: manual || $("llmModel").value,
      embeddingBaseUrl: $("embeddingBaseUrl").value,
      embeddingModel: $("embeddingModel").value,
      profileMemoryEnabled: $("profileMemoryEnabled").checked,
      backgroundSyncEnabled: $("backgroundSyncEnabled").checked,
      manualModelEntry: Boolean(manual)
    })
  });
  renderSettings(saved);
});

$("testLlm").addEventListener("click", async () => {
  const result = await api("/api/settings/test-llm", { method: "POST", body: JSON.stringify({ llmBaseUrl: $("llmBaseUrl").value, llmApiKey: $("llmApiKey").value, llmModel: $("manualModel").value || $("llmModel").value }) });
  $("settingsStatus").textContent = JSON.stringify(result, null, 2);
});

refresh();
setInterval(refresh, 10000);
