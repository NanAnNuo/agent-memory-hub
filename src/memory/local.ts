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

interface CandidateQuality {
  ok: boolean;
  score: number;
  reasons: string[];
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
  if (!normalized) {
    return "No readable conversation text was available.";
  }
  const request = extractRoleText(transcript, "user") || normalized;
  const answer = extractRoleText(transcript, "assistant") || normalized;
  return [
    `功能：${summarizeLine(request, 180)}`,
    `应用场景：当未来任务涉及相同项目、工具链、实现约束或问题模式时复用。`,
    `经验：${summarizeLine(answer, 900)}`
  ].join("\n");
}

function titleFromSummary(summary: string, manifest: SessionManifest): string {
  const functionLine = summary.split(/\r?\n/).find((line) => /^功能[:：]/.test(line.trim()));
  const first = (functionLine || summary).split(/\r?\n/).map((line) => line.replace(/^#+\s*/, "").replace(/^功能[:：]\s*/, "").replace(/^(user|assistant|agent)\s*[:：]\s*/i, "").trim()).find(Boolean);
  return (first || manifest.sourceSessionId || manifest.sessionId).slice(0, 96);
}

function createSkillCandidateFromSummary(store: ArchiveStore, manifest: SessionManifest, summary: string, transcript: string): boolean {
  const quality = evaluateCandidateQuality(manifest, summary, transcript);
  if (!quality.ok) {
    return false;
  }
  const readableText = `${summary}\n${transcript}`.toLowerCase();
  const hasReusableSignal = [
    "skill", "workflow", "rule", "pitfall", "经验", "规则", "复用", "工作流", "踩坑", "修复", "调试", "配置", "ui", "测试"
  ].some((token) => readableText.includes(token));
  if (!hasReusableSignal || transcript.trim().length < 80) {
    return false;
  }
  const title = titleFromSummary(summary, manifest).replace(/^[-*#\s]+/, "").slice(0, 80) || "Reusable agent workflow";
  const scenario = summary.split(/\r?\n/).find((line) => /^应用场景[:：]/.test(line.trim()))?.replace(/^应用场景[:：]\s*/, "").trim();
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
    evidence: [`${manifest.client}:${manifest.sessionId}`, `quality:${quality.score}`, ...quality.reasons.map((reason) => `signal:${reason}`), `source:${manifest.sourcePath}`],
    reuseRule: scenario || `Use when a future task matches this session's problem pattern: ${title}`,
    redactionStatus: "redacted",
    promotionTarget: "skill",
    projectRoot: manifest.project
  });
  return true;
}

function evaluateCandidateQuality(manifest: SessionManifest, summary: string, transcript: string): CandidateQuality {
  const text = `${summary}\n${transcript}`;
  const lowered = text.toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  if (isNoiseSession(manifest, lowered)) {
    return { ok: false, score: 0, reasons: ["noise-session"] };
  }
  const readableLength = transcript.replace(/\s+/g, " ").trim().length;
  const userTurns = countRoleTurns(transcript, "user");
  const assistantTurns = countRoleTurns(transcript, "assistant");
  if (readableLength >= 700 && userTurns >= 1 && assistantTurns >= 2) {
    score += 2;
    reasons.push("substantial-dialogue");
  } else if (readableLength >= 350 && userTurns >= 1 && assistantTurns >= 1) {
    score += 1;
    reasons.push("complete-dialogue");
  }
  if (matchesAny(lowered, ["bug", "fix", "error", "failed", "regression", "timeout", "修复", "报错", "失败", "异常", "卡死", "回退"])) {
    score += 2;
    reasons.push("problem-and-fix");
  }
  if (matchesAny(lowered, ["implemented", "changed", "verified", "test passed", "commit", "已完成", "验证", "测试通过", "提交", "定位", "解决"])) {
    score += 2;
    reasons.push("verified-outcome");
  }
  if (matchesAny(lowered, ["use when", "reuse", "reusable", "rule", "pattern", "workflow", "以后", "复用", "规则", "模式", "工作流", "适用于", "应用场景"])) {
    score += 2;
    reasons.push("reusable-scenario");
  }
  if (matchesAny(lowered, ["playwright", "sqlite", "mcp", "dashboard", "powershell", "scheduledtask", "lancedb", "api", "typescript", "vitest"])) {
    score += 1;
    reasons.push("specific-tooling");
  }
  if (hasActionableShape(summary)) {
    score += 1;
    reasons.push("structured-summary");
  }
  if (isLowValue(lowered)) {
    score -= 3;
    reasons.push("low-value-noise");
  }
  return { ok: score >= 6, score, reasons };
}

function isNoiseSession(manifest: SessionManifest, loweredText: string): boolean {
  const identity = `${manifest.sourcePath}\n${manifest.sourceSessionId ?? ""}\n${loweredText.slice(0, 1200)}`.toLowerCase();
  return identity.includes("agents.md instructions")
    || identity.includes("<instructions>")
    || identity.includes("claude.md")
    || identity.includes("core communication")
    || identity.includes("核心通信法则")
    || identity.includes("user_authorization")
    || identity.includes("risk_level")
    || identity.includes("startup rule")
    || identity.includes("internal startup");
}

function isLowValue(loweredText: string): boolean {
  return matchesAny(loweredText, [
    "who are you", "你是谁", "你还记得", "默认加载提示词", "search the entire c:\\users", "打开浏览器，进入b站"
  ]);
}

function hasActionableShape(summary: string): boolean {
  return /功能[:：]/.test(summary)
    && /应用场景[:：]/.test(summary)
    && /经验[:：]/.test(summary);
}

function countRoleTurns(transcript: string, role: string): number {
  return (transcript.match(new RegExp(`(^|\\n\\n)${role}:`, "gi")) ?? []).length;
}

function matchesAny(value: string, tokens: string[]): boolean {
  return tokens.some((token) => value.includes(token));
}

function extractRoleText(transcript: string, role: string): string {
  const match = transcript.match(new RegExp(`${role}:\\s*([\\s\\S]*?)(?:\\n\\n(?:user|assistant|tool|system|developer):|$)`, "i"));
  return match?.[1]?.trim() ?? "";
}

function summarizeLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}
