import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import Database from "better-sqlite3";
import { containsSensitive } from "../shared/redact.js";
import type { ClientKind, ImportedEvent, ImportedSession } from "./types.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function findJsonlFiles(root: string): string[] {
  const found: string[] = [];
  function visit(path: string): void {
    if (!statSync(path).isDirectory()) {
      if (path.toLowerCase().endsWith(".jsonl")) {
        found.push(path);
      }
      return;
    }
    for (const entry of readdirSync(path)) {
      visit(join(path, entry));
    }
  }
  visit(root);
  return found.sort();
}

export async function* findJsonlFilesAsync(root: string): AsyncGenerator<string> {
  const info = await stat(root);
  if (!info.isDirectory()) {
    if (root.toLowerCase().endsWith(".jsonl")) {
      yield root;
    }
    return;
  }
  const entries = await readdir(root);
  for (const entry of entries.sort()) {
    yield* findJsonlFilesAsync(join(root, entry));
  }
}

function stringsFromContent(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringsFromContent);
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const output: string[] = [];
  for (const key of ["text", "content", "message", "input", "output", "prompt", "summary"]) {
    if (key in record) {
      output.push(...stringsFromContent(record[key]));
    }
  }
  return output;
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function extractMetadata(client: ClientKind, object: Record<string, unknown>): {
  timestamp: string | null;
  role: string | null;
  eventType: string;
  sourceSessionId: string | null;
  project: string | null;
  searchableText: string;
} {
  const payload = object.payload && typeof object.payload === "object" ? object.payload as Record<string, unknown> : undefined;
  const message = object.message && typeof object.message === "object" ? object.message as Record<string, unknown> : undefined;
  const timestamp = String(object.timestamp ?? payload?.timestamp ?? "") || null;
  const eventType = String(object.type ?? payload?.type ?? "event");
  const role = typeof message?.role === "string"
    ? message.role
    : typeof payload?.role === "string"
      ? payload.role
      : eventType;
  const sourceSessionId = typeof object.sessionId === "string"
    ? object.sessionId
    : typeof payload?.id === "string" && eventType === "session_meta"
      ? payload.id
      : null;
  const project = typeof object.cwd === "string"
    ? object.cwd
    : typeof payload?.cwd === "string"
      ? payload.cwd
      : null;
  const contentSource = client === "codex" ? (payload ?? object) : object;
  return {
    timestamp,
    role,
    eventType,
    sourceSessionId,
    project,
    searchableText: stringsFromContent(contentSource).join("\n")
  };
}

export function importJsonlFile(client: ClientKind, sourcePath: string, root: string): ImportedSession {
  const rawFile = readFileSync(sourcePath, "utf8");
  const sourceIdentity = `${client}:${relative(root, sourcePath).replaceAll("\\", "/")}`;
  const events: ImportedEvent[] = [];
  let sourceSessionId: string | null = null;
  let project: string | null = null;

  rawFile.split(/\r?\n/).forEach((rawJson, index) => {
    if (!rawJson.trim()) {
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawJson) as Record<string, unknown>;
    } catch {
      parsed = { type: "invalid_json", content: rawJson };
    }
    const metadata = extractMetadata(client, parsed);
    sourceSessionId ??= metadata.sourceSessionId;
    project ??= metadata.project;
    events.push({
      lineNumber: index,
      timestamp: metadata.timestamp,
      role: metadata.role,
      eventType: metadata.eventType,
      searchableText: metadata.searchableText,
      rawJson,
      rawSha256: hash(rawJson),
      sensitive: containsSensitive(metadata.searchableText) || containsSensitive(rawJson)
    });
  });

  return {
    sessionId: `${client}-${hash(sourceIdentity).slice(0, 24)}`,
    sourceSessionId: sourceSessionId ?? basename(sourcePath, ".jsonl"),
    client,
    sourcePath,
    project,
    fileSha256: hash(rawFile),
    events
  };
}

export function importOpenCodeDatabase(databasePath: string): ImportedSession[] {
  const database = new Database(databasePath, { readonly: true });
  try {
    const sessions = database.prepare(`
      SELECT id, directory, title, time_created, time_updated FROM session ORDER BY time_created ASC
    `).all() as Array<{ id: string; directory: string | null; title: string | null; time_created: number; time_updated: number }>;
    return sessions.map((session) => {
      const records = [
        ...database.prepare(`
          SELECT 'message' AS record_type, id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC
        `).all(session.id) as Array<{ record_type: string; id: string; time_created: number; data: string }>,
        ...database.prepare(`
          SELECT 'part' AS record_type, id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC
        `).all(session.id) as Array<{ record_type: string; id: string; time_created: number; data: string }>
      ].sort((left, right) => left.time_created - right.time_created || left.id.localeCompare(right.id));
      const events = records.map((record, lineNumber) => {
        const parsed = parseJsonValue(record.data);
        const rawJson = JSON.stringify({ recordType: record.record_type, id: record.id, sessionId: session.id, timeCreated: record.time_created, data: parsed });
        const searchableText = stringsFromContent(parsed).join("\n");
        return {
          lineNumber,
          timestamp: new Date(record.time_created).toISOString(),
          role: record.record_type,
          eventType: record.record_type,
          searchableText,
          rawJson,
          rawSha256: hash(rawJson),
          sensitive: containsSensitive(searchableText) || containsSensitive(rawJson)
        };
      });
      const fileIdentity = `${databasePath}#${session.id}`;
      return {
        sessionId: `opencode-${hash(fileIdentity).slice(0, 24)}`,
        sourceSessionId: session.id,
        client: "opencode",
        sourcePath: fileIdentity,
        project: session.directory,
        fileSha256: hash(events.map((event) => event.rawSha256).join(":")),
        events
      };
    });
  } finally {
    database.close();
  }
}
