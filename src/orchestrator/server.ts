import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureHubDirectories, getHubPaths, loadModelProfiles } from "../shared/config.js";
import { createTask, dispatchTask, previewCommand, resolveTaskWorkingDirectory } from "./executor.js";
import { OrchestratorStore } from "./store.js";

const agentSchema = z.enum(["codex", "claude", "opencode"]).describe("The recipient that will execute the task, not the client requesting it. Use codex when sending work to Codex.");

export function createOrchestratorServer(dataDir?: string): McpServer {
  const paths = getHubPaths(dataDir);
  ensureHubDirectories(paths);
  const profiles = loadModelProfiles();
  const store = new OrchestratorStore(paths);
  const server = new McpServer({ name: "agent-orchestrator-mcp-server", version: "0.1.0" });

  server.registerTool("orchestrator_create_task", {
    title: "Create Delegated Agent Task",
    description: "Create a cross-agent work item without executing it. The agent field is the recipient: a request to send work to Codex must use agent='codex' with a codex_* model_profile, even when OpenCode is creating the task. Write tasks require a Git repository for later isolated worktree execution.",
    inputSchema: {
      parent_task_id: z.string().optional(),
      title: z.string().min(1).max(200),
      prompt: z.string().min(1),
      agent: agentSchema,
      model_profile: z.string().min(1).describe("A model profile for the recipient agent, for example codex_light_research for Codex verification."),
      repo_path: z.string().optional(),
      working_directory: z.string().optional(),
      requires_write: z.boolean().default(false),
      source_ranges: z.array(z.string()).default([])
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ parent_task_id, title, prompt, agent, model_profile, repo_path, working_directory, requires_write, source_ranges }) => {
    const profile = profiles[model_profile];
    if (!profile || profile.agent !== agent) {
      throw new Error(`Model profile ${model_profile} does not exist or does not target ${agent}.`);
    }
    const task = createTask({
      parentTaskId: parent_task_id ?? null,
      title,
      prompt,
      agent,
      modelProfile: model_profile,
      repoPath: repo_path ?? null,
      workingDirectory: working_directory ?? null,
      requiresWrite: requires_write,
      sourceRanges: source_ranges
    });
    return result(store.put(task));
  });

  server.registerTool("orchestrator_preview_dispatch", {
    title: "Preview Delegated Command",
    description: "Preview the process invocation selected for a created task; does not launch any agent.",
    inputSchema: { task_id: z.string().uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ task_id }) => {
    const task = requiredTask(store, task_id);
    const profile = profiles[task.modelProfile];
    const cwd = resolveTaskWorkingDirectory(task);
    return result(previewCommand(task, profile, cwd));
  });

  server.registerTool("orchestrator_dispatch_task", {
    title: "Execute Delegated Agent Task",
    description: "Launch the selected external agent. Write tasks create an isolated Git worktree first. Requires execute=true.",
    inputSchema: { task_id: z.string().uuid(), execute: z.literal(true) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ task_id }) => {
    const task = requiredTask(store, task_id);
    if (task.status !== "created") {
      throw new Error(`Only created tasks can be dispatched; task is ${task.status}.`);
    }
    task.status = "running";
    task.updatedAt = new Date().toISOString();
    store.put(task);
    void dispatchTask(task, profiles[task.modelProfile], paths)
      .then((updated) => store.put(updated))
      .catch((error: unknown) => {
        task.status = "failed";
        task.exitCode = 1;
        task.verification.push(error instanceof Error ? error.message : String(error));
        task.updatedAt = new Date().toISOString();
        store.put(task);
      });
    return result(task);
  });

  server.registerTool("orchestrator_get_task", {
    title: "Get Delegated Task",
    description: "Return delegated task state, worktree and verification metadata.",
    inputSchema: { task_id: z.string().uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ task_id }) => result(requiredTask(store, task_id)));

  server.registerTool("orchestrator_list_tasks", {
    title: "List Delegated Tasks",
    description: "List created or executed delegated tasks.",
    inputSchema: { status: z.enum(["created", "running", "completed", "failed"]).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ status }) => result(store.list(status)));

  server.registerTool("orchestrator_record_verification", {
    title: "Record Task Verification",
    description: "Append controller verification evidence or artifact paths to a delegated task.",
    inputSchema: {
      task_id: z.string().uuid(),
      verification: z.string().min(1),
      artifacts: z.array(z.string()).default([])
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ task_id, verification, artifacts }) => {
    const task = requiredTask(store, task_id);
    task.verification.push(verification);
    task.artifacts.push(...artifacts);
    task.updatedAt = new Date().toISOString();
    return result(store.put(task));
  });

  return server;
}

function requiredTask(store: OrchestratorStore, taskId: string) {
  const task = store.get(taskId);
  if (!task) {
    throw new Error(`Unknown orchestrated task: ${taskId}`);
  }
  return task;
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
