import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { HubPaths } from "../shared/config.js";
import type { ArchiveStore } from "./store.js";

export interface BackupResult {
  path: string;
  database: string;
  skills: string;
  createdAt: string;
}

export interface RestoreResult {
  staged: boolean;
  restartRequired: boolean;
  source: string;
  marker: string;
}

const markerName = "restore-pending.json";

export async function createBackup(store: ArchiveStore, paths: HubPaths, outputDir?: string): Promise<BackupResult> {
  const createdAt = new Date().toISOString();
  const backupRoot = outputDir || join(paths.dataDir, "backups", safeStamp(createdAt));
  mkdirSync(backupRoot, { recursive: true });
  const database = join(backupRoot, "archive.db");
  const skills = join(backupRoot, "skills");
  await store.backupDatabase(database);
  if (existsSync(paths.skillsDir)) {
    cpSync(paths.skillsDir, skills, { recursive: true, force: true });
  } else {
    mkdirSync(skills, { recursive: true });
  }
  writeFileSync(join(backupRoot, "manifest.json"), JSON.stringify({
    app: "Agent Memory Hub",
    version: 1,
    createdAt,
    database: basename(database),
    skills: basename(skills)
  }, null, 2), "utf8");
  return { path: backupRoot, database, skills, createdAt };
}

export function stageRestore(paths: HubPaths, backupRoot: string): RestoreResult {
  const database = join(backupRoot, "archive.db");
  const skills = join(backupRoot, "skills");
  if (!existsSync(database)) {
    throw new Error(`Backup database not found: ${database}`);
  }
  if (!existsSync(skills)) {
    throw new Error(`Backup skills directory not found: ${skills}`);
  }
  const marker = join(paths.dataDir, markerName);
  writeFileSync(marker, JSON.stringify({ source: backupRoot, stagedAt: new Date().toISOString() }, null, 2), "utf8");
  return { staged: true, restartRequired: true, source: backupRoot, marker };
}

export function applyPendingRestore(paths: HubPaths): boolean {
  const marker = join(paths.dataDir, markerName);
  if (!existsSync(marker)) {
    return false;
  }
  const pending = JSON.parse(readFileSync(marker, "utf8")) as { source?: string };
  if (!pending.source) {
    rmSync(marker, { force: true });
    return false;
  }
  const database = join(pending.source, "archive.db");
  const skills = join(pending.source, "skills");
  if (!existsSync(database) || !existsSync(skills)) {
    throw new Error(`Pending restore is invalid: ${pending.source}`);
  }
  rmSync(`${paths.archiveDatabase}-wal`, { force: true });
  rmSync(`${paths.archiveDatabase}-shm`, { force: true });
  cpSync(database, paths.archiveDatabase, { force: true });
  rmSync(paths.skillsDir, { recursive: true, force: true });
  cpSync(skills, paths.skillsDir, { recursive: true, force: true });
  rmSync(marker, { force: true });
  return true;
}

function safeStamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}
