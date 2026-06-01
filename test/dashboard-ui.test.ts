import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  it("loads the local workbench, promotes an isolated Hub skill, and exports a session", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-memory-ui-"));
    const dataDir = join(root, "data");
    const transcriptRoot = join(root, "sessions");
    const projectRoot = join(root, "project");
    mkdirSync(transcriptRoot, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(transcriptRoot, "session.jsonl"), [
      JSON.stringify({ type: "developer", sessionId: "ui-session", cwd: projectRoot, timestamp: "2026-05-31T00:00:00Z", content: "internal dashboard setup" }),
      JSON.stringify({ type: "user", sessionId: "ui-session", cwd: projectRoot, timestamp: "2026-05-31T00:00:00Z", message: { role: "user", content: "please export this durable workflow" } }),
      JSON.stringify({ type: "assistant", sessionId: "ui-session", cwd: projectRoot, timestamp: "2026-05-31T00:00:00Z", message: { role: "assistant", content: "[call playwright screenshot]" } }),
      JSON.stringify({ type: "assistant", sessionId: "ui-session", cwd: projectRoot, timestamp: "2026-05-31T00:00:01Z", message: { role: "assistant", content: "workflow captured" } })
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
        AGENT_HUB_INCLUDE_DEFAULT_TRANSCRIPT_ROOTS: "false",
        AGENT_HUB_TRANSCRIPT_ROOTS: transcriptRoot
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

    await page.goto(`http://127.0.0.1:${port}/#token=${token}`, { waitUntil: "domcontentloaded" });
    await expectText(page, "Agent Memory Hub");
    await expectText(page, "Local Memory");

    await page.locator('[data-view="conversations"]').click();
    await page.locator("#projectFilter").fill(projectRoot);
    await page.locator("#sessionFilters button[type='submit']").click();
    await expectText(page, "please export this durable workflow");
    await page.locator(`[data-session="${imported.sessionId}"]`).click();
    await expectText(page, imported.sessionId);
    await page.locator(".chain-event.user").first().waitFor({ timeout: 10000 });
    await page.locator(".chain-event.assistant").first().waitFor({ timeout: 10000 });
    await page.locator(".chain-event.tool").first().waitFor({ timeout: 10000 });
    await page.locator(".chain-event.control").first().waitFor({ timeout: 10000 });

    await page.locator('[data-view="skills"]').click();
    await page.locator("#candTitle").fill("Project UI Flow");
    await page.locator("#candProject").fill(projectRoot);
    await page.locator("#candRule").fill("Use only for this project UI flow.");
    await page.locator("#candLesson").fill("Prefer browser verification for dashboard flows.");
    await page.locator("#candEvidence").fill("playwright ui test");
    await page.locator("#createCandidate").click();
    await page.locator("#candidates").getByText("Project UI Flow", { exact: true }).waitFor({ timeout: 10000 });
    await page.locator("[data-candidate]").first().click();
    await waitFor(() => existsSync(join(projectRoot, ".project-skills")) ? "" : "project-clean", 10000);
    await waitFor(() => existsSync(join(paths.skillsDir, "projects")) ? "hub-skill" : "", 10000);

    await page.locator('[data-view="conversations"]').click();
    await page.locator("#openExportDialog").click();
    await page.locator("#exportFormat").selectOption("markdown");
    await page.locator("#exportForm button[type='submit']").click();
    await waitFor(async () => {
      const text = await page.locator("#exportPreview").textContent();
      return text?.includes("please export this durable workflow") ? text : "";
    }, 10000);

    expect(errors).toEqual([]);
  }, 45000);
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
