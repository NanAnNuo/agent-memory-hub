import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ArchiveStore } from "../archive/store.js";
import type { SkillCandidate } from "../archive/types.js";

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

  const targetDir = candidate.scope === "global"
    ? join(process.env.AGENT_HUB_GLOBAL_SKILLS_DIR ?? join(homedir(), ".agents", "skills"), `learned-${slugify(candidate.title)}`)
    : projectSkillDir(candidate);
  mkdirSync(targetDir, { recursive: true });
  const targetPath = join(targetDir, "SKILL.md");
  writeFileSync(targetPath, renderSkill(candidate), "utf8");
  return store.putSkillCandidate({
    ...candidate,
    status: "promoted",
    targetPath,
    promotedAt: new Date().toISOString()
  });
}

function projectSkillDir(candidate: SkillCandidate): string {
  if (!candidate.projectRoot) {
    throw new Error("Project skill promotion requires project_root.");
  }
  return join(resolve(candidate.projectRoot), ".agent-experience", "skills", slugify(candidate.title));
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
