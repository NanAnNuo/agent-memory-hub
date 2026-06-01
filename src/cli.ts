#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureHubDirectories, getHubPaths } from "./shared/config.js";
import { exportSession } from "./archive/export.js";
import { findJsonlFiles, importJsonlFile, importOpenCodeDatabase } from "./archive/importers.js";
import { ArchiveStore } from "./archive/store.js";
import { prunePendingSkillCandidates } from "./memory/local.js";
import type { ClientKind } from "./archive/types.js";

const command = process.argv[2];
if (!["ingest", "export", "prune-skills"].includes(command ?? "")) {
  process.stderr.write("Usage: agent-memory-hub ingest [--opencode-root PATH] [--opencode-db PATH]\n       agent-memory-hub export --session-id ID --format markdown|json [--output PATH]\n       agent-memory-hub prune-skills\n");
  process.exitCode = 1;
} else if (command === "ingest") {
  const paths = getHubPaths();
  ensureHubDirectories(paths);
  const store = new ArchiveStore(paths);
  const sources: Array<{ client: ClientKind; root: string }> = [
    { client: "codex", root: join(homedir(), ".codex", "sessions") },
    { client: "claude", root: join(homedir(), ".claude", "projects") }
  ];
  const optionIndex = process.argv.indexOf("--opencode-root");
  if (optionIndex >= 0 && process.argv[optionIndex + 1]) {
    sources.push({ client: "opencode", root: process.argv[optionIndex + 1] });
  }
  const summary: Array<{ client: string; files: number; insertedEvents: number }> = [];
  for (const source of sources) {
    if (!existsSync(source.root)) {
      continue;
    }
    const files = findJsonlFiles(source.root);
    let insertedEvents = 0;
    for (const file of files) {
      insertedEvents += store.ingestSession(importJsonlFile(source.client, file, source.root)).insertedEvents;
    }
    summary.push({ client: source.client, files: files.length, insertedEvents });
  }
  const databaseOption = process.argv.indexOf("--opencode-db");
  const openCodeDatabase = databaseOption >= 0 && process.argv[databaseOption + 1]
    ? process.argv[databaseOption + 1]
    : join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (existsSync(openCodeDatabase)) {
    let insertedEvents = 0;
    const sessions = importOpenCodeDatabase(openCodeDatabase);
    for (const session of sessions) {
      insertedEvents += store.ingestSession(session).insertedEvents;
    }
    summary.push({ client: "opencode", files: sessions.length, insertedEvents });
  }
  store.close();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else if (command === "export") {
  const paths = getHubPaths();
  ensureHubDirectories(paths);
  const store = new ArchiveStore(paths);
  const sessionId = optionValue("--session-id");
  const format = optionValue("--format") ?? "markdown";
  if (!sessionId || (format !== "markdown" && format !== "json")) {
    process.stderr.write("Usage: agent-memory-hub export --session-id ID --format markdown|json [--output PATH]\n");
    process.exitCode = 1;
  } else {
    const result = exportSession(store, paths, sessionId, format, optionValue("--output") ?? undefined);
    process.stdout.write(`${JSON.stringify({ filename: result.filename, path: result.path, content: result.path ? undefined : result.content }, null, 2)}\n`);
  }
  store.close();
} else if (command === "prune-skills") {
  const paths = getHubPaths();
  ensureHubDirectories(paths);
  const store = new ArchiveStore(paths);
  const result = prunePendingSkillCandidates(store);
  store.close();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function optionValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}
