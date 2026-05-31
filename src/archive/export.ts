import { writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { ArchiveStore } from "./store.js";
import type { SessionManifest, StoredEvent } from "./types.js";
import type { HubPaths } from "../shared/config.js";
import { readableConversationEvents } from "./readable.js";

export type ExportFormat = "json" | "markdown";

export interface ExportResult {
  filename: string;
  path: string | null;
  contentType: string;
  content: string;
}

export function exportSession(store: ArchiveStore, paths: HubPaths, sessionId: string, format: ExportFormat, outputPath?: string): ExportResult {
  const manifest = store.getManifest(sessionId);
  if (!manifest) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  const events = readableConversationEvents(store.getMessages(sessionId, 0, Math.max(manifest.eventCount, 1)));
  const filename = `${safeName(manifest.client)}-${safeName(manifest.sourceSessionId ?? manifest.sessionId)}.${format === "json" ? "json" : "md"}`;
  const content = format === "json"
    ? JSON.stringify(toJsonExport(manifest, events), null, 2)
    : toMarkdownExport(manifest, events);
  const selectedPath = outputPath ? normalizeOutputPath(outputPath, filename) : null;
  if (selectedPath) {
    writeFileSync(selectedPath, content, "utf8");
  }
  return {
    filename,
    path: selectedPath,
    contentType: format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
    content
  };
}

function toJsonExport(manifest: SessionManifest, events: StoredEvent[]) {
  return {
    exportedAt: new Date().toISOString(),
    redacted: true,
    manifest,
    readableEvents: events.length,
    events: events.map((event) => ({
      sourceAnchor: `${event.client}:${event.sessionId}#${event.lineNumber}`,
      lineNumber: event.lineNumber,
      timestamp: event.timestamp,
      role: event.role,
      eventType: event.eventType,
      text: event.searchableText,
      sensitive: event.sensitive
    }))
  };
}

function toMarkdownExport(manifest: SessionManifest, events: StoredEvent[]): string {
  const lines = [
    `# ${manifest.client} Session Export`,
    "",
    `- Session: ${manifest.sessionId}`,
    `- Source session: ${manifest.sourceSessionId ?? "n/a"}`,
    `- Project: ${manifest.project ?? "n/a"}`,
    `- Events: ${manifest.eventCount}`,
    `- Readable conversation messages: ${events.length}`,
    `- First timestamp: ${manifest.firstTimestamp ?? "n/a"}`,
    `- Last timestamp: ${manifest.lastTimestamp ?? "n/a"}`,
    "- Redacted: true",
    "",
    "## Timeline",
    ""
  ];
  for (const event of events) {
    lines.push(`### ${event.role ?? event.eventType} / ${event.timestamp ?? "no timestamp"}`);
    lines.push("");
    lines.push(`Source: \`${event.client}:${event.sessionId}#${event.lineNumber}\``);
    if (event.sensitive) {
      lines.push("");
      lines.push("> Sensitive content was redacted before export.");
    }
    lines.push("");
    lines.push(event.searchableText || "_No searchable text._");
    lines.push("");
  }
  return lines.join("\n");
}

function safeName(value: string): string {
  return value.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "session";
}

function normalizeOutputPath(outputPath: string, filename: string): string {
  return extname(outputPath) ? outputPath : join(outputPath, filename);
}
