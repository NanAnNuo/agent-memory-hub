import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ArchiveStore } from "../archive/store.js";
import type { SkillCandidate } from "../archive/types.js";

export interface PromotionTarget {
  label: "codex" | "claude" | "project";
  path: string;
}

export function promoteSkillCandidate(store: ArchiveStore, candidateId: string, approved: boolean): SkillCandidate {
  if (!approved) {
    throw new Error("Skill promotion requires approved=true.");
  }
  const candidate = store.getSkillCandidate(candidateId);
  if (!candidate) {
    throw new Error(`Unknown skill candidate: ${candidateId}`);
  }
  if (candidate.status !== "pending") {
    throw new Error(`Only pending candidates can be promoted; current status is ${candidate.status}.`);
  }
  if (candidate.redactionStatus !== "redacted") {
    throw new Error("Candidate must be redacted before promotion.");
  }
  if (candidate.promotionTarget !== "skill") {
    throw new Error(`Candidate target is ${candidate.promotionTarget}; this endpoint promotes skills only.`);
  }

  const targets = resolvePromotionTargets(candidate);
  for (const target of targets) {
    mkdirSync(dirname(target.path), { recursive: true });
    writeFileSync(target.path, renderSkill(candidate), "utf8");
  }
  return store.putSkillCandidate({
    ...candidate,
    status: "promoted",
    targetPath: targets.map((target) => `${target.label}:${target.path}`).join("; "),
    promotedAt: new Date().toISOString()
  });
}

export function resolvePromotionTargets(candidate: SkillCandidate): PromotionTarget[] {
  const slug = candidate.scope === "global" ? `learned-${slugify(candidate.title)}` : slugify(candidate.title);
  if (candidate.scope === "global") {
    const roots = globalSkillRoots();
    return [
      { label: "codex", path: join(roots.codex, slug, "SKILL.md") },
      { label: "claude", path: join(roots.claude, slug, "SKILL.md") }
    ];
  }
  return [{ label: "project", path: join(projectSkillDir(candidate), "SKILL.md") }];
}

function projectSkillDir(candidate: SkillCandidate): string {
  if (!candidate.projectRoot) {
    throw new Error("Project skill promotion requires project_root.");
  }
  return join(resolve(candidate.projectRoot), ".project-skills", slugify(candidate.title));
}

function renderSkill(candidate: SkillCandidate): string {
  const name = candidate.scope === "global" ? `learned-${slugify(candidate.title)}` : slugify(candidate.title);
  return [
    "---",
    `name: ${name}`,
    `description: ${singleLine(candidate.reuseRule || candidate.title)}`,
    "---",
    "",
    `# ${candidate.title}`,
    "",
    candidate.lesson.trim(),
    "",
    "## Reuse Rule",
    "",
    candidate.reuseRule.trim(),
    "",
    "## Evidence",
    "",
    ...candidate.evidence.map((item) => `- ${item}`)
  ].join("\n");
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "skill";
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function globalSkillRoots(): { codex: string; claude: string } {
  return {
    codex: process.env.AGENT_HUB_CODEX_SKILLS_DIR ?? join(homedir(), ".codex", "skills"),
    claude: process.env.AGENT_HUB_CLAUDE_SKILLS_DIR ?? join(homedir(), "AppData", "Local", "Claude-3p", "skills")
  };
}
