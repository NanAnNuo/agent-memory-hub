#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { URL } from "node:url";
import { ArchiveStore } from "./archive/store.js";
import { applyPendingRestore, createBackup, stageRestore } from "./archive/backup.js";
import { exportSession } from "./archive/export.js";
import { isReadableConversationEvent } from "./archive/readable.js";
import { ensureHubDirectories, getHubPaths, getPackageRoot } from "./shared/config.js";
import { OrchestratorStore } from "./orchestrator/store.js";
import { promoteSkillCandidate } from "./skills/promotion.js";
import { LiveSyncService } from "./sync/service.js";
import { buildContextPack, buildMemoryFromSession, searchLocalMemory } from "./memory/local.js";
import { importModels, publicSettings, testLlm } from "./memory/llm.js";

const paths = getHubPaths();
ensureHubDirectories(paths);
applyPendingRestore(paths);
const archiveStore = new ArchiveStore(paths);
const taskStore = new OrchestratorStore(paths);
const syncService = new LiveSyncService(archiveStore);

const host = "127.0.0.1";
const port = Number(process.env.AGENT_HUB_DASHBOARD_PORT ?? "43121");
const staticRoot = join(getPackageRoot(), "web");
const tokenPath = join(paths.dataDir, "dashboard.token");
const dashboardToken = loadOrCreateToken();

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  try {
    if (!allowedHost(request.headers.host)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    if (url.pathname.startsWith("/api/") && request.headers.authorization !== `Bearer ${dashboardToken}`) {
      response.writeHead(401).end("Unauthorized");
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      const manifests = archiveStore.listManifests();
      return json(response, {
        sync: syncService.status,
        localMemory: {
          enabled: true,
          degraded: !archiveStore.getSettings().embeddingModel,
          lanceDbDir: paths.lanceDbDir,
          skillsDir: paths.skillsDir
        },
        memorySync: archiveStore.listMemorySync().slice(0, 50),
        skillCandidates: archiveStore.listSkillCandidates("pending").length,
        hubSkills: archiveStore.listHubSkills(undefined, true).length,
        counts: manifests.reduce<Record<string, number>>((counts, session) => {
          counts[session.client] = (counts[session.client] ?? 0) + 1;
          return counts;
        }, {}),
        totalSessions: manifests.length
      });
    }
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      const client = url.searchParams.get("client") ?? undefined;
      const project = (url.searchParams.get("project") ?? "").toLowerCase();
      const sessions = archiveStore.listSessionItems(client).filter((session) => !project || (session.project ?? "").toLowerCase().includes(project));
      return json(response, sessions.slice(0, 200));
    }
    if (request.method === "GET" && url.pathname === "/api/session") {
      const sessionId = url.searchParams.get("id");
      if (!sessionId) {
        response.writeHead(400).end("Missing id");
        return;
      }
      const manifest = archiveStore.getManifest(sessionId);
      if (!manifest) {
        response.writeHead(404).end("Not Found");
        return;
      }
      const offset = numberParam(url, "offset", 0);
      const limit = Math.min(numberParam(url, "limit", 180), 500);
      const messages = archiveStore.getMessages(sessionId, offset, limit);
      const nextOffset = messages.length ? messages[messages.length - 1].lineNumber + 1 : offset;
      return json(response, { manifest, messages, nextOffset, hasMore: nextOffset < manifest.eventCount });
    }
    if (request.method === "DELETE" && url.pathname === "/api/session") {
      if (request.headers.origin && request.headers.origin !== `http://${host}:${port}`) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const sessionId = url.searchParams.get("id");
      if (!sessionId) {
        response.writeHead(400).end("Missing id");
        return;
      }
      return json(response, archiveStore.deleteSession(sessionId));
    }
    if (request.method === "GET" && url.pathname === "/api/search") {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (!query) {
        return json(response, []);
      }
      return json(response, archiveStore.searchMessages(query, undefined, 60, 0).filter(isReadableConversationEvent).slice(0, 30).map((event) => ({
        client: event.client,
        sessionId: event.sessionId,
        lineNumber: event.lineNumber,
        timestamp: event.timestamp,
        role: event.role,
        text: event.searchableText
      })));
    }
    if (request.method === "GET" && url.pathname === "/api/tasks") {
      return json(response, taskStore.list().slice(0, 50).map((task) => ({
        taskId: task.taskId,
        title: task.title,
        agent: task.agent,
        modelProfile: task.modelProfile,
        status: task.status,
        updatedAt: task.updatedAt
      })));
    }
    if (request.method === "GET" && url.pathname === "/api/candidates") {
      return json(response, archiveStore.listSkillCandidates(url.searchParams.get("status") ?? undefined));
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/candidates/")) {
      return json(response, archiveStore.deleteSkillCandidate(decodeURIComponent(url.pathname.slice("/api/candidates/".length))));
    }
    if (request.method === "GET" && url.pathname === "/api/settings") {
      return json(response, publicSettings(archiveStore.getSettings()));
    }
    if (request.method === "POST" && url.pathname === "/api/settings") {
      const body = await readJsonBody(request);
      const current = archiveStore.getSettings();
      const requestedBackgroundSync = booleanField(body, "backgroundSyncEnabled", current.backgroundSyncEnabled);
      if (requestedBackgroundSync !== current.backgroundSyncEnabled || requestedBackgroundSync) {
        await setBackgroundSync(requestedBackgroundSync);
      }
      const next = archiveStore.updateSettings({
        llmProvider: stringField(body, "llmProvider") || current.llmProvider,
        llmBaseUrl: stringField(body, "llmBaseUrl") || current.llmBaseUrl,
        llmModel: stringField(body, "llmModel") || current.llmModel,
        llmApiKey: stringField(body, "llmApiKey") || current.llmApiKey,
        embeddingBaseUrl: stringField(body, "embeddingBaseUrl") || current.embeddingBaseUrl,
        embeddingModel: stringField(body, "embeddingModel") || current.embeddingModel,
        embeddingApiKey: stringField(body, "embeddingApiKey") || current.embeddingApiKey,
        profileMemoryEnabled: booleanField(body, "profileMemoryEnabled", current.profileMemoryEnabled),
        backgroundSyncEnabled: requestedBackgroundSync,
        manualModelEntry: booleanField(body, "manualModelEntry", current.manualModelEntry),
        autoTaggingEnabled: booleanField(body, "autoTaggingEnabled", current.autoTaggingEnabled),
        duplicateCleanerEnabled: booleanField(body, "duplicateCleanerEnabled", current.duplicateCleanerEnabled),
        retentionReminderEnabled: booleanField(body, "retentionReminderEnabled", current.retentionReminderEnabled),
        contextPackEnabled: booleanField(body, "contextPackEnabled", current.contextPackEnabled),
        healthCheckEnabled: booleanField(body, "healthCheckEnabled", current.healthCheckEnabled)
      });
      return json(response, publicSettings(next));
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, healthStatus());
    }
    if (request.method === "POST" && url.pathname === "/api/settings/import-models") {
      const body = await readJsonBody(request);
      const settings = archiveStore.getSettings();
      return json(response, { models: await importModels(stringField(body, "baseUrl") || settings.llmBaseUrl, stringField(body, "apiKey") || settings.llmApiKey) });
    }
    if (request.method === "POST" && url.pathname === "/api/settings/test-llm") {
      const body = await readJsonBody(request);
      const settings = { ...archiveStore.getSettings(), ...body };
      return json(response, await testLlm(settings));
    }
    if (request.method === "POST" && (url.pathname === "/api/sync" || url.pathname === "/api/sync/run")) {
      if (request.headers.origin && request.headers.origin !== `http://${host}:${port}`) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      await syncService.syncAll("dashboard manual refresh");
      return json(response, syncService.status);
    }
    if ((request.method === "POST" || request.method === "GET") && url.pathname === "/api/memory/search") {
      const body = request.method === "POST" ? await readJsonBody(request) : {};
      const query = stringField(body, "query") || url.searchParams.get("q") || "";
      if (!query) {
        response.writeHead(400).end("Missing query");
        return;
      }
      const project = stringField(body, "projectRoot") || url.searchParams.get("project") || undefined;
      return json(response, searchLocalMemory(archiveStore, query, project, arrayField(body, "types"), numberField(body, "topK", 20)));
    }
    if (request.method === "POST" && url.pathname === "/api/memory/build") {
      const body = await readJsonBody(request);
      return json(response, await buildMemoryFromSession(archiveStore, requiredString(body, "sessionId")));
    }
    if (request.method === "POST" && url.pathname === "/api/context-pack") {
      const body = await readJsonBody(request);
      return json(response, buildContextPack(archiveStore, requiredString(body, "sessionId"), numberField(body, "maxMessages", 40)));
    }
    if (request.method === "POST" && url.pathname === "/api/backup/create") {
      const body = await readJsonBody(request);
      return json(response, await createBackup(archiveStore, paths, stringField(body, "outputPath") || undefined));
    }
    if (request.method === "POST" && url.pathname === "/api/backup/restore") {
      const body = await readJsonBody(request);
      return json(response, stageRestore(paths, requiredString(body, "backupPath")));
    }
    if (request.method === "POST" && url.pathname === "/api/candidates") {
      const body = await readJsonBody(request);
      return json(response, archiveStore.putSkillCandidate({
        candidateId: stringField(body, "candidateId") || `cand-${Date.now()}`,
        scope: enumField(body, "scope", ["global", "project"], "project"),
        type: enumField(body, "type", ["pitfall", "workflow", "preference", "tooling", "debug-pattern"], "workflow"),
        title: requiredString(body, "title"),
        lesson: requiredString(body, "lesson"),
        evidence: arrayField(body, "evidence"),
        reuseRule: requiredString(body, "reuseRule"),
        redactionStatus: enumField(body, "redactionStatus", ["redacted", "needs-human-review"], "redacted"),
        promotionTarget: enumField(body, "promotionTarget", ["memory", "skill", "project-rule", "discard"], "skill"),
        projectRoot: stringField(body, "projectRoot") || null
      }));
    }
    if (request.method === "POST" && url.pathname === "/api/candidates/promote") {
      const body = await readJsonBody(request);
      return json(response, promoteSkillCandidate(archiveStore, paths, requiredString(body, "candidateId"), Boolean(body.approved)));
    }
    if (request.method === "GET" && url.pathname === "/api/skills") {
      return json(response, archiveStore.listHubSkills(url.searchParams.get("project") ?? undefined, url.searchParams.get("includeDisabled") === "true"));
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/skills/")) {
      const skill = archiveStore.getHubSkill(decodeURIComponent(url.pathname.slice("/api/skills/".length)));
      if (!skill) {
        response.writeHead(404).end("Not Found");
        return;
      }
      return json(response, { ...skill, content: readFileSync(skill.path, "utf8") });
    }
    if (request.method === "POST" && url.pathname.endsWith("/disable") && url.pathname.startsWith("/api/skills/")) {
      const skillId = decodeURIComponent(url.pathname.slice("/api/skills/".length, -"/disable".length));
      return json(response, archiveStore.disableHubSkill(skillId));
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/skills/")) {
      const deleted = archiveStore.deleteHubSkill(decodeURIComponent(url.pathname.slice("/api/skills/".length)));
      if (deleted.path) {
        rmSync(deleted.path, { force: true });
      }
      return json(response, deleted);
    }
    if (request.method === "POST" && url.pathname === "/api/export") {
      const body = await readJsonBody(request);
      const result = exportSession(
        archiveStore,
        paths,
        requiredString(body, "sessionId"),
        enumField(body, "format", ["markdown", "json"], "markdown"),
        stringField(body, "outputPath") || undefined
      );
      return json(response, result);
    }
    if (request.method !== "GET") {
      response.writeHead(405).end("Method Not Allowed");
      return;
    }
    const staticPath = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    if (!["index.html", "app.js", "styles.css"].includes(staticPath)) {
      response.writeHead(404).end("Not Found");
      return;
    }
    const content = await readFile(join(staticRoot, staticPath));
    response.writeHead(200, { "Content-Type": contentType(staticPath), "Cache-Control": "no-store" });
    response.end(content);
  } catch (error) {
    json(response, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

server.listen(port, host, () => {
  process.stderr.write(`Agent Memory Hub dashboard available at http://${host}:${port}\n`);
  void syncService.start();
});

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    default: return "text/html; charset=utf-8";
  }
}

