#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { URL } from "node:url";
import { ArchiveStore } from "./archive/store.js";
import { exportSession } from "./archive/export.js";
import { EverCoreClient, syncPendingEverCoreSessions } from "./evercore/client.js";
import { ensureHubDirectories, getEverCoreConfig, getHubPaths, getPackageRoot } from "./shared/config.js";
import { OrchestratorStore } from "./orchestrator/store.js";
import { promoteSkillCandidate } from "./skills/promotion.js";
import { LiveSyncService } from "./sync/service.js";

const paths = getHubPaths();
ensureHubDirectories(paths);
const archiveStore = new ArchiveStore(paths);
const taskStore = new OrchestratorStore(paths);
const syncService = new LiveSyncService(archiveStore);
const everCoreClient = new EverCoreClient(getEverCoreConfig());
await syncService.start();

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
      const evercore = await everCoreClient.status();
      return json(response, {
        sync: syncService.status,
        evercore,
        evercoreSync: archiveStore.listEverCoreSync().slice(0, 50),
        skillCandidates: archiveStore.listSkillCandidates("pending").length,
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
      const sessions = archiveStore.listManifests(client).filter((session) => !project || (session.project ?? "").toLowerCase().includes(project));
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
      return json(response, { manifest, messages: archiveStore.getMessages(sessionId, 0, Math.max(manifest.eventCount, 1)) });
    }
    if (request.method === "GET" && url.pathname === "/api/search") {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (!query) {
        return json(response, []);
      }
      return json(response, archiveStore.searchMessages(query, undefined, 30, 0).map((event) => ({
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
    if (request.method === "POST" && url.pathname === "/api/sync") {
      if (request.headers.origin && request.headers.origin !== `http://${host}:${port}`) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      await syncService.syncAll("dashboard manual refresh");
      return json(response, syncService.status);
    }
    if (request.method === "POST" && url.pathname === "/api/evercore/sync") {
      const body = await readJsonBody(request);
      return json(response, await syncPendingEverCoreSessions(archiveStore, everCoreClient, numberField(body, "limit", 20)));
    }
    if (request.method === "POST" && url.pathname === "/api/memory/search") {
      const body = await readJsonBody(request);
      const query = stringField(body, "query");
      if (!query) {
        response.writeHead(400).end("Missing query");
        return;
      }
      return json(response, await everCoreClient.searchAgentMemory(query, numberField(body, "topK", 8), stringField(body, "method") || "hybrid"));
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
      return json(response, promoteSkillCandidate(archiveStore, requiredString(body, "candidateId"), Boolean(body.approved)));
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
  process.stderr.write(`Agent Collaboration Hub dashboard available at http://${host}:${port}\n`);
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

function arrayField(body: Record<string, unknown>, key: string): string[] {
  return Array.isArray(body[key]) ? body[key].map((value) => String(value)) : [];
}

function enumField<T extends string>(body: Record<string, unknown>, key: string, allowed: T[], fallback: T): T {
  const value = body[key];
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
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
