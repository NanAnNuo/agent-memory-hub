import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getHubPaths, ensureHubDirectories } from "../src/shared/config.js";
import { importJsonlFile } from "../src/archive/importers.js";
import { ArchiveStore } from "../src/archive/store.js";
import { exportSession } from "../src/archive/export.js";
import { applyPendingRestore, createBackup, stageRestore } from "../src/archive/backup.js";
import { promoteSkillCandidate } from "../src/skills/promotion.js";
import { buildMemoryFromSession, prunePendingSkillCandidates, searchLocalMemory } from "../src/memory/local.js";

afterEach(() => {
  delete process.env.AGENT_HUB_SKILLS_DIR;
});

function setupStore() {
  const root = mkdtempSync(join(tmpdir(), "agent-memory-hub-"));
  const sourceRoot = join(root, "source");
  mkdirSync(sourceRoot, { recursive: true });
  const paths = getHubPaths(join(root, "data"));
  ensureHubDirectories(paths);
  return { root, sourceRoot, paths, store: new ArchiveStore(paths) };
}

describe("Local memory, export, and skill promotion", () => {
  it("builds searchable local memory from an archived session", async () => {
    const { sourceRoot, store } = setupStore();
    const source = join(sourceRoot, "session.jsonl");
    writeFileSync(source, [
      JSON.stringify({ type: "system", sessionId: "s-1", timestamp: "2026-05-25T00:00:00Z", content: "internal startup rule" }),
      JSON.stringify({ type: "user", sessionId: "s-1", timestamp: "2026-05-25T00:00:00Z", message: { role: "user", content: "remember this workflow because it is a reusable debugging rule for future dashboard fixes" } }),
      JSON.stringify({ type: "assistant", sessionId: "s-1", timestamp: "2026-05-25T00:00:00Z", message: { role: "assistant", content: "[call shell_command]" } }),
      JSON.stringify({ type: "assistant", sessionId: "s-1", timestamp: "2026-05-25T00:00:01Z", message: { role: "assistant", content: "done" } })
    ].join("\n"), "utf8");
    const imported = importJsonlFile("codex", source, sourceRoot);
    store.ingestSession(imported);

    await buildMemoryFromSession(store, imported.sessionId);
    const result = searchLocalMemory(store, "workflow", undefined, ["case"], 5);
    expect(result.cases[0]).toMatchObject({ sessionId: imported.sessionId, type: "case" });
    expect(store.listSkillCandidates("pending").map((candidate) => candidate.candidateId)).toContain(`auto-${imported.sessionId}`);
    store.close();
  });

  it("does not create skill candidates for low-value prompt or policy noise", async () => {
    const { sourceRoot, store } = setupStore();
    const source = join(sourceRoot, "noise.jsonl");
    writeFileSync(source, [
      JSON.stringify({ type: "user", sessionId: "noise-session", timestamp: "2026-05-25T00:00:00Z", message: { role: "user", content: "# AGENTS.md instructions for D:\\repo\n<INSTRUCTIONS>\n核心通信法则\nDefault startup rule" } }),
      JSON.stringify({ type: "assistant", sessionId: "noise-session", timestamp: "2026-05-25T00:00:01Z", message: { role: "assistant", content: "acknowledged" } })
    ].join("\n"), "utf8");
    const imported = importJsonlFile("codex", source, sourceRoot);
    store.ingestSession(imported);

    const result = await buildMemoryFromSession(store, imported.sessionId);
    expect(result.candidateCreated).toBe(false);
    expect(store.listSkillCandidates("pending").map((candidate) => candidate.candidateId)).not.toContain(`auto-${imported.sessionId}`);
    store.close();
  });

  it("backs up and stages restore for archive database and Hub skills", async () => {
    const { sourceRoot, paths, store } = setupStore();
    const source = join(sourceRoot, "backup.jsonl");
    writeFileSync(source, JSON.stringify({ type: "user", sessionId: "backup-session", message: { role: "user", content: "backup this workflow" } }), "utf8");
    const imported = importJsonlFile("codex", source, sourceRoot);
    store.ingestSession(imported);
    const backup = await createBackup(store, paths);
    expect(existsSync(join(backup.path, "archive.db"))).toBe(true);
    expect(existsSync(join(backup.path, "skills"))).toBe(true);
    const staged = stageRestore(paths, backup.path);
    expect(staged.restartRequired).toBe(true);
    store.close();
    expect(applyPendingRestore(paths)).toBe(true);
  });

  it("exports redacted Markdown and JSON without raw sensitive payloads", () => {
    const { sourceRoot, paths, store } = setupStore();
    const source = join(sourceRoot, "secret.jsonl");
    writeFileSync(source, JSON.stringify({
      type: "user",
      sessionId: "s-2",
      message: { role: "user", content: "token api_key=secretabcdefghijk" }
    }), "utf8");
    const imported = importJsonlFile("claude", source, sourceRoot);
    store.ingestSession(imported);

    const markdown = exportSession(store, paths, imported.sessionId, "markdown");
    const jsonExport = exportSession(store, paths, imported.sessionId, "json");
    expect(markdown.content).toContain("[REDACTED]");
    expect(jsonExport.content).toContain("[REDACTED]");
    expect(markdown.content).not.toContain("secretabcdefghijk");
    expect(jsonExport.content).not.toContain("secretabcdefghijk");
    store.close();
  });

  it("exports only readable user and assistant conversation messages", () => {
    const { sourceRoot, paths, store } = setupStore();
    const source = join(sourceRoot, "readable.jsonl");
    writeFileSync(source, [
      JSON.stringify({ type: "developer", sessionId: "s-3", content: "internal implementation rule" }),
      JSON.stringify({ type: "user", sessionId: "s-3", message: { role: "user", content: "please explain the fix" } }),
      JSON.stringify({ type: "assistant", sessionId: "s-3", message: { role: "assistant", content: "[tool call details]" } }),
      JSON.stringify({ type: "assistant", sessionId: "s-3", message: { role: "assistant", content: "the fix is ready" } })
    ].join("\n"), "utf8");
    const imported = importJsonlFile("codex", source, sourceRoot);
    store.ingestSession(imported);

    const markdown = exportSession(store, paths, imported.sessionId, "markdown");
    const jsonExport = exportSession(store, paths, imported.sessionId, "json");
    const parsed = JSON.parse(jsonExport.content) as { readableEvents: number; events: Array<{ role: string; text: string }> };

    expect(markdown.content).toContain("please explain the fix");
    expect(markdown.content).toContain("the fix is ready");
    expect(markdown.content).not.toContain("internal implementation rule");
    expect(markdown.content).not.toContain("[tool call details]");
    expect(parsed.readableEvents).toBe(2);
    expect(parsed.events.map((event) => event.role)).toEqual(["user", "assistant"]);
    store.close();
  });

  it("promotes global and project skills only into the Hub skill directory", () => {
    const { root, paths, store } = setupStore();
    const hubSkillsRoot = paths.skillsDir;
    process.env.AGENT_HUB_SKILLS_DIR = hubSkillsRoot;
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot, { recursive: true });
    const globalId = "global-candidate";
    const projectId = "project-candidate";
    store.putSkillCandidate({
      candidateId: globalId,
      scope: "global",
      type: "workflow",
      title: `Hub global ${Date.now()}`,
      lesson: "Use the reusable workflow.",
      evidence: ["unit test"],
      reuseRule: "Use when the workflow repeats.",
      redactionStatus: "redacted",
      promotionTarget: "skill",
      projectRoot: null
    });
    store.putSkillCandidate({
      candidateId: projectId,
      scope: "project",
      type: "workflow",
      title: "Project only workflow",
      lesson: "Keep this project-local.",
      evidence: ["unit test"],
      reuseRule: "Use only in this project.",
      redactionStatus: "redacted",
      promotionTarget: "skill",
      projectRoot
    });

    const global = promoteSkillCandidate(store, paths, globalId, true);
    const project = promoteSkillCandidate(store, paths, projectId, true);
    expect(global.targetPath).toContain(join(hubSkillsRoot, "global"));
    expect(project.targetPath).toContain(join(hubSkillsRoot, "projects"));
    expect(project.targetPath).not.toContain(join(projectRoot, ".project-skills"));
    expect(existsSync(join(projectRoot, ".project-skills"))).toBe(false);
    const skills = store.listHubSkills(projectRoot);
    expect(skills.map((skill) => skill.title)).toContain("Project only workflow");
    expect(readFileSync(skills.find((skill) => skill.title === "Project only workflow")!.path, "utf8")).toContain("Keep this project-local.");
    store.close();
  });

  it("deletes rejected pending skill candidates", () => {
    const { store } = setupStore();
    store.putSkillCandidate({
      candidateId: "reject-me",
      scope: "project",
      type: "workflow",
      title: "Reject this candidate",
      lesson: "功能：temporary candidate",
      evidence: ["unit test"],
      reuseRule: "应用场景：do not use",
      redactionStatus: "redacted",
      promotionTarget: "skill",
      projectRoot: "D:\\project"
    });
    expect(store.deleteSkillCandidate("reject-me")).toEqual({ deleted: true });
    expect(store.getSkillCandidate("reject-me")).toBeNull();
    store.close();
  });

  it("prunes existing low-value pending skill candidates with the quality gate", () => {
    const { store } = setupStore();
    store.putSkillCandidate({
      candidateId: "old-noise",
      scope: "global",
      type: "workflow",
      title: "AGENTS.md instructions for D:\\repo",
      lesson: "# AGENTS.md instructions\n<INSTRUCTIONS>\nDefault startup rule",
      evidence: ["unit test"],
      reuseRule: "Use when startup rule repeats.",
      redactionStatus: "redacted",
      promotionTarget: "skill",
      projectRoot: null
    });
    store.putSkillCandidate({
      candidateId: "old-useful",
      scope: "project",
      type: "workflow",
      title: "Dashboard timeout fix workflow",
      lesson: "åŠŸèƒ½ï¼šFix dashboard session-list timeout by replacing per-row scans with SQL aggregation.\nåº”ç”¨åœºæ™¯ï¼šUse when a TypeScript dashboard backed by SQLite times out while listing sessions.\nç»éªŒï¼šLocate the slow endpoint, replace repeated message scans with a single aggregate query, add indexes, verify with tests, and commit the fix.",
      evidence: ["quality:8", "signal:problem-and-fix", "signal:verified-outcome"],
      reuseRule: "Use when a future SQLite dashboard list endpoint regresses or times out.",
      redactionStatus: "redacted",
      promotionTarget: "skill",
      projectRoot: "D:\\project"
    });

    const result = prunePendingSkillCandidates(store);

    expect(result.deleted).toBe(1);
    expect(result.removed.map((item) => item.candidateId)).toEqual(["old-noise"]);
    expect(store.getSkillCandidate("old-noise")).toBeNull();
    expect(store.getSkillCandidate("old-useful")).not.toBeNull();
    store.close();
  });
});
