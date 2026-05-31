import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { getPackageRoot, type HubPaths, type ModelProfile } from "../shared/config.js";
import { redactSensitive } from "../shared/redact.js";
import type { AgentTask, CommandPreview } from "./types.js";

const execFileAsync = promisify(execFile);

export function createTask(input: Omit<AgentTask, "taskId" | "status" | "worktree" | "branch" | "artifacts" | "verification" | "createdAt" | "updatedAt" | "exitCode" | "outputLog">): AgentTask {
  const timestamp = new Date().toISOString();
  return {
    ...input,
    taskId: randomUUID(),
    status: "created",
    worktree: null,
    branch: null,
    artifacts: [],
    verification: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    exitCode: null,
    outputLog: null
  };
}

export function previewCommand(task: AgentTask, profile: ModelProfile, cwd: string): CommandPreview {
  const prompt = task.prompt;
  switch (task.agent) {
    case "codex":
      return {
        executable: process.env.AGENT_HUB_CODEX_BIN ?? "codex",
        args: ["exec", "--json", ...(profile.model ? ["-m", profile.model] : []), "-C", cwd, prompt],
        cwd,
        worktreeRequired: task.requiresWrite
      };
    case "claude":
      return {
        executable: process.env.AGENT_HUB_CLAUDE_BIN ?? "C:\\Users\\22289\\AppData\\Local\\Claude-3p\\claude-code\\2.1.142\\claude.exe",
        args: ["--print", "--output-format", "json", ...(profile.model ? ["--model", profile.model] : []), prompt],
        cwd,
        worktreeRequired: task.requiresWrite
      };
    case "opencode":
      return {
        executable: resolveOpenCodeExecutable(),
        args: ["run", "--format", "json", "--dir", cwd, prompt],
        cwd,
        worktreeRequired: task.requiresWrite
      };
  }
}

export function resolveTaskWorkingDirectory(task: Pick<AgentTask, "workingDirectory" | "repoPath">): string {
  return task.workingDirectory ?? task.repoPath ?? getPackageRoot();
}

export function buildChildEnvironment(agent: AgentTask["agent"], environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment };
  if (agent === "opencode") {
    for (const key of Object.keys(childEnvironment)) {
      if (key.startsWith("OPENCODE_")) {
        delete childEnvironment[key];
      }
    }
  }
  if (agent === "codex") {
    delete childEnvironment.CODEX_THREAD_ID;
  }
  return childEnvironment;
}

function resolveOpenCodeExecutable(): string {
  if (process.env.AGENT_HUB_OPENCODE_BIN) {
    return process.env.AGENT_HUB_OPENCODE_BIN;
  }
  const npmInstalled = join(homedir(), "AppData", "Roaming", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
  return existsSync(npmInstalled) ? npmInstalled : "opencode";
}

export async function dispatchTask(task: AgentTask, profile: ModelProfile, paths: HubPaths): Promise<AgentTask> {
  let cwd = resolveTaskWorkingDirectory(task);
  if (task.requiresWrite) {
    if (!task.repoPath) {
      throw new Error("A write-capable delegated task requires repo_path so it can run in an isolated worktree.");
    }
    const prepared = await prepareWorktree(task, paths);
    cwd = prepared.worktree;
    task.worktree = prepared.worktree;
    task.branch = prepared.branch;
  }
  const command = previewCommand(task, profile, cwd);
  task.status = "running";
  task.updatedAt = new Date().toISOString();
  const logPath = join(paths.taskLogsDir, `${task.taskId}.json`);
  task.outputLog = logPath;
  try {
    const result = await runAgentProcess(command, task.agent);
    writeFileSync(logPath, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2), "utf8");
    task.artifacts.push(logPath);
    task.status = "completed";
    task.exitCode = 0;
    task.verification.push(redactSensitive(result.stdout).slice(0, 2000));
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };
    writeFileSync(logPath, JSON.stringify({ stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", error: failure.message ?? "Dispatch failed" }, null, 2), "utf8");
    task.artifacts.push(logPath);
    task.status = "failed";
    task.exitCode = typeof failure.code === "number" ? failure.code : 1;
    const diagnostic = [failure.stderr, failure.stdout, failure.message].filter((value) => Boolean(value)).join("\n");
    task.verification.push(redactSensitive(diagnostic || "Dispatch failed without diagnostic output.").slice(0, 2000));
  }
  task.updatedAt = new Date().toISOString();
  return task;
}

function runAgentProcess(command: CommandPreview, agent: AgentTask["agent"]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: buildChildEnvironment(agent),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      rejectProcess({ stdout, stderr, code: 124, message: "Delegated agent timed out." });
    }, Number(process.env.AGENT_HUB_DISPATCH_TIMEOUT_MS ?? "900000"));
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectProcess({ stdout, stderr, code: 1, message: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolveProcess({ stdout, stderr });
      } else {
        rejectProcess({ stdout, stderr, code: code ?? 1, message: `Delegated agent exited with code ${code ?? 1}.` });
      }
    });
  });
}

async function prepareWorktree(task: AgentTask, paths: HubPaths): Promise<{ worktree: string; branch: string }> {
  const repoPath = resolve(task.repoPath!);
  if (!existsSync(join(repoPath, ".git"))) {
    throw new Error(`Delegated write task repo_path is not a Git repository: ${repoPath}`);
  }
  const branch = `codex/agent-${task.taskId.slice(0, 8)}`;
  const worktree = join(paths.worktreesDir, task.taskId);
  await execFileAsync("git", ["-C", repoPath, "worktree", "add", "-b", branch, worktree, "HEAD"], { windowsHide: true });
  return { branch, worktree };
}
