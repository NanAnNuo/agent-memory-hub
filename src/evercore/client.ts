import type { ArchiveStore } from "../archive/store.js";
import type { SessionManifest, StoredEvent } from "../archive/types.js";
import { readableConversationEvents } from "../archive/readable.js";
import type { EverCoreConfig } from "../shared/config.js";

export interface EverCoreStatus {
  configured: boolean;
  enabled: boolean;
  url: string;
  root: string;
  userId: string;
  reachable: boolean;
  error: string | null;
}

export interface EverCoreSearchResult {
  cases: unknown[];
  skills: unknown[];
  raw: unknown;
}

interface AgentMessage {
  message_id: string;
  role: string;
  content: string;
  timestamp: number;
}

export class EverCoreClient {
  constructor(private readonly config: EverCoreConfig) {}

  async status(): Promise<EverCoreStatus> {
    try {
      const response = await fetch(`${this.config.url}/api/v1/memories/get`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memory_type: "agent_skill",
          page: 1,
          page_size: 1,
          filters: { user_id: this.config.userId }
        }),
        signal: AbortSignal.timeout(3000)
      });
      return {
        configured: true,
        enabled: this.config.enabled,
        url: this.config.url,
        root: this.config.root,
        userId: this.config.userId,
        reachable: response.ok,
        error: response.ok ? null : `HTTP ${response.status}`
      };
    } catch (error) {
      return {
        configured: true,
        enabled: this.config.enabled,
        url: this.config.url,
        root: this.config.root,
        userId: this.config.userId,
        reachable: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async syncSession(store: ArchiveStore, manifest: SessionManifest): Promise<{ sentMessages: number }> {
    const events = store.getMessages(manifest.sessionId, 0, Math.max(manifest.eventCount, 1));
    const messages = toAgentMessages(manifest, events);
    if (!messages.length) {
      store.markEverCoreSynced(manifest.sessionId, manifest.fileSha256);
      return { sentMessages: 0 };
    }
    await this.postJson("/api/v1/memories/agent", {
      user_id: this.config.userId,
      session_id: manifest.sessionId,
      messages
    });
    await this.postJson("/api/v1/memories/agent/flush", {
      user_id: this.config.userId,
      session_id: manifest.sessionId
    });
    store.markEverCoreSynced(manifest.sessionId, manifest.fileSha256);
    return { sentMessages: messages.length };
  }

  async searchAgentMemory(query: string, topK = 8, method = "hybrid"): Promise<EverCoreSearchResult> {
    const data = await this.postJson("/api/v1/memories/search", {
      query,
      method,
      memory_types: ["agent_memory"],
      filters: { user_id: this.config.userId },
      top_k: topK
    });
    const result = asRecord(asRecord(data).data).agent_memory;
    const agentMemory = asRecord(result);
    return {
      cases: Array.isArray(agentMemory.cases) ? agentMemory.cases : [],
      skills: Array.isArray(agentMemory.skills) ? agentMemory.skills : [],
      raw: data
    };
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.config.url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) {
      throw new Error(`EverCore ${path} failed with HTTP ${response.status}: ${await response.text()}`);
    }
    return response.json() as Promise<unknown>;
  }
}

export async function syncPendingEverCoreSessions(store: ArchiveStore, client: EverCoreClient, limit = 20): Promise<{ attempted: number; synced: number; failed: number; messages: number }> {
  const pending = store.getPendingEverCoreManifests(limit);
  let synced = 0;
  let failed = 0;
  let messages = 0;
  for (const manifest of pending) {
    try {
      const result = await client.syncSession(store, manifest);
      synced += 1;
      messages += result.sentMessages;
    } catch (error) {
      failed += 1;
      store.markEverCoreFailed(manifest.sessionId, manifest.fileSha256, error instanceof Error ? error.message : String(error));
    }
  }
  return { attempted: pending.length, synced, failed, messages };
}

function toAgentMessages(manifest: SessionManifest, events: StoredEvent[]): AgentMessage[] {
  return readableConversationEvents(events)
    .filter((event) => event.searchableText.trim())
    .map((event, index) => ({
      message_id: `${manifest.sessionId}_${String(event.lineNumber).padStart(6, "0")}_${index}`,
      role: normalizeRole(event.role),
      content: event.searchableText,
      timestamp: timestampMillis(event.timestamp, index)
    }));
}

function normalizeRole(role: string | null): string {
  if (role === "assistant" || role === "user" || role === "tool" || role === "system") {
    return role;
  }
  return "user";
}

function timestampMillis(value: string | null, offset: number): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed + offset : Date.now() + offset;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
