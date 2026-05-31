import type { ArchiveStore } from "../archive/store.js";
import type { HubSettings, MemoryItem, SessionManifest } from "../archive/types.js";
import { readableConversationEvents } from "../archive/readable.js";

export interface LocalMemorySearchResult {
  cases: MemoryItem[];
  skills: MemoryItem[];
  profiles: MemoryItem[];
  degraded: boolean;
}

export async function buildMemoryFromSession(store: ArchiveStore, sessionId: string): Promise<{ memory: MemoryItem; candidateCreated: boolean }> {
  const manifest = store.getManifest(sessionId);
  if (!manifest) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  const events = readableConversationEvents(store.getMessages(sessionId, 0, Math.min(manifest.eventCount, 120)));
  const transcript = events.map((event) => `${event.role ?? event.eventType}: ${event.searchableText}`).join("\n\n");
  const settings = store.getSettings();
  const summary = settings.llmApiKey && settings.llmModel
    ? await summarizeWithLlm(settings, transcript)
    : fallbackSummary(transcript);
  const memory = store.putMemoryItem({
    memoryId: `mem-${manifest.sessionId}`,
    type: "case",
    scope: manifest.project ? "project" : "global",
    projectRoot: manifest.project,
    sessionId: manifest.sessionId,
    sourceAnchor: `${manifest.client}:${manifest.sessionId}`,
    title: titleFromSummary(summary, manifest),
    summary,
    tags: [manifest.client, manifest.project ? "project" : "global"].filter(Boolean)
  });
  return { memory, candidateCreated: false };
}

export function searchLocalMemory(store: ArchiveStore, query: string, projectRoot?: string, types: string[] = [], limit = 20): LocalMemorySearchResult {
  const items = store.searchMemory(query, projectRoot, types, limit);
  return {
    cases: items.filter((item) => item.type === "case"),
    skills: items.filter((item) => item.type === "skill_hint"),
    profiles: items.filter((item) => item.type === "profile"),
    degraded: true
  };
}

export function buildContextPack(store: ArchiveStore, sessionId: string, maxMessages = 40): { title: string; content: string } {
  const manifest = store.getManifest(sessionId);
  if (!manifest) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  const events = readableConversationEvents(store.getMessages(sessionId, 0, Math.min(manifest.eventCount, maxMessages)));
  const content = [
    `# Restore Context: ${manifest.sourceSessionId ?? manifest.sessionId}`,
    "",
    `- Agent: ${manifest.client}`,
    `- Project: ${manifest.project ?? "n/a"}`,
    `- Session: ${manifest.sessionId}`,
    "",
    "## Timeline",
    "",
    ...events.map((event) => `### ${event.role ?? event.eventType} @ ${event.timestamp ?? "n/a"}\n\n${event.searchableText}`)
  ].join("\n");
  return { title: manifest.sourceSessionId ?? manifest.sessionId, content };
}

async function summarizeWithLlm(settings: HubSettings, transcript: string): Promise<string> {
  const response = await fetch(`${settings.llmBaseUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.llmApiKey}`
    },
    body: JSON.stringify({
      model: settings.llmModel,
      messages: [
        { role: "system", content: "Summarize this agent development session into reusable memory. Return concise Chinese markdown with: task, solution, pitfalls, reusable rules." },
        { role: "user", content: transcript.slice(0, 24000) }
      ],
      temperature: 0.2
    }),
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) {
    throw new Error(`LLM summary failed with HTTP ${response.status}: ${await response.text()}`);
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() || fallbackSummary(transcript);
}

function fallbackSummary(transcript: string): string {
  const normalized = transcript.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 1800) || "No readable conversation text was available.";
}

function titleFromSummary(summary: string, manifest: SessionManifest): string {
  const first = summary.split(/\r?\n/).map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean);
  return (first || manifest.sourceSessionId || manifest.sessionId).slice(0, 96);
}
