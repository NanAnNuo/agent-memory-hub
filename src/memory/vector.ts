import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryItem } from "../archive/types.js";

export interface VectorRecord {
  memory_id: string;
  title: string;
  summary: string;
  scope: string;
  project_root: string | null;
  vector: number[];
  updated_at: string;
}

export async function upsertMemoryVector(lanceDbDir: string, item: MemoryItem, embedding: number[]): Promise<void> {
  const lancedb = await import("@lancedb/lancedb");
  const db = await lancedb.connect(lanceDbDir);
  const record = toRecord(item, embedding);
  const table = await openOrCreateTable(db as unknown as LanceConnection, record);
  await table.delete(`memory_id = '${escapeSql(item.memoryId)}'`);
  await table.add([record]);
}

export async function hasVectorIndex(lanceDbDir: string): Promise<boolean> {
  return existsSync(join(lanceDbDir, "memory_vectors.lance"));
}

interface LanceConnection {
  openTable(name: string): Promise<unknown>;
  createTable(name: string, data: VectorRecord[]): Promise<unknown>;
}

async function openOrCreateTable(db: LanceConnection, record: VectorRecord) {
  try {
    return await db.openTable("memory_vectors") as { add(data: VectorRecord[]): Promise<void>; delete(filter: string): Promise<void> };
  } catch {
    return await db.createTable("memory_vectors", [record]) as { add(data: VectorRecord[]): Promise<void>; delete(filter: string): Promise<void> };
  }
}

function toRecord(item: MemoryItem, embedding: number[]): VectorRecord {
  return {
    memory_id: item.memoryId,
    title: item.title,
    summary: item.summary,
    scope: item.scope,
    project_root: item.projectRoot,
    vector: embedding,
    updated_at: item.updatedAt
  };
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}
