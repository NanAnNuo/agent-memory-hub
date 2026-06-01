import type { ArchiveStore } from "../archive/store.js";
import type { HubSettings, MemoryItem, SessionManifest } from "../archive/types.js";
import { readableConversationEvents } from "../archive/readable.js";
import { redactSensitive } from "../shared/redact.js";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { upsertMemoryVector } from "./vector.js";

export interface LocalMemorySearchResult {
  cases: MemoryItem[];
  skills: MemoryItem[];
  profiles: MemoryItem[];
  degraded: boolean;
}

export async function buildMemoryFromSession(store: ArchiveStore, sessionId: string, options: { useLlm?: boolean } = {}): Promise<{ memory: MemoryItem; candidateCreated: boolean }> {
  const manifest = store.getManifest(sessionId);
  if (!manifest) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  const events = readableConversationEvents(store.getMessages(sessionId, 0, Math.min(manifest.eventCount, 120)));
  const transcript = events.map((event) => `${event.role ?? event.eventType}: ${event.searchableText}`).join("\n\n");
  const settings = store.getSettings();
  const useLlm = options.useLlm ?? true;
  const summary = useLlm && settings.llmApiKey && settings.llmModel
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
  await writeEmbeddingRecord(store, settings, memory).catch(() => undefined);
  const candidateCreated = createSkillCandidateFromSummary(store, manifest, summary, transcript);
  return { memory, candidateCreated };
}

export function searchLocalMemory(store: ArchiveStore, query: string, projectRoot?: string, types: string[] = [], limit = 20): LocalMemorySearchResult {
  const items = store.searchMemory(query, projectRoot, types, limit);
  const settings = store.getSettings();
  const hasEmbeddingIndex = existsSync(join(store.getHubPaths().lanceDbDir, "memory_vectors.lance"));
  return {
    cases: items.filter((item) => item.type === "case"),
    skills: items.filter((item) => item.type === "skill_hint"),
    profiles: items.filter((item) => item.type === "profile"),
    degraded: !(settings.embeddingModel && hasEmbeddingIndex)
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

async function writeEmbeddingRecord(store: ArchiveStore, settings: HubSettings, memory: MemoryItem): Promise<void> {
  if (!settings.embeddingBaseUrl || !settings.embeddingModel) {
    return;
  }
  const response = await fetch(`${settings.embeddingBaseUrl.replace(/\/+$/, "")}/v1/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(settings.embeddingApiKey ? { Authorization: `Bearer ${settings.embeddingApiKey}` } : {})
    },
    body: JSON.stringify({ model: settings.embeddingModel, input: `${memory.title}\n${memory.summary}`.slice(0, 12000) }),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    throw new Error(`Embedding failed with HTTP ${response.status}: ${await response.text()}`);
  }
  const data = await response.json() as { data?: Array<{ embedding?: number[] }> };
  const embedding = data.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error("Embedding response did not contain a vector.");
  }
  const dir = store.getHubPaths().lanceDbDir;
  mkdirSync(dir, { recursive: true });
  await upsertMemoryVector(dir, memory, embedding);
}

function fallbackSummary(transcript: string): string {
  const normalized = transcript.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 1800) || "No readable conversation text was available.";
}

function titleFromSummary(summary: string, manifest: SessionManifest): string {
  const first = summary.split(/\r?\n/).map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean);
  return (first || manifest.sourceSessionId || manifest.sessionId).slice(0, 96);
}

function createSkillCandidateFromSummary(store: ArchiveStore, manifest: SessionManifest, summary: string, transcript: string): boolean {
  const readableText = `${summary}\n${transcript}`.toLowerCase();
  const hasReusableSignal = [
    "skill", "workflow", "rule", "pitfall", "经验", "规则", "复用", "工作流", "踩坑", "修复", "调试", "配置", "ui", "测试"
  ].some((token) => readableText.includes(token));
  if (!hasReusableSignal || transcript.trim().length < 80) {
    return false;
  }
  const title = titleFromSummary(summary, manifest).replace(/^[-*#\s]+/, "").slice(0, 80) || "Reusable agent workflow";
  const candidateId = `auto-${manifest.sessionId}`;
  const existing = store.getSkillCandidate(candidateId);
  if (existing) {
    return false;
  }
  store.putSkillCandidate({
    candidateId,
    scope: manifest.project ? "project" : "global",
    type: "workflow",
    title,
    lesson: redactSensitive(summary).slice(0, 4000),
    evidence: [`${manifest.client}:${manifest.sessionId}`, `source:${manifest.sourcePath}`],
    reuseRule: `Use when a future task matches this session's problem pattern: ${title}`,
    redactionStatus: "redacted",
    promotionTarget: "skill",
    projectRoot: manifest.project
  });
  return true;
}
