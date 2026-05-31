import Database from "better-sqlite3";
import { appendFileSync } from "node:fs";
import type { HubPaths } from "../shared/config.js";
import { redactSensitive } from "../shared/redact.js";
import type { HubSettings, HubSkill, ImportedSession, MemoryItem, MemorySyncRecord, SessionListItem, SessionManifest, SkillCandidate, StoredEvent, TaskCheckpoint } from "./types.js";

type DatabaseType = InstanceType<typeof Database>;

export class ArchiveStore {
  private readonly db: DatabaseType;
  private readonly paths: HubPaths;

  constructor(paths: HubPaths) {
    this.paths = paths;
    this.db = new Database(paths.archiveDatabase);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        source_session_id TEXT,
        client TEXT NOT NULL,
        source_path TEXT NOT NULL,
        project TEXT,
        file_sha256 TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        first_timestamp TEXT,
        last_timestamp TEXT,
        ingested_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        client TEXT NOT NULL,
        source_path TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        timestamp TEXT,
        role TEXT,
        event_type TEXT NOT NULL,
        searchable_text TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        raw_sha256 TEXT NOT NULL,
        sensitive INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(source_path, line_number, raw_sha256)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(searchable_text, session_id UNINDEXED, event_id UNINDEXED);
      CREATE TABLE IF NOT EXISTS deleted_sessions (
        session_id TEXT PRIMARY KEY,
        deleted_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        task_id TEXT PRIMARY KEY,
        checkpoint_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_sync (
        session_id TEXT PRIMARY KEY,
        file_sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        synced_at TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS memory_items (
        memory_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        project_root TEXT,
        session_id TEXT,
        source_anchor TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(title, summary, tags, memory_id UNINDEXED);
      CREATE TABLE IF NOT EXISTS hub_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hub_skills (
        skill_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        project_root TEXT,
        project_hash TEXT,
        path TEXT NOT NULL,
        reuse_rule TEXT NOT NULL,
        status TEXT NOT NULL,
        source_candidate_id TEXT,
        source_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS skill_candidates (
        candidate_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        lesson TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        reuse_rule TEXT NOT NULL,
        redaction_status TEXT NOT NULL,
        promotion_target TEXT NOT NULL,
        project_root TEXT,
        status TEXT NOT NULL,
        target_path TEXT,
        created_at TEXT NOT NULL,
        promoted_at TEXT
      );
    `);
  }

  ingestSession(session: ImportedSession): { insertedEvents: number; sessionId: string } {
    if (this.isSessionDeleted(session.sessionId)) {
      return { insertedEvents: 0, sessionId: session.sessionId };
    }
    const insertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO events (
        session_id, client, source_path, line_number, timestamp, role, event_type,
        searchable_text, raw_json, raw_sha256, sensitive, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.db.prepare("INSERT INTO event_fts(searchable_text, session_id, event_id) VALUES (?, ?, ?)");
    let insertedEvents = 0;
    this.db.transaction(() => {
      for (const event of session.events) {
        const result = insertEvent.run(
          session.sessionId,
          session.client,
          session.sourcePath,
          event.lineNumber,
          event.timestamp,
          event.role,
          event.eventType,
          redactSensitive(event.searchableText),
          event.sensitive ? redactSensitive(event.rawJson) : event.rawJson,
          event.rawSha256,
          event.sensitive ? 1 : 0,
          new Date().toISOString()
        );
        if (result.changes === 1) {
          insertFts.run(event.searchableText, session.sessionId, Number(result.lastInsertRowid));
          insertedEvents += 1;
        }
      }
      const timestamps = session.events.map((event) => event.timestamp).filter((value): value is string => Boolean(value)).sort();
      this.db.prepare(`
        INSERT INTO sessions (
          session_id, source_session_id, client, source_path, project, file_sha256,
          event_count, first_timestamp, last_timestamp, ingested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          source_session_id=excluded.source_session_id,
          project=excluded.project,
          file_sha256=excluded.file_sha256,
          event_count=(SELECT COUNT(*) FROM events WHERE session_id=excluded.session_id),
          first_timestamp=excluded.first_timestamp,
          last_timestamp=excluded.last_timestamp,
          ingested_at=excluded.ingested_at
      `).run(
        session.sessionId,
        session.sourceSessionId,
        session.client,
        session.sourcePath,
        session.project,
        session.fileSha256,
        session.events.length,
        timestamps.at(0) ?? null,
        timestamps.at(-1) ?? null,
        new Date().toISOString()
      );
    })();
    return { insertedEvents, sessionId: session.sessionId };
  }

  listManifests(client?: string): SessionManifest[] {
    const rows = client
      ? this.db.prepare("SELECT * FROM sessions WHERE client = ? ORDER BY last_timestamp DESC").all(client)
      : this.db.prepare("SELECT * FROM sessions ORDER BY last_timestamp DESC").all();
    return (rows as Array<Record<string, unknown>>).map(mapManifest);
  }

  listSessionItems(client?: string): SessionListItem[] {
    return this.listManifests(client).map((manifest) => ({
      ...manifest,
      ...this.getSessionListMetadata(manifest.sessionId)
    }));
  }

  getManifest(sessionId: string): SessionManifest | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
    return row ? mapManifest(row as Record<string, unknown>) : null;
  }

  getMessages(sessionId: string, offset: number, limit: number, includeRaw = false): StoredEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM events WHERE session_id = ? AND line_number >= ?
      ORDER BY line_number ASC, id ASC LIMIT ?
    `).all(sessionId, offset, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapEvent(row, includeRaw));
  }

  deleteSession(sessionId: string): { deleted: boolean } {
    const manifest = this.getManifest(sessionId);
    if (!manifest) {
      return { deleted: false };
    }
    this.db.transaction(() => {
      this.db.prepare("INSERT OR REPLACE INTO deleted_sessions(session_id, deleted_at) VALUES (?, ?)").run(sessionId, new Date().toISOString());
      this.db.prepare("DELETE FROM event_fts WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM events WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM memory_sync WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
    })();
    return { deleted: true };
  }

  getRecentMessages(sessionIds: string[], limit: number): StoredEvent[] {
    if (!sessionIds.length) {
      return [];
    }
    const placeholders = sessionIds.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT * FROM events WHERE session_id IN (${placeholders})
      ORDER BY COALESCE(timestamp, created_at) DESC, id DESC LIMIT ?
    `).all(...sessionIds, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapEvent(row, false));
  }

  searchMessages(query: string, sessionIds: string[] | undefined, limit: number, offset: number): StoredEvent[] {
    const filter = sessionIds?.length ? ` AND e.session_id IN (${sessionIds.map(() => "?").join(",")})` : "";
    const matchQuery = `"${query.replaceAll('"', '""')}"`;
    const args = sessionIds?.length ? [matchQuery, ...sessionIds, limit, offset] : [matchQuery, limit, offset];
    const rows = this.db.prepare(`
      SELECT e.* FROM event_fts f JOIN events e ON e.id = f.event_id
      WHERE event_fts MATCH ?${filter}
      ORDER BY rank LIMIT ? OFFSET ?
    `).all(...args) as Array<Record<string, unknown>>;
    return rows.map((row) => mapEvent(row, false));
  }

  getRawEvents(sessionId: string, offset: number, limit: number, confirmSensitive: boolean): StoredEvent[] {
    if (!confirmSensitive) {
      throw new Error("Reading archived source-form events requires confirm_sensitive=true because transcripts may contain sensitive content.");
    }
    appendFileSync(this.paths.auditLog, `${JSON.stringify({ action: "archive_get_raw_events", sessionId, offset, limit, timestamp: new Date().toISOString() })}\n`, "utf8");
    return this.getMessages(sessionId, offset, limit, true);
  }

  putCheckpoint(checkpoint: Omit<TaskCheckpoint, "updatedAt">): TaskCheckpoint {
    const complete: TaskCheckpoint = { ...checkpoint, updatedAt: new Date().toISOString() };
    this.db.prepare(`
      INSERT INTO checkpoints(task_id, checkpoint_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET checkpoint_json=excluded.checkpoint_json, updated_at=excluded.updated_at
    `).run(complete.taskId, JSON.stringify(complete), complete.updatedAt);
    return complete;
  }

  getCheckpoint(taskId: string): TaskCheckpoint | null {
    const row = this.db.prepare("SELECT checkpoint_json FROM checkpoints WHERE task_id = ?").get(taskId) as { checkpoint_json: string } | undefined;
    return row ? JSON.parse(row.checkpoint_json) as TaskCheckpoint : null;
  }

  getPendingMemoryManifests(limit: number): SessionManifest[] {
    const rows = this.db.prepare(`
      SELECT s.* FROM sessions s
      LEFT JOIN memory_sync e ON e.session_id = s.session_id AND e.file_sha256 = s.file_sha256 AND e.status = 'synced'
      WHERE e.session_id IS NULL
      ORDER BY COALESCE(s.last_timestamp, s.ingested_at) ASC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map(mapManifest);
  }

  listMemorySync(): MemorySyncRecord[] {
    const rows = this.db.prepare("SELECT * FROM memory_sync ORDER BY synced_at DESC").all() as Array<Record<string, unknown>>;
    return rows.map(mapMemorySync);
  }

  markMemorySynced(sessionId: string, fileSha256: string): MemorySyncRecord {
    this.db.prepare(`
      INSERT INTO memory_sync(session_id, file_sha256, status, synced_at, error) VALUES (?, ?, 'synced', ?, NULL)
      ON CONFLICT(session_id) DO UPDATE SET file_sha256=excluded.file_sha256, status='synced', synced_at=excluded.synced_at, error=NULL
    `).run(sessionId, fileSha256, new Date().toISOString());
    return this.listMemorySync().find((record) => record.sessionId === sessionId)!;
  }

  markMemoryFailed(sessionId: string, fileSha256: string, error: string): MemorySyncRecord {
    this.db.prepare(`
      INSERT INTO memory_sync(session_id, file_sha256, status, synced_at, error) VALUES (?, ?, 'failed', ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET file_sha256=excluded.file_sha256, status='failed', synced_at=excluded.synced_at, error=excluded.error
    `).run(sessionId, fileSha256, new Date().toISOString(), error);
    return this.listMemorySync().find((record) => record.sessionId === sessionId)!;
  }

  putMemoryItem(item: Omit<MemoryItem, "createdAt" | "updatedAt" | "status"> & Partial<Pick<MemoryItem, "createdAt" | "updatedAt" | "status">>): MemoryItem {
    const now = new Date().toISOString();
    const complete: MemoryItem = {
      ...item,
      status: item.status ?? "active",
      createdAt: item.createdAt ?? now,
      updatedAt: item.updatedAt ?? now
    };
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO memory_items(memory_id, type, scope, project_root, session_id, source_anchor, title, summary, tags_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_id) DO UPDATE SET
          type=excluded.type, scope=excluded.scope, project_root=excluded.project_root, session_id=excluded.session_id,
          source_anchor=excluded.source_anchor, title=excluded.title, summary=excluded.summary, tags_json=excluded.tags_json,
          status=excluded.status, updated_at=excluded.updated_at
      `).run(
        complete.memoryId,
        complete.type,
        complete.scope,
        complete.projectRoot,
        complete.sessionId,
        complete.sourceAnchor,
        complete.title,
        complete.summary,
        JSON.stringify(complete.tags),
        complete.status,
        complete.createdAt,
        complete.updatedAt
      );
      this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(complete.memoryId);
      this.db.prepare("INSERT INTO memory_fts(title, summary, tags, memory_id) VALUES (?, ?, ?, ?)").run(complete.title, complete.summary, complete.tags.join(" "), complete.memoryId);
    })();
    return complete;
  }

  searchMemory(query: string, projectRoot?: string, types: string[] = [], limit = 20): MemoryItem[] {
    const clauses = ["m.status = 'active'"];
    const args: unknown[] = [];
    if (query.trim()) {
      clauses.push("memory_fts MATCH ?");
      args.push(`"${query.replaceAll('"', '""')}"`);
    }
    if (projectRoot) {
      clauses.push("(m.scope = 'global' OR m.project_root = ?)");
      args.push(projectRoot);
    }
    if (types.length) {
      clauses.push(`m.type IN (${types.map(() => "?").join(",")})`);
      args.push(...types);
    }
    args.push(limit);
    const joinFts = query.trim() ? "JOIN memory_fts f ON f.memory_id = m.memory_id" : "";
    const orderBy = query.trim() ? "ORDER BY rank" : "ORDER BY m.updated_at DESC";
    const rows = this.db.prepare(`
      SELECT m.* FROM memory_items m ${joinFts}
      WHERE ${clauses.join(" AND ")}
      ${orderBy}
      LIMIT ?
    `).all(...args) as Array<Record<string, unknown>>;
    return rows.map(mapMemoryItem);
  }

  getSettings(): HubSettings {
    const rows = this.db.prepare("SELECT key, value FROM hub_settings").all() as Array<{ key: string; value: string }>;
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return {
      llmProvider: values.llmProvider ?? "deepseek",
      llmBaseUrl: values.llmBaseUrl ?? process.env.AGENT_HUB_LLM_BASE_URL ?? "https://api.deepseek.com",
      llmModel: values.llmModel ?? process.env.AGENT_HUB_LLM_MODEL ?? "",
      llmApiKey: values.llmApiKey ?? process.env.AGENT_HUB_LLM_API_KEY ?? "",
      embeddingBaseUrl: values.embeddingBaseUrl ?? process.env.AGENT_HUB_EMBEDDING_BASE_URL ?? "",
      embeddingModel: values.embeddingModel ?? process.env.AGENT_HUB_EMBEDDING_MODEL ?? "",
      embeddingApiKey: values.embeddingApiKey ?? process.env.AGENT_HUB_EMBEDDING_API_KEY ?? "",
      profileMemoryEnabled: values.profileMemoryEnabled === "true",
      backgroundSyncEnabled: values.backgroundSyncEnabled === "true",
      manualModelEntry: values.manualModelEntry === "true"
    };
  }

  updateSettings(input: Partial<HubSettings>): HubSettings {
    const current = this.getSettings();
    const next = { ...current, ...input };
    const now = new Date().toISOString();
    const stmt = this.db.prepare("INSERT INTO hub_settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at");
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(next)) {
        stmt.run(key, String(value), now);
      }
    })();
    return this.getSettings();
  }

  putHubSkill(skill: Omit<HubSkill, "createdAt" | "updatedAt" | "status" | "lastUsedAt"> & Partial<Pick<HubSkill, "createdAt" | "updatedAt" | "status" | "lastUsedAt">>): HubSkill {
    const now = new Date().toISOString();
    const complete: HubSkill = { ...skill, status: skill.status ?? "active", createdAt: skill.createdAt ?? now, updatedAt: skill.updatedAt ?? now, lastUsedAt: skill.lastUsedAt ?? null };
    this.db.prepare(`
      INSERT INTO hub_skills(skill_id, scope, title, slug, project_root, project_hash, path, reuse_rule, status, source_candidate_id, source_session_id, created_at, updated_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(skill_id) DO UPDATE SET
        title=excluded.title, reuse_rule=excluded.reuse_rule, status=excluded.status,
        path=excluded.path, updated_at=excluded.updated_at, last_used_at=excluded.last_used_at
    `).run(
      complete.skillId,
      complete.scope,
      complete.title,
      complete.slug,
      complete.projectRoot,
      complete.projectHash,
      complete.path,
      complete.reuseRule,
      complete.status,
      complete.sourceCandidateId,
      complete.sourceSessionId,
      complete.createdAt,
      complete.updatedAt,
      complete.lastUsedAt
    );
    return complete;
  }

  listHubSkills(projectRoot?: string, includeDisabled = false): HubSkill[] {
    const clauses = includeDisabled ? [] : ["status = 'active'"];
    const args: unknown[] = [];
    if (projectRoot) {
      clauses.push("(scope = 'global' OR project_root = ?)");
      args.push(projectRoot);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM hub_skills ${where} ORDER BY updated_at DESC`).all(...args) as Array<Record<string, unknown>>;
    return rows.map(mapHubSkill);
  }

  getHubSkill(skillId: string): HubSkill | null {
    const row = this.db.prepare("SELECT * FROM hub_skills WHERE skill_id = ?").get(skillId);
    return row ? mapHubSkill(row as Record<string, unknown>) : null;
  }

  disableHubSkill(skillId: string): HubSkill | null {
    this.db.prepare("UPDATE hub_skills SET status = 'disabled', updated_at = ? WHERE skill_id = ?").run(new Date().toISOString(), skillId);
    return this.getHubSkill(skillId);
  }

  deleteHubSkill(skillId: string): { deleted: boolean; path: string | null } {
    const skill = this.getHubSkill(skillId);
    if (!skill) {
      return { deleted: false, path: null };
    }
    this.db.prepare("DELETE FROM hub_skills WHERE skill_id = ?").run(skillId);
    return { deleted: true, path: skill.path };
  }

  putSkillCandidate(candidate: Omit<SkillCandidate, "createdAt" | "promotedAt" | "status" | "targetPath"> & Partial<Pick<SkillCandidate, "createdAt" | "status" | "targetPath" | "promotedAt">>): SkillCandidate {
    const complete: SkillCandidate = {
      ...candidate,
      status: candidate.status ?? "pending",
      targetPath: candidate.targetPath ?? null,
      createdAt: candidate.createdAt ?? new Date().toISOString(),
      promotedAt: candidate.promotedAt ?? null
    };
    this.db.prepare(`
      INSERT INTO skill_candidates(
        candidate_id, scope, type, title, lesson, evidence_json, reuse_rule, redaction_status,
        promotion_target, project_root, status, target_path, created_at, promoted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(candidate_id) DO UPDATE SET
        scope=excluded.scope, type=excluded.type, title=excluded.title, lesson=excluded.lesson,
        evidence_json=excluded.evidence_json, reuse_rule=excluded.reuse_rule,
        redaction_status=excluded.redaction_status, promotion_target=excluded.promotion_target,
        project_root=excluded.project_root, status=excluded.status, target_path=excluded.target_path,
        promoted_at=excluded.promoted_at
    `).run(
      complete.candidateId,
      complete.scope,
      complete.type,
      complete.title,
      complete.lesson,
      JSON.stringify(complete.evidence),
      complete.reuseRule,
      complete.redactionStatus,
      complete.promotionTarget,
      complete.projectRoot,
      complete.status,
      complete.targetPath,
      complete.createdAt,
      complete.promotedAt
    );
    return complete;
  }

  getSkillCandidate(candidateId: string): SkillCandidate | null {
    const row = this.db.prepare("SELECT * FROM skill_candidates WHERE candidate_id = ?").get(candidateId);
    return row ? mapSkillCandidate(row as Record<string, unknown>) : null;
  }

  listSkillCandidates(status?: string): SkillCandidate[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM skill_candidates WHERE status = ? ORDER BY created_at DESC").all(status)
      : this.db.prepare("SELECT * FROM skill_candidates ORDER BY created_at DESC").all();
    return (rows as Array<Record<string, unknown>>).map(mapSkillCandidate);
  }

  private isSessionDeleted(sessionId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM deleted_sessions WHERE session_id = ?").get(sessionId));
  }

  private getSessionListMetadata(sessionId: string): Pick<SessionListItem, "title" | "textBytes"> {
    const titleRow = this.db.prepare(`
      SELECT searchable_text FROM events
      WHERE session_id = ? AND role = 'user' AND trim(searchable_text) <> ''
      ORDER BY line_number ASC, id ASC LIMIT 1
    `).get(sessionId) as { searchable_text: string } | undefined;
    const sizeRow = this.db.prepare("SELECT COALESCE(SUM(length(searchable_text)), 0) AS text_bytes FROM events WHERE session_id = ?").get(sessionId) as { text_bytes: number };
    return {
      title: summarizeTitle(titleRow?.searchable_text) ?? sessionId,
      textBytes: Number(sizeRow.text_bytes)
    };
  }
}

function summarizeTitle(value: string | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 48) : null;
}

function mapManifest(row: Record<string, unknown>): SessionManifest {
  return {
    sessionId: String(row.session_id),
    sourceSessionId: row.source_session_id ? String(row.source_session_id) : null,
    client: String(row.client) as SessionManifest["client"],
    sourcePath: String(row.source_path),
    project: row.project ? String(row.project) : null,
    fileSha256: String(row.file_sha256),
    eventCount: Number(row.event_count),
    firstTimestamp: row.first_timestamp ? String(row.first_timestamp) : null,
    lastTimestamp: row.last_timestamp ? String(row.last_timestamp) : null,
    ingestedAt: String(row.ingested_at)
  };
}

function mapEvent(row: Record<string, unknown>, includeRaw: boolean): StoredEvent {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    client: String(row.client) as StoredEvent["client"],
    sourcePath: String(row.source_path),
    lineNumber: Number(row.line_number),
    timestamp: row.timestamp ? String(row.timestamp) : null,
    role: row.role ? String(row.role) : null,
    eventType: String(row.event_type),
    searchableText: includeRaw ? String(row.searchable_text) : redactSensitive(String(row.searchable_text)),
    rawJson: includeRaw ? String(row.raw_json) : "[RAW CONTENT REQUIRES EXPLICIT SENSITIVE READ]",
    rawSha256: String(row.raw_sha256),
    sensitive: Boolean(row.sensitive)
  };
}

function mapMemorySync(row: Record<string, unknown>): MemorySyncRecord {
  return {
    sessionId: String(row.session_id),
    fileSha256: String(row.file_sha256),
    status: String(row.status) as MemorySyncRecord["status"],
    syncedAt: row.synced_at ? String(row.synced_at) : null,
    error: row.error ? String(row.error) : null
  };
}

function mapMemoryItem(row: Record<string, unknown>): MemoryItem {
  return {
    memoryId: String(row.memory_id),
    type: String(row.type) as MemoryItem["type"],
    scope: String(row.scope) as MemoryItem["scope"],
    projectRoot: row.project_root ? String(row.project_root) : null,
    sessionId: row.session_id ? String(row.session_id) : null,
    sourceAnchor: row.source_anchor ? String(row.source_anchor) : null,
    title: String(row.title),
    summary: String(row.summary),
    tags: parseJsonArray(row.tags_json),
    status: String(row.status) as MemoryItem["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapHubSkill(row: Record<string, unknown>): HubSkill {
  return {
    skillId: String(row.skill_id),
    scope: String(row.scope) as HubSkill["scope"],
    title: String(row.title),
    slug: String(row.slug),
    projectRoot: row.project_root ? String(row.project_root) : null,
    projectHash: row.project_hash ? String(row.project_hash) : null,
    path: String(row.path),
    reuseRule: String(row.reuse_rule),
    status: String(row.status) as HubSkill["status"],
    sourceCandidateId: row.source_candidate_id ? String(row.source_candidate_id) : null,
    sourceSessionId: row.source_session_id ? String(row.source_session_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null
  };
}

function mapSkillCandidate(row: Record<string, unknown>): SkillCandidate {
  return {
    candidateId: String(row.candidate_id),
    scope: String(row.scope) as SkillCandidate["scope"],
    type: String(row.type) as SkillCandidate["type"],
    title: String(row.title),
    lesson: String(row.lesson),
    evidence: JSON.parse(String(row.evidence_json)) as string[],
    reuseRule: String(row.reuse_rule),
    redactionStatus: String(row.redaction_status) as SkillCandidate["redactionStatus"],
    promotionTarget: String(row.promotion_target) as SkillCandidate["promotionTarget"],
    projectRoot: row.project_root ? String(row.project_root) : null,
    status: String(row.status) as SkillCandidate["status"],
    targetPath: row.target_path ? String(row.target_path) : null,
    createdAt: String(row.created_at),
    promotedAt: row.promoted_at ? String(row.promoted_at) : null
  };
}

function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
