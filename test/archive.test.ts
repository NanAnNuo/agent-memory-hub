import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { getHubPaths, ensureHubDirectories } from "../src/shared/config.js";
import { importJsonlFile, importOpenCodeDatabase } from "../src/archive/importers.js";
import { ArchiveStore } from "../src/archive/store.js";
import { buildContextBundle } from "../src/archive/context.js";

function setupStore() {
  const root = mkdtempSync(join(tmpdir(), "agent-archive-"));
  const sourceRoot = join(root, "source");
  mkdirSync(sourceRoot, { recursive: true });
  const paths = getHubPaths(join(root, "data"));
  ensureHubDirectories(paths);
  return { root, sourceRoot, paths, store: new ArchiveStore(paths) };
}

describe("archive store and budgeted context", () => {
  it("retains source-form events without duplicating detected credentials and audits sensitive reads", () => {
    const { sourceRoot, paths, store } = setupStore();
    const source = join(sourceRoot, "session.jsonl");
    const raw = [
      JSON.stringify({ type: "user", sessionId: "s-1", timestamp: "2026-05-25T00:00:00Z", message: { role: "user", content: "hello api_key=secretabcdefghijk" } }),
      JSON.stringify({ type: "assistant", sessionId: "s-1", timestamp: "2026-05-25T00:00:01Z", message: { role: "assistant", content: "bounded answer" } })
    ].join("\n");
    writeFileSync(source, raw, "utf8");
    const imported = importJsonlFile("claude", source, sourceRoot);
    expect(store.ingestSession(imported).insertedEvents).toBe(2);
    expect(store.ingestSession(imported).insertedEvents).toBe(0);

    const redacted = store.getMessages(imported.sessionId, 0, 2);
    expect(redacted[0].searchableText).toContain("[REDACTED]");
    expect(redacted[0].searchableText).not.toContain("secretabcdefghijk");
    expect(() => store.getRawEvents(imported.sessionId, 0, 1, false)).toThrow();
    const original = store.getRawEvents(imported.sessionId, 0, 1, true);
    expect(original[0].rawJson).toContain("[REDACTED]");
    expect(original[0].rawJson).not.toContain("secretabcdefghijk");
    expect(original[0].rawSha256).toBe(imported.events[0].rawSha256);
    expect(readFileSync(paths.auditLog, "utf8")).toContain("archive_get_raw_events");
    store.close();
  });

  it("returns source-anchored exact excerpts under budget and continuation pointers", () => {
    const { sourceRoot, store } = setupStore();
    const source = join(sourceRoot, "long.jsonl");
    writeFileSync(source, [
      JSON.stringify({ type: "user", sessionId: "s-2", message: { role: "user", content: "pinned exact text" } }),
      JSON.stringify({ type: "assistant", sessionId: "s-2", message: { role: "assistant", content: `hello ${"long ".repeat(200)}` } }),
      JSON.stringify({ type: "assistant", sessionId: "s-2", message: { role: "assistant", content: "recent followup" } })
    ].join("\n"), "utf8");
    const imported = importJsonlFile("claude", source, sourceRoot);
    store.ingestSession(imported);
    const bundle = buildContextBundle(store, {
      query: "hello",
      sessionIds: [imported.sessionId],
      modelProfileName: "test",
      modelProfile: { agent: "claude", role: "test", contextWindowTokens: 100, historicalTextRatio: 0.6 },
      tokenBudget: 60,
      pinnedRanges: [{ sessionId: imported.sessionId, offset: 0, limit: 1 }]
    });
    expect(bundle.usedTokens).toBeLessThanOrEqual(60);
    expect(bundle.excerpts[0].text).toContain("pinned exact text");
    expect(bundle.truncated).toBe(true);
    expect(bundle.nextRanges.length).toBeGreaterThan(0);
    store.close();
  });

  it("persists structured continuation checkpoints", () => {
    const { store } = setupStore();
    const checkpoint = store.putCheckpoint({
      taskId: "task-1",
      sourceRanges: [{ sessionId: "session", offset: 2, limit: 4 }],
      files: ["src/main.ts"],
      commands: ["npm test"],
      tests: ["passes"],
      decisions: ["preserve raw transcripts"],
      pending: ["review"]
    });
    expect(store.getCheckpoint("task-1")).toEqual(checkpoint);
    store.close();
  });

  it("deletes archived sessions and tombstones them against re-import", () => {
    const { sourceRoot, store } = setupStore();
    const source = join(sourceRoot, "delete.jsonl");
    writeFileSync(source, JSON.stringify({ type: "user", sessionId: "delete-me", message: { role: "user", content: "remove this conversation" } }), "utf8");
    const imported = importJsonlFile("codex", source, sourceRoot);
    expect(store.ingestSession(imported).insertedEvents).toBe(1);
    expect(store.deleteSession(imported.sessionId)).toEqual({ deleted: true });
    expect(store.getManifest(imported.sessionId)).toBeNull();
    expect(store.getMessages(imported.sessionId, 0, 10)).toEqual([]);
    expect(store.ingestSession(imported).insertedEvents).toBe(0);
    expect(store.getManifest(imported.sessionId)).toBeNull();
    store.close();
  });

  it("imports OpenCode session messages without reading account token tables", () => {
    const { root } = setupStore();
    const databasePath = join(root, "opencode.db");
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE account (id TEXT, access_token TEXT);
    `);
    database.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)").run("ses_1", "D:\\repo", "test", 1, 2);
    database.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("msg_1", "ses_1", 1, JSON.stringify({ role: "user", content: "opencode hello" }));
    database.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run("part_1", "msg_1", "ses_1", 2, JSON.stringify({ type: "text", text: "opencode result" }));
    database.prepare("INSERT INTO account VALUES (?, ?)").run("account_1", "token-never-imported");
    database.close();

    const sessions = importOpenCodeDatabase(databasePath);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].events.map((event) => event.searchableText).join("\n")).toContain("opencode hello");
    expect(JSON.stringify(sessions)).not.toContain("token-never-imported");
  });
});