function allowedHost(value: string | undefined): boolean {
  return value === `${host}:${port}` || value === `localhost:${port}`;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function stringField(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === "string" ? body[key].trim() : "";
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = stringField(body, key);
  if (!value) {
    throw new Error(`Missing ${key}`);
  }
  return value;
}

function numberField(body: Record<string, unknown>, key: string, fallback: number): number {
  return typeof body[key] === "number" && Number.isFinite(body[key]) ? Number(body[key]) : fallback;
}

function booleanField(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof body[key] === "boolean" ? body[key] : fallback;
}

function numberParam(url: URL, key: string, fallback: number): number {
  const parsed = Number(url.searchParams.get(key));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function arrayField(body: Record<string, unknown>, key: string): string[] {
  return Array.isArray(body[key]) ? body[key].map((value) => String(value)) : [];
}

function enumField<T extends string>(body: Record<string, unknown>, key: string, allowed: T[], fallback: T): T {
  const value = body[key];
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function healthStatus(): Record<string, unknown> {
  const settings = archiveStore.getSettings();
  const taskName = "Agent Memory Hub Dashboard";
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    dataDir: paths.dataDir,
    archiveDatabase: { path: paths.archiveDatabase, exists: existsSync(paths.archiveDatabase) },
    skillsDir: { path: paths.skillsDir, exists: existsSync(paths.skillsDir), count: archiveStore.listHubSkills(undefined, true).length },
    mcp: {
      archiveEntry: join(getPackageRoot(), "dist", "archive-main.js"),
      orchestratorEntry: join(getPackageRoot(), "dist", "orchestrator-main.js")
    },
    llm: {
      configured: Boolean(settings.llmBaseUrl && settings.llmModel && settings.llmApiKey),
      baseUrl: settings.llmBaseUrl,
      model: settings.llmModel
    },
    backgroundSync: {
      enabled: settings.backgroundSyncEnabled,
      taskName,
      windowsTaskQuery: `Get-ScheduledTask -TaskName '${taskName}'`
    },
    memory: {
      pending: archiveStore.getPendingMemoryManifests(1000).length,
      last: archiveStore.listMemorySync().slice(0, 5)
    },
    backup: {
      defaultDir: join(paths.dataDir, "backups"),
      pendingRestoreMarker: join(paths.dataDir, "restore-pending.json"),
      restartRequired: existsSync(join(paths.dataDir, "restore-pending.json"))
    }
  };
}

async function setBackgroundSync(enabled: boolean): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }
  const script = join(getPackageRoot(), "scripts", "install-dashboard-service.ps1");
  if (enabled) {
    await execPowerShell(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-HubRoot", getPackageRoot()]);
    return;
  }
  await execPowerShell(["-NoProfile", "-Command", "Unregister-ScheduledTask -TaskName 'Agent Memory Hub Dashboard' -Confirm:$false -ErrorAction SilentlyContinue"]);
}

function execPowerShell(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message));
        return;
      }
      resolve();
    });
  });
}

function loadOrCreateToken(): string {
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, "utf8").trim();
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  return token;
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown(): void {
  syncService.close();
  server.close();
  archiveStore.close();
  taskStore.close();
}
