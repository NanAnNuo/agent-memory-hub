import { describe, expect, it } from "vitest";
import { getPackageRoot } from "../src/shared/config.js";
import { buildChildEnvironment, createTask, previewCommand, resolveTaskWorkingDirectory } from "../src/orchestrator/executor.js";

describe("agent dispatch routing", () => {
  it("builds Codex mini research invocations from the selected model profile", () => {
    const task = createTask({
      parentTaskId: null,
      title: "inspect",
      prompt: "inspect safely",
      agent: "codex",
      modelProfile: "codex_light_research",
      repoPath: null,
      workingDirectory: "D:\\work",
      requiresWrite: false,
      sourceRanges: []
    });
    const command = previewCommand(task, {
      agent: "codex",
      model: "gpt-5.4-mini",
      role: "research",
      contextWindowTokens: 128000,
      historicalTextRatio: 0.6
    }, "D:\\work");
    expect(command.args).toContain("gpt-5.4-mini");
    expect(command.args).toContain("-C");
  });

  it("uses the installed OpenCode CLI location when available", () => {
    const task = createTask({
      parentTaskId: null,
      title: "collaborate",
      prompt: "review",
      agent: "opencode",
      modelProfile: "opencode_collaborator",
      repoPath: null,
      workingDirectory: "D:\\work",
      requiresWrite: false,
      sourceRanges: []
    });
    const command = previewCommand(task, {
      agent: "opencode",
      role: "collaborator",
      contextWindowTokens: 100000,
      historicalTextRatio: 0.6
    }, "D:\\work");
    expect(command.args.slice(0, 5)).toEqual(["run", "--format", "json", "--dir", "D:\\work"]);
    expect(command.executable.toLowerCase()).toContain("opencode");
  });

  it("defaults directory-less tasks to the hub package root", () => {
    expect(resolveTaskWorkingDirectory({ repoPath: null, workingDirectory: null })).toBe(getPackageRoot());
    expect(resolveTaskWorkingDirectory({ repoPath: "D:\\repo", workingDirectory: "D:\\requested" })).toBe("D:\\requested");
  });

  it("removes parent client session bindings from delegated child environments", () => {
    expect(buildChildEnvironment("opencode", { OPENCODE_SESSION_ID: "parent", SAFE: "kept" })).toEqual({ SAFE: "kept" });
    expect(buildChildEnvironment("codex", { CODEX_THREAD_ID: "parent", CODEX_HOME: "home" })).toEqual({ CODEX_HOME: "home" });
  });
});
