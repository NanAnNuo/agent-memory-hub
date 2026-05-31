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
    const [status, sessions, tasks, candidates] = await Promise.all([
      api("/api/status"),
      loadSessions(),
      api("/api/tasks"),
      api("/api/candidates?status=pending")
    ]);
    $("pulse").classList.toggle("off", !status.evercore.reachable);
    $("syncState").textContent = status.evercore.reachable ? "Hub / EverCore 在线" : "Hub 在线 / EverCore 离线";
    $("syncTime").textContent = `最近同步 ${time(status.sync.lastSyncAt)}`;
    $("stats").innerHTML = [
      ["总会话", status.totalSessions],
      ["Codex", status.counts.codex ?? 0],
      ["Claude", status.counts.claude ?? 0],
      ["OpenCode", status.counts.opencode ?? 0],
      ["候选 Skill", status.skillCandidates]
    ].map(([label, value]) => `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`).join("");
    $("evercoreStatus").innerHTML = `
      <dl>
        <dt>URL</dt><dd>${escapeHtml(status.evercore.url)}</dd>
        <dt>Root</dt><dd>${escapeHtml(status.evercore.root)}</dd>
        <dt>User</dt><dd>${escapeHtml(status.evercore.userId)}</dd>
        <dt>Reachable</dt><dd>${status.evercore.reachable ? "yes" : escapeHtml(status.evercore.error || "no")}</dd>
        <dt>Auto Sync</dt><dd>${status.sync.evercore.enabled ? "enabled" : "disabled"}</dd>
      </dl>`;
    renderSessions(sessions);
    $("taskCount").textContent = `${tasks.length} 条`;
    $("tasks").innerHTML = tasks.map((task) => item(task.title, `${badge(task.agent)}${escapeHtml(task.status)} / ${escapeHtml(time(task.updatedAt))}`, task.modelProfile)).join("") || `<div class="empty">暂无任务</div>`;
    renderCandidates(candidates);
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
  $("sessions").innerHTML = sessions.map((session) => `
    <button class="session-row" data-session="${escapeHtml(session.sessionId)}">
      <span>${badge(session.client)}${escapeHtml(time(session.lastTimestamp))}</span>
      <strong>${escapeHtml(session.sourceSessionId || session.sessionId)}</strong>
      <small>${escapeHtml(session.project || "no project")} / ${session.eventCount} events</small>
    </button>`).join("") || `<div class="empty">暂无会话</div>`;
  document.querySelectorAll("[data-session]").forEach((button) => {
    button.addEventListener("click", () => showSession(button.dataset.session));
  });
}

async function showSession(sessionId) {
  const data = await api(`/api/session?id=${encodeURIComponent(sessionId)}`);
  $("exportSessionId").value = sessionId;
  $("resultCount").textContent = `${data.messages.length} 条消息`;
  $("details").classList.remove("empty");
  $("details").innerHTML = data.messages.map((msg) => item(
    msg.role || msg.eventType,
    `${escapeHtml(time(msg.timestamp))} / ${escapeHtml(msg.client)}#${msg.lineNumber}`,
    msg.searchableText || "(无文本)"
  )).join("");
}

function renderCandidates(candidates) {
  $("candidateCount").textContent = `${candidates.length} 条`;
  $("candidates").innerHTML = candidates.map((candidate) => item(
    candidate.title,
    `${badge(candidate.scope)}${escapeHtml(candidate.type)} / ${escapeHtml(candidate.promotionTarget)}`,
    `${candidate.lesson}\n\n${candidate.reuseRule}`,
    `<button class="mini promote" data-candidate="${escapeHtml(candidate.candidateId)}">批准写入</button>`
  )).join("") || `<div class="empty">暂无候选</div>`;
  document.querySelectorAll("[data-candidate]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api("/api/candidates/promote", { method: "POST", body: JSON.stringify({ candidateId: button.dataset.candidate, approved: true }) });
      await refresh();
    });
  });
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
  $("details").classList.remove("empty");
  $("details").innerHTML = results.map((result) => item(result.role || "match", `${badge(result.client)}${escapeHtml(time(result.timestamp))} / #${result.lineNumber}`, result.text || "(无文本)")).join("") || `<div class="empty">没有匹配内容</div>`;
});

$("refresh").addEventListener("click", async () => {
  await api("/api/sync", { method: "POST" });
  await refresh();
});

$("syncEverCore").addEventListener("click", async () => {
  const result = await api("/api/evercore/sync", { method: "POST", body: JSON.stringify({ limit: 20 }) });
  $("evercoreStatus").innerHTML = `<pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>`;
});

$("memoryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await api("/api/memory/search", { method: "POST", body: JSON.stringify({ query: $("memoryQuery").value, method: $("memoryMethod").value, topK: 8 }) });
  $("memoryCases").classList.remove("empty");
  $("memorySkills").classList.remove("empty");
  $("memoryCases").innerHTML = result.cases.map((entry) => item(entry.task_intent || entry.id || "case", `score ${entry.score ?? "--"}`, entry.approach || JSON.stringify(entry, null, 2))).join("") || `<div class="empty">无 case</div>`;
  $("memorySkills").innerHTML = result.skills.map((entry) => item(entry.name || entry.id || "skill", `confidence ${entry.confidence ?? "--"} / maturity ${entry.maturity_score ?? "--"}`, entry.content || JSON.stringify(entry, null, 2))).join("") || `<div class="empty">无 skill</div>`;
});

$("candidateForm").addEventListener("submit", async (event) => {
  event.preventDefault();
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
  event.target.reset();
  await refresh();
});

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

refresh();
setInterval(refresh, 6000);
