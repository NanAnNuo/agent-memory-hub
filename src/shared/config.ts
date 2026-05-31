import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ModelProfile {
  agent: "codex" | "claude" | "opencode";
  model?: string;
  role: string;
  contextWindowTokens: number;
  historicalTextRatio: number;
}

export interface HubPaths {
  dataDir: string;
  archiveDatabase: string;
  orchestratorDatabase: string;
  lanceDbDir: string;
  skillsDir: string;
  worktreesDir: string;
  taskLogsDir: string;
  exportsDir: string;
  auditLog: string;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function getPackageRoot(): string {
  return packageRoot;
}

export function getHubPaths(dataDir = process.env.AGENT_HUB_DATA_DIR ?? join(homedir(), ".memory-hub")): HubPaths {
  return {
    dataDir,
    archiveDatabase: join(dataDir, "archive.db"),
    orchestratorDatabase: join(dataDir, "orchestrator.db"),
    lanceDbDir: process.env.AGENT_HUB_LANCEDB_DIR ?? join(dataDir, "lancedb"),
    skillsDir: process.env.AGENT_HUB_SKILLS_DIR ?? join(dataDir, "skills"),
    worktreesDir: join(dataDir, "worktrees"),
    taskLogsDir: join(dataDir, "task-logs"),
    exportsDir: join(dataDir, "exports"),
    auditLog: join(dataDir, "audit.jsonl")
  };
}

export function ensureHubDirectories(paths: HubPaths): void {
  for (const path of [paths.dataDir, paths.lanceDbDir, paths.skillsDir, paths.worktreesDir, paths.taskLogsDir, paths.exportsDir]) {
    mkdirSync(path, { recursive: true });
  }
}

export function loadModelProfiles(path = process.env.AGENT_HUB_MODEL_PROFILES ?? join(packageRoot, "config", "model-profiles.json")): Record<string, ModelProfile> {
  if (!existsSync(path)) {
    throw new Error(`Model profile configuration does not exist: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { profiles?: Record<string, ModelProfile> };
  if (!parsed.profiles) {
    throw new Error(`Model profile configuration is missing the profiles object: ${path}`);
  }
  return parsed.profiles;
}

export function getAllowedTranscriptRoots(): string[] {
  const defaults = process.env.AGENT_HUB_INCLUDE_DEFAULT_TRANSCRIPT_ROOTS === "false"
    ? []
    : [
      join(homedir(), ".codex", "sessions"),
      join(homedir(), ".claude", "projects")
    ];
  const configured = (process.env.AGENT_HUB_TRANSCRIPT_ROOTS ?? "")
    .split(";")
    .map((path) => path.trim())
    .filter(Boolean);
  return [...defaults, ...configured].map((path) => resolve(path));
}

export function getAllowedOpenCodeDatabases(): string[] {
  const defaults = [join(homedir(), ".local", "share", "opencode", "opencode.db")];
  const configured = (process.env.AGENT_HUB_OPENCODE_DATABASES ?? "")
    .split(";")
    .map((path) => path.trim())
    .filter(Boolean);
  return [...defaults, ...configured].map((path) => resolve(path));
}

export function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}
