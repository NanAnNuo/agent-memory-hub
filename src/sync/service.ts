import { existsSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAllowedOpenCodeDatabases, getAllowedTranscriptRoots } from "../shared/config.js";
import { findJsonlFilesAsync, importJsonlFile, importOpenCodeDatabase } from "../archive/importers.js";
import { ArchiveStore } from "../archive/store.js";
import type { ClientKind } from "../archive/types.js";
import { buildMemoryFromSession } from "../memory/local.js";

export interface SyncStatus {
  startedAt: string;
  lastSyncAt: string | null;
  lastReason: string | null;
  running: boolean;
  insertedEvents: Record<ClientKind, number>;
  errors: string[];
  memory: { enabled: boolean; lastSyncAt: string | null; lastResult: string | null };
}

export class LiveSyncService {
  private readonly store: ArchiveStore;
  private readonly watchers: FSWatcher[] = [];
  private readonly roots: Array<{ client: "codex" | "claude"; path: string }>;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  readonly status: SyncStatus = {
    startedAt: new Date().toISOString(),
    lastSyncAt: null,
    lastReason: null,
    running: false,
    insertedEvents: { codex: 0, claude: 0, opencode: 0 },
    errors: [],
    memory: { enabled: true, lastSyncAt: null, lastResult: null }
  };

  constructor(store: ArchiveStore) {
    this.store = store;
    const roots = getAllowedTranscriptRoots();
    const useDefaultRoots = process.env.AGENT_HUB_INCLUDE_DEFAULT_TRANSCRIPT_ROOTS !== "false";
    this.roots = [
      roots[0] ? { client: "codex" as const, path: roots[0] } : useDefaultRoots ? { client: "codex" as const, path: join(homedir(), ".codex", "sessions") } : null,
      roots[1] ? { client: "claude" as const, path: roots[1] } : useDefaultRoots ? { client: "claude" as const, path: join(homedir(), ".claude", "projects") } : null
    ].filter((root): root is { client: "codex" | "claude"; path: string } => root !== null);
  }

  async start(): Promise<void> {
    if (process.env.AGENT_HUB_STARTUP_SYNC === "true") {
      setTimeout(() => {
        void this.syncAll("startup");
      }, Number(process.env.AGENT_HUB_STARTUP_SYNC_DELAY_MS ?? "15000"));
    }
    if (process.env.AGENT_HUB_LIVE_WATCH !== "false") {
      for (const source of this.roots) {
        if (!existsSync(source.path)) {
          continue;
        }
        const watcher = watch(source.path, { recursive: true }, (_eventType, filename) => {
          if (filename && filename.toLowerCase().endsWith(".jsonl")) {
            this.scheduleFileSync(source.client, source.path, resolve(source.path, filename), `${source.client} file change`);
          }
        });
        watcher.on("error", (error) => this.addError(error));
        this.watchers.push(watcher);
      }
    }
    if (process.env.AGENT_HUB_OPENCODE_POLL === "true") {
      this.timer = setInterval(() => {
        void this.syncOpenCode("opencode database poll");
      }, Number(process.env.AGENT_HUB_OPENCODE_POLL_MS ?? "2000"));
    }
  }

  async syncAll(reason: string): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.performSync(reason).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async syncOpenCode(reason: string): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.performOpenCodeSync(reason).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  close(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    if (this.timer) {
      clearInterval(this.timer);
    }
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
  }

  private scheduleSync(reason: string): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this.debounce = setTimeout(() => {
      void this.syncAll(reason);
    }, 250);
  }

  private scheduleFileSync(client: "codex" | "claude", root: string, file: string, reason: string): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this.debounce = setTimeout(() => {
      void this.syncJsonlFile(client, root, file, reason);
    }, 350);
  }

  private async syncJsonlFile(client: "codex" | "claude", root: string, file: string, reason: string): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.performJsonlFileSync(client, root, file, reason).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async performSync(reason: string): Promise<void> {
    this.status.running = true;
    try {
      for (const source of this.roots) {
        if (!existsSync(source.path)) {
          continue;
        }
        let fileIndex = 0;
        for await (const file of findJsonlFilesAsync(source.path)) {
          const outcome = this.store.ingestSession(importJsonlFile(source.client, file, source.path));
          this.status.insertedEvents[source.client] += outcome.insertedEvents;
          fileIndex += 1;
          if (fileIndex % 1 === 0) {
            await yieldToEventLoop();
          }
        }
      }
      this.ingestOpenCodeDatabases();
      await this.syncLocalMemoryState();
      this.status.lastSyncAt = new Date().toISOString();
      this.status.lastReason = reason;
    } catch (error) {
      this.addError(error);
    } finally {
      this.status.running = false;
    }
  }

  private async performOpenCodeSync(reason: string): Promise<void> {
    this.status.running = true;
    try {
      this.ingestOpenCodeDatabases();
      await this.syncLocalMemoryState();
      this.status.lastSyncAt = new Date().toISOString();
      this.status.lastReason = reason;
    } catch (error) {
      this.addError(error);
    } finally {
      this.status.running = false;
    }
  }

  private async performJsonlFileSync(client: "codex" | "claude", root: string, file: string, reason: string): Promise<void> {
    this.status.running = true;
    try {
      if (existsSync(file)) {
        const outcome = this.store.ingestSession(importJsonlFile(client, file, root));
        this.status.insertedEvents[client] += outcome.insertedEvents;
        await this.syncLocalMemoryState();
      }
      this.status.lastSyncAt = new Date().toISOString();
      this.status.lastReason = reason;
    } catch (error) {
      this.addError(error);
    } finally {
      this.status.running = false;
    }
  }

  private ingestOpenCodeDatabases(): void {
    for (const databasePath of getAllowedOpenCodeDatabases()) {
      if (!existsSync(databasePath)) {
        continue;
      }
      for (const session of importOpenCodeDatabase(databasePath)) {
        const outcome = this.store.ingestSession(session);
        this.status.insertedEvents.opencode += outcome.insertedEvents;
      }
    }
  }

  private async syncLocalMemoryState(): Promise<void> {
    this.status.memory.enabled = true;
    this.status.memory.lastSyncAt = new Date().toISOString();
    const pending = this.store.getPendingMemoryManifests(Number(process.env.AGENT_HUB_MEMORY_BUILD_BATCH ?? "5"));
    let built = 0;
    for (const manifest of pending) {
      try {
        await buildMemoryFromSession(this.store, manifest.sessionId, { useLlm: process.env.AGENT_HUB_SYNC_USE_LLM === "true" });
        this.store.markMemorySynced(manifest.sessionId, manifest.fileSha256);
        built += 1;
      } catch (error) {
        this.store.markMemoryFailed(manifest.sessionId, manifest.fileSha256, error instanceof Error ? error.message : String(error));
      }
      await yieldToEventLoop();
    }
    this.status.memory.lastResult = built ? `built ${built} local memory item(s) and reviewable skill candidates` : "archive sync complete; no pending memory items";
  }

  private addError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.status.errors = [...this.status.errors.slice(-4), message];
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
