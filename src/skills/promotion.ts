import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ArchiveStore } from "../archive/store.js";
import type { HubPaths } from "../shared/config.js";
import type { HubSkill, SkillCandidate } from "../archive/types.js";

export interface PromotionTarget {
  label: "hub-global" | "hub-project";
  path: string;
}

export function promoteSkillCandidate(store: ArchiveStore, paths: HubPaths, candidateId: string, approved: boolean): SkillCandidate {
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

  const target = resolvePromotionTarget(paths, candidate);
  mkdirSync(dirname(target.path), { recursive: true });
  writeFileSync(target.path, renderSkill(candidate), "utf8");
  const slug = slugify(candidate.title);
  const projectHash = candidate.scope === "project" ? hashProject(candidate.projectRoot ?? "") : null;
  const skill = store.putHubSkill({
    skillId: `skill-${candidate.candidateId}`,
    scope: candidate.scope,
    title: candidate.title,
    slug,
    projectRoot: candidate.projectRoot ? resolve(candidate.projectRoot) : null,
    projectHash,
    path: target.path,
    reuseRule: candidate.reuseRule,
    sourceCandidateId: candidate.candidateId,
    sourceSessionId: evidenceSession(candidate.evidence)
  });
  return store.putSkillCandidate({
    ...candidate,
    status: "promoted",
    targetPath: `${target.label}:${skill.path}`,
    promotedAt: new Date().toISOString()
  });
}

export function resolvePromotionTarget(paths: HubPaths, candidate: SkillCandidate): PromotionTarget {
  const slug = slugify(candidate.title);
  if (candidate.scope === "global") {
    return { label: "hub-global", path: join(paths.skillsDir, "global", slug, "SKILL.md") };
  }
  if (!candidate.projectRoot) {
    throw new Error("Project skill promotion requires project_root.");
  }
  return { label: "hub-project", path: join(paths.skillsDir, "projects", hashProject(candidate.projectRoot), slug, "SKILL.md") };
}

function renderSkill(candidate: SkillCandidate): string {
  return [
    "---",
    `name: ${slugify(candidate.title)}`,
    `description: ${singleLine(candidate.reuseRule || candidate.title)}`,
    `scope: ${candidate.scope}`,
    candidate.projectRoot ? `project_root: ${candidate.projectRoot}` : "",
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
  ].filter((line) => line !== "").join("\n");
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "skill";
}

export function hashProject(value: string): string {
  return createHash("sha256").update(resolve(value)).digest("hex").slice(0, 16);
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function evidenceSession(evidence: string[]): HubSkill["sourceSessionId"] {
  const match = evidence.join("\n").match(/\b(?:codex|claude|opencode)-[a-z0-9-]+/i);
  return match?.[0] ?? null;
}
