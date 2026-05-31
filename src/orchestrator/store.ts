import Database from "better-sqlite3";
import type { HubPaths } from "../shared/config.js";
import type { AgentTask, TaskStatus } from "./types.js";

type DatabaseType = InstanceType<typeof Database>;

export class OrchestratorStore {
  private readonly db: DatabaseType;

  constructor(paths: HubPaths) {
    this.db = new Database(paths.orchestratorDatabase);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        task_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  put(task: AgentTask): AgentTask {
    this.db.prepare(`
      INSERT INTO tasks(task_id, task_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET task_json=excluded.task_json, status=excluded.status, updated_at=excluded.updated_at
    `).run(task.taskId, JSON.stringify(task), task.status, task.createdAt, task.updatedAt);
    return task;
  }

  get(taskId: string): AgentTask | null {
    const row = this.db.prepare("SELECT task_json FROM tasks WHERE task_id = ?").get(taskId) as { task_json: string } | undefined;
    return row ? JSON.parse(row.task_json) as AgentTask : null;
  }

  list(status?: TaskStatus): AgentTask[] {
    const rows = status
      ? this.db.prepare("SELECT task_json FROM tasks WHERE status = ? ORDER BY created_at DESC").all(status)
      : this.db.prepare("SELECT task_json FROM tasks ORDER BY created_at DESC").all();
    return (rows as Array<{ task_json: string }>).map((row) => JSON.parse(row.task_json) as AgentTask);
  }
}
