export type AgentKind = "codex" | "claude" | "opencode";
export type TaskStatus = "created" | "running" | "completed" | "failed";

export interface AgentTask {
  taskId: string;
  parentTaskId: string | null;
  title: string;
  prompt: string;
  agent: AgentKind;
  modelProfile: string;
  repoPath: string | null;
  workingDirectory: string | null;
  requiresWrite: boolean;
  status: TaskStatus;
  worktree: string | null;
  branch: string | null;
  artifacts: string[];
  sourceRanges: string[];
  verification: string[];
  createdAt: string;
  updatedAt: string;
  exitCode: number | null;
  outputLog: string | null;
}

export interface CommandPreview {
  executable: string;
  args: string[];
  cwd: string;
  worktreeRequired: boolean;
}
