import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getHubPaths, ensureHubDirectories } from "../src/shared/config.js";
import { importJsonlFile } from "../src/archive/importers.js";
import { ArchiveStore } from "../src/archive/store.js";
import { EverCoreClient, syncPendingEverCoreSessions } from "../src/evercore/client.js";
import { exportSession } from "../src/archive/export.js";
import { promoteSkillCandidate } from "../src/skills/promotion.js";

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  while (servers.length) {
    servers.pop()?.close();
  }
});

function setupStore() {
  const root = mkdtempSync(join(tmpdir(), "agent-memory-hub-"));
  const sourceRoot = join(root, "source");
  mkdirSync(sourceRoot, { recursive: true });
  const paths = getHubPaths(join(root, "data"));
  ensureHubDirectories(paths);
  return { root, sourceRoot, paths, store: new ArchiveStore(paths) };
}

describe("EverCore sync, export, and skill promotion", () => {
  it("syncs pending sessions to EverCore once per file fingerprint", async () => {
    const { sourceRoot, store } = setupStore();
    const source = join(sourceRoot, "session.jsonl");
    writeFileSync(source, [
      JSON.stringify({ type: "system", sessionId: "s-1", timestamp: "2026-05-25T00:00:00Z", content: "internal startup rule" }),
      JSON.stringify({ type: "user", sessionId: "s-1", timestamp: "2026-05-25T00:00:00Z", message: { role: "user", content: "remember this workflow" } }),
      JSON.stringify({ type: "assistant", sessionId: "s-1", timestamp: "2026-05-25T00:00:00Z", message: { role: "assistant", content: "[call shell_command]" } }),
      JSON.stringify({ type: "assistant", sessionId: "s-1", timestamp: "2026-05-25T00:00:01Z", message: { role: "assistant", content: "done" } })
    ].join("\n"), "utf8");
    const imported = importJsonlFile("codex", source, sourceRoot);
    store.ingestSession(imported);

    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const url = await mockEverCore(async (request, response) => {
      calls.push({ path: request.url ?? "", body: await readBody(request) });
      json(response, { data: { agent_memory: { cases: [], skills: [] } } });
    });

    const client = new EverCoreClient({ enabled: true, url, root: sourceRoot, userId: "u-1" });
    expect(await syncPendingEverCoreSessions(store, client, 10)).toMatchObject({ attempted: 1, synced: 1, failed: 0, messages: 2 });
    expect(await syncPendingEverCoreSessions(store, client, 10)).toMatchObject({ attempted: 0, synced: 0, failed: 0, messages: 0 });
    expect(calls.map((call) => call.path)).toEqual(["/api/v1/memories/agent", "/api/v1/memories/agent/flush"]);
    expect(calls[0].body).toMatchObject({ user_id: "u-1", session_id: imported.sessionId });
    expect(calls[0].body.messages).toEqual([
      expect.objectContaining({ role: "user", content: "remember this workflow" }),
      expect.objectContaining({ role: "assistant", content: "done" })
    ]);
    store.close();
  });

  it("exports redacted Markdown and JSON without raw sensitive payloads", () => {
    const { sourceRoot, paths, store } = setupStore();
    const source = join(sourceRoot, "secret.jsonl");
    writeFileSync(source, JSON.stringify({
      type: "user",
      sessionId: "s-2",
      message: { role: "user", content: "token api_key=secretabcdefghijk" }
    }), "utf8");
    const imported = importJsonlFile("claude", source, sourceRoot);
    store.ingestSession(imported);

    const markdown = exportSession(store, paths, imported.sessionId, "markdown");
    const jsonExport = exportSession(store, paths, imported.sessionId, "json");
    expect(markdown.content).toContain("[REDACTED]");
    expect(jsonExport.content).toContain("[REDACTED]");
    expect(markdown.content).not.toContain("secretabcdefghijk");
    expect(jsonExport.content).not.toContain("secretabcdefghijk");
    store.close();
  });

  it("exports only readable user and assistant conversation messages", () => {
    const { sourceRoot, paths, store } = setupStore();
    const source = join(sourceRoot, "readable.jsonl");
    writeFileSync(source, [
      JSON.stringify({ type: "developer", sessionId: "s-3", content: "internal implementation rule" }),
      JSON.stringify({ type: "user", sessionId: "s-3", message: { role: "user", content: "please explain the fix" } }),
      JSON.stringify({ type: "assistant", sessionId: "s-3", message: { role: "assistant", content: "[tool call details]" } }),
      JSON.stringify({ type: "assistant", sessionId: "s-3", message: { role: "assistant", content: "the fix is ready" } })
    ].join("\n"), "utf8");
    const imported = importJsonlFile("codex", source, sourceRoot);
    store.ingestSession(imported);

    const markdown = exportSession(store, paths, imported.sessionId, "markdown");
    const jsonExport = exportSession(store, paths, imported.sessionId, "json");
    const parsed = JSON.parse(jsonExport.content) as { readableEvents: number; events: Array<{ role: string; text: string }> };

    expect(markdown.content).toContain("please explain the fix");
    expect(markdown.content).toContain("the fix is ready");
    expect(markdown.content).not.toContain("internal implementation rule");
    expect(markdown.content).not.toContain("[tool call details]");
    expect(parsed.readableEvents).toBe(2);
    expect(parsed.events.map((event) => event.role)).toEqual(["user", "assistant"]);
    store.close();
  });

  it("promotes global and project skills to separate directories", () => {
    const { root, store } = setupStore();
    const codexRoot = join(root, "codex-skills");
    const claudeRoot = join(root, "claude-skills");
    process.env.AGENT_HUB_CODEX_SKILLS_DIR = codexRoot;
    process.env.AGENT_HUB_CLAUDE_SKILLS_DIR = claudeRoot;
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot, { recursive: true });
    const globalId = "global-candidate";
    const projectId = "project-candidate";
    store.putSkillCandidate({
      candidateId: globalId,
      scope: "global",
      type: "workflow",
      title: `Hub global ${Date.now()}`,
      lesson: "Use the reusable workflow.",
      evidence: ["unit test"],
      reuseRule: "Use when the workflow repeats.",
      redactionStatus: "redacted",
      promotionTarget: "skill",
      projectRoot: null
    });
    store.putSkillCandidate({
      candidateId: projectId,
      scope: "project",
      type: "workflow",
      title: "Project only workflow",
      lesson: "Keep this project-local.",
      evidence: ["unit test"],
      reuseRule: "Use only in this project.",
      redactionStatus: "redacted",
      promotionTarget: "skill",
      projectRoot
    });

    const global = promoteSkillCandidate(store, globalId, true);
    const project = promoteSkillCandidate(store, projectId, true);
    expect(global.targetPath).toContain(codexRoot);
    expect(global.targetPath).toContain(claudeRoot);
    expect(project.targetPath).toContain(join(projectRoot, ".project-skills"));
    const globalSlug = `learned-${global.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56)}`;
    expect(existsSync(join(codexRoot, globalSlug, "SKILL.md"))).toBe(true);
    expect(existsSync(join(claudeRoot, globalSlug, "SKILL.md"))).toBe(true);
    expect(readFileSync(join(projectRoot, ".project-skills", "project-only-workflow", "SKILL.md"), "utf8")).toContain("Keep this project-local.");
    store.close();
  });
});

async function mockEverCore(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>): Promise<string> {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not bind mock server.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
