export type ClientKind = "codex" | "claude" | "opencode";

export interface ImportedSession {
  sessionId: string;
  sourceSessionId: string | null;
  client: ClientKind;
  sourcePath: string;
  project: string | null;
  fileSha256: string;
  events: ImportedEvent[];
}

export interface ImportedEvent {
  lineNumber: number;
  timestamp: string | null;
  role: string | null;
  eventType: string;
  searchableText: string;
  rawJson: string;
  rawSha256: string;
  sensitive: boolean;
}

export interface StoredEvent extends ImportedEvent {
  id: number;
  sessionId: string;
  client: ClientKind;
  sourcePath: string;
}

export interface SessionManifest {
  sessionId: string;
  sourceSessionId: string | null;
  client: ClientKind;
  sourcePath: string;
  project: string | null;
  fileSha256: string;
  eventCount: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  ingestedAt: string;
}

export interface SessionListItem extends SessionManifest {
  title: string;
  textBytes: number;
}

export interface SourceRange {
  sessionId: string;
  offset: number;
  limit: number;
}

export interface ContextBundle {
  modelProfile: string;
  tokenBudget: number;
  usedTokens: number;
  redacted: true;
  excerpts: Array<{
    eventId: number;
    sourceAnchor: string;
    text: string;
    estimatedTokens: number;
  }>;
  truncated: boolean;
  nextRanges: SourceRange[];
}

export interface TaskCheckpoint {
  taskId: string;
  sourceRanges: SourceRange[];
  files: string[];
  commands: string[];
  tests: string[];
  decisions: string[];
  pending: string[];
  updatedAt: string;
}

export interface MemorySyncRecord {
  sessionId: string;
  fileSha256: string;
  status: "synced" | "failed";
  syncedAt: string | null;
  error: string | null;
}

export interface MemoryItem {
  memoryId: string;
  type: "case" | "skill_hint" | "profile";
  scope: "global" | "project";
  projectRoot: string | null;
  sessionId: string | null;
  sourceAnchor: string | null;
  title: string;
  summary: string;
  tags: string[];
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface HubSkill {
  skillId: string;
  scope: "global" | "project";
  title: string;
  slug: string;
  projectRoot: string | null;
  projectHash: string | null;
  path: string;
  reuseRule: string;
  status: "active" | "disabled";
  sourceCandidateId: string | null;
  sourceSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface HubSettings {
  llmProvider: string;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingApiKey: string;
  profileMemoryEnabled: boolean;
  backgroundSyncEnabled: boolean;
  manualModelEntry: boolean;
  autoTaggingEnabled: boolean;
  duplicateCleanerEnabled: boolean;
  retentionReminderEnabled: boolean;
  contextPackEnabled: boolean;
  healthCheckEnabled: boolean;
}

export interface SkillCandidate {
  candidateId: string;
  scope: "global" | "project";
  type: "pitfall" | "workflow" | "preference" | "tooling" | "debug-pattern";
  title: string;
  lesson: string;
  evidence: string[];
  reuseRule: string;
  redactionStatus: "redacted" | "needs-human-review";
  promotionTarget: "memory" | "skill" | "project-rule" | "discard";
  projectRoot: string | null;
  status: "pending" | "promoted" | "discarded";
  targetPath: string | null;
  createdAt: string;
  promotedAt: string | null;
}
