import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { ensureHubDirectories, getHubPaths } from "../src/shared/config.js";
import { ArchiveStore } from "../src/archive/store.js";
import { importJsonlFile } from "../src/archive/importers.js";

let dashboardProcess: ChildProcessWithoutNullStreams | null = null;
let browser: Browser | null = null;

afterEach(async () => {
  if (browser) {
    await browser.close();
    browser = null;
  }
  if (dashboardProcess) {
    dashboardProcess.kill();
    dashboardProcess = null;
  }
});

describe("dashboard UI flow", () => {
  it("loads the visual workbench, creates a project skill candidate, promotes it, and exports a session", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-memory-ui-"));
    const dataDir = join(root, "data");
    const transcriptRoot = join(root, "sessions");
    const projectRoot = join(root, "project");
    const codexSkills = join(root, "codex-skills");
    const claudeSkills = join(root, "claude-skills");
    mkdirSync(transcriptRoot, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(transcriptRoot, "session.jsonl"), [
      JSON.stringify({ type: "user", sessionId: "ui-session", timestamp: "2026-05-31T00:00:00Z", message: { role: "user", content: "please export this durable workflow" } }),
      JSON.stringify({ type: "assistant", sessionId: "ui-session", timestamp: "2026-05-31T00:00:01Z", message: { role: "assistant", content: "workflow captured" } })
    ].join("\n"), "utf8");
    const paths = getHubPaths(dataDir);
    ensureHubDirectories(paths);
    const store = new ArchiveStore(paths);
    const imported = importJsonlFile("codex", join(transcriptRoot, "session.jsonl"), transcriptRoot);
    store.ingestSession(imported);
    store.close();

    const port = 43210 + Math.floor(Math.random() * 1000);
    dashboardProcess = spawn(process.execPath, ["dist/dashboard-main.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENT_HUB_DATA_DIR: dataDir,
        AGENT_HUB_DASHBOARD_PORT: String(port),
        AGENT_HUB_TRANSCRIPT_ROOTS: transcriptRoot,
        AGENT_HUB_CODEX_SKILLS_DIR: codexSkills,
        AGENT_HUB_CLAUDE_SKILLS_DIR: claudeSkills
      }
    });
    const tokenPath = join(dataDir, "dashboard.token");
    await waitFor(() => readFileSync(tokenPath, "utf8").trim(), 10000);
    const token = readFileSync(tokenPath, "utf8").trim();

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("response", async (response) => {
      if (response.url().includes("/api/export") && !response.ok()) {
        errors.push(`export ${response.status()}: ${await response.text()}`);
      }
    });

    await page.goto(`http://127.0.0.1:${port}/#token=${token}`, { waitUntil: "networkidle" });
    await expectText(page, "Agent Memory Hub");
    await expectText(page, "EverCore");

    await page.getByRole("button", { name: "会话" }).click();
    await expectText(page, "ui-session");
    await page.locator(`[data-session="${imported.sessionId}"]`).click();
    await expectText(page, "please export this durable workflow");

    await page.getByRole("button", { name: "Skills" }).click();
    await page.locator("#candTitle").fill("Project UI Flow");
    await page.locator("#candProject").fill(projectRoot);
    await page.locator("#candRule").fill("Use only for this project UI flow.");
    await page.locator("#candLesson").fill("Prefer browser verification for dashboard flows.");
    await page.locator("#candEvidence").fill("playwright ui test");
    await page.getByRole("button", { name: "生成待审核候选" }).click();
    await page.locator("#candidates").getByText("Project UI Flow", { exact: true }).waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "批准写入" }).click();
    await waitFor(() => readFileSync(join(projectRoot, ".project-skills", "project-ui-flow", "SKILL.md"), "utf8"), 10000);

    await page.getByRole("button", { name: "导出" }).click();
    await page.locator("#exportSessionId").fill(imported.sessionId);
    await page.locator("#exportFormat").selectOption("markdown");
    await page.getByRole("button", { name: "导出并下载" }).click();
    await waitFor(async () => {
      const text = await page.locator("#exportPreview").textContent();
      return text?.includes("please export this durable workflow") ? text : "";
    }, 10000);

    expect(errors).toEqual([]);
  }, 30000);
});

async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for condition.");
}

async function expectText(page: import("playwright").Page, text: string): Promise<void> {
  await page.getByText(text, { exact: false }).first().waitFor({ timeout: 10000 });
}
