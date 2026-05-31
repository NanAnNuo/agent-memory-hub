import { existsSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAllowedOpenCodeDatabases, getAllowedTranscriptRoots, getEverCoreConfig } from "../shared/config.js";
import { findJsonlFiles, importJsonlFile, importOpenCodeDatabase } from "../archive/importers.js";
import { ArchiveStore } from "../archive/store.js";
import type { ClientKind } from "../archive/types.js";
import { EverCoreClient, syncPendingEverCoreSessions } from "../evercore/client.js";

export interface SyncStatus {
  startedAt: string;
  lastSyncAt: string | null;
  lastReason: string | null;
  running: boolean;
  insertedEvents: Record<ClientKind, number>;
  errors: string[];
  evercore: { enabled: boolean; lastSyncAt: string | null; lastResult: string | null };
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
    errors: []
    ,
    evercore: { enabled: getEverCoreConfig().enabled, lastSyncAt: null, lastResult: null }
  };

  constructor(store: ArchiveStore) {
    this.store = store;
    const roots = getAllowedTranscriptRoots();
    this.roots = [
      { client: "codex", path: roots[0] ?? join(homedir(), ".codex", "sessions") },
      { client: "claude", path: roots[1] ?? join(homedir(), ".claude", "projects") }
    ];
  }

  async start(): Promise<void> {
    await this.syncAll("startup");
    for (const source of this.roots) {
      if (!existsSync(source.path)) {
        continue;
      }
      const watcher = watch(source.path, { recursive: true }, (_eventType, filename) => {
        if (!filename || filename.toLowerCase().endsWith(".jsonl")) {
          this.scheduleSync(`${source.client} filesystem change`);
        }
      });
      watcher.on("error", (error) => this.addError(error));
      this.watchers.push(watcher);
    }
    this.timer = setInterval(() => {
      void this.syncOpenCode("opencode database poll");
    }, Number(process.env.AGENT_HUB_OPENCODE_POLL_MS ?? "2000"));
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

  private async performSync(reason: string): Promise<void> {
    this.status.running = true;
    try {
      for (const source of this.roots) {
        if (!existsSync(source.path)) {
          continue;
        }
        for (const file of findJsonlFiles(source.path)) {
          const outcome = this.store.ingestSession(importJsonlFile(source.client, file, source.path));
          this.status.insertedEvents[source.client] += outcome.insertedEvents;
        }
      }
      this.ingestOpenCodeDatabases();
      await this.syncEverCoreIfEnabled();
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
      await this.syncEverCoreIfEnabled();
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

  private async syncEverCoreIfEnabled(): Promise<void> {
    const config = getEverCoreConfig();
    this.status.evercore.enabled = config.enabled;
    if (!config.enabled) {
      return;
    }
    const result = await syncPendingEverCoreSessions(this.store, new EverCoreClient(config), 20);
    this.status.evercore.lastSyncAt = new Date().toISOString();
    this.status.evercore.lastResult = `${result.synced} synced, ${result.failed} failed, ${result.messages} messages`;
  }

  private addError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.status.errors = [...this.status.errors.slice(-4), message];
  }
}
