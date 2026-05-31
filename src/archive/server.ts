import { existsSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAllowedOpenCodeDatabases, getAllowedTranscriptRoots, getHubPaths, ensureHubDirectories, loadModelProfiles } from "../shared/config.js";
import { buildContextBundle } from "./context.js";
import { exportSession } from "./export.js";
import { findJsonlFiles, importJsonlFile, importOpenCodeDatabase } from "./importers.js";
import { ArchiveStore } from "./store.js";
import type { ClientKind, SourceRange } from "./types.js";
import { buildContextPack, buildMemoryFromSession, searchLocalMemory } from "../memory/local.js";
import { promoteSkillCandidate } from "../skills/promotion.js";

const clientSchema = z.enum(["codex", "claude", "opencode"]);

export function createArchiveServer(dataDir?: string): McpServer {
  const paths = getHubPaths(dataDir);
  ensureHubDirectories(paths);
  const store = new ArchiveStore(paths);
  const profiles = loadModelProfiles();
  const server = new McpServer({ name: "agent-archive-mcp-server", version: "0.1.0" });

  server.registerTool("archive_ingest_jsonl", {
    title: "Ingest Agent JSONL Transcripts",
    description: "Append Codex, Claude Code, or OpenCode JSONL transcript files into the local immutable archive. Source files are read only.",
    inputSchema: {
      client: clientSchema,
      root: z.string().min(1),
      source_path: z.string().min(1).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ client, root, source_path }) => {
    const approvedRoot = resolve(root);
    if (!getAllowedTranscriptRoots().includes(approvedRoot)) {
      throw new Error("Transcript root is not approved. Add an OpenCode transcript root through AGENT_HUB_TRANSCRIPT_ROOTS before ingestion.");
    }
    if (!existsSync(approvedRoot)) {
      throw new Error(`Transcript root does not exist: ${approvedRoot}`);
    }
    if (source_path && !isWithin(approvedRoot, resolve(source_path))) {
      throw new Error("source_path must remain within the approved transcript root.");
    }
    const sourcePaths = source_path ? [resolve(source_path)] : findJsonlFiles(approvedRoot);
    let insertedEvents = 0;
    const sessions = sourcePaths.map((path) => {
      const result = store.ingestSession(importJsonlFile(client as ClientKind, path, approvedRoot));
      insertedEvents += result.insertedEvents;
      return result.sessionId;
    });
    return toolResult({ client, files: sourcePaths.length, sessions, insertedEvents });
  });

  server.registerTool("archive_get_manifest", {
    title: "Get Archived Session Manifest",
    description: "Return metadata and event offsets for an archived conversation without loading transcript content.",
    inputSchema: { session_id: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ session_id }) => toolResult(store.getManifest(session_id)));

  server.registerTool("archive_ingest_opencode_database", {
    title: "Ingest OpenCode CLI Sessions",
    description: "Append OpenCode CLI session message and part records from its approved local SQLite database. Account and token tables are never read.",
    inputSchema: { database_path: z.string().min(1).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ database_path }) => {
    const selected = resolve(database_path ?? getAllowedOpenCodeDatabases()[0]);
    if (!getAllowedOpenCodeDatabases().includes(selected)) {
      throw new Error("OpenCode database is not approved. Add an explicit database path through AGENT_HUB_OPENCODE_DATABASES before ingestion.");
    }
    if (!existsSync(selected)) {
      throw new Error(`OpenCode session database does not exist: ${selected}`);
    }
    let insertedEvents = 0;
    const sessions = importOpenCodeDatabase(selected).map((session) => {
      const outcome = store.ingestSession(session);
      insertedEvents += outcome.insertedEvents;
      return outcome.sessionId;
    });
    return toolResult({ client: "opencode", database: selected, sessions, insertedEvents });
  });

  server.registerTool("archive_list_sessions", {
    title: "List Archived Sessions",
    description: "List imported conversation manifests, optionally filtered by client.",
    inputSchema: { client: clientSchema.optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ client }) => toolResult(store.listManifests(client)));

  server.registerTool("archive_search_sessions", {
    title: "Search Archived Conversations",
    description: "Search indexed conversation text. Returned excerpts are credential-redacted by default.",
    inputSchema: {
      query: z.string().min(1).max(500),
      session_ids: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0)
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ query, session_ids, limit, offset }) => toolResult(store.searchMessages(query, session_ids, limit, offset)));

  server.registerTool("archive_get_messages", {
    title: "Page Redacted Archived Messages",
    description: "Return redacted exact message pages with source offsets for normal context retrieval.",
    inputSchema: {
      session_id: z.string().min(1),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(20)
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ session_id, offset, limit }) => toolResult(store.getMessages(session_id, offset, limit)));

  server.registerTool("archive_get_raw_events", {
    title: "Read Source-Form Archived Events",
    description: "Read archived JSONL-form events with explicit confirmation and an audit entry. Detected credentials are redacted before storage; original hashes remain available for integrity checking.",
    inputSchema: {
      session_id: z.string().min(1),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(20),
      confirm_sensitive: z.literal(true)
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ session_id, offset, limit, confirm_sensitive }) => toolResult(store.getRawEvents(session_id, offset, limit, confirm_sensitive)));

  server.registerTool("context_build_bundle", {
    title: "Build Budgeted Raw Context Bundle",
    description: "Select source-anchored, redacted original message excerpts under a configured model token budget; returns continuation pointers on truncation.",
    inputSchema: {
      query: z.string().max(500).optional(),
      session_ids: z.array(z.string()).default([]),
      model_profile: z.string().min(1),
      token_budget: z.number().int().positive().optional(),
      pinned_ranges: z.array(z.object({
        sessionId: z.string().min(1),
        offset: z.number().int().min(0),
        limit: z.number().int().min(1).max(100)
      })).optional()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ query, session_ids, model_profile, token_budget, pinned_ranges }) => {
    const profile = profiles[model_profile];
    if (!profile) {
      throw new Error(`Unknown model profile: ${model_profile}`);
    }
    return toolResult(buildContextBundle(store, {
      query,
      sessionIds: session_ids,
      modelProfileName: model_profile,
      modelProfile: profile,
      tokenBudget: token_budget,
      pinnedRanges: pinned_ranges as SourceRange[] | undefined
    }));
  });

  server.registerTool("context_checkpoint_task", {
    title: "Write Structured Task Checkpoint",
    description: "Store task state and exact archived source ranges for later continuation without relying on prose summaries.",
    inputSchema: {
      task_id: z.string().min(1),
      source_ranges: z.array(z.object({ sessionId: z.string(), offset: z.number().int().min(0), limit: z.number().int().positive() })).default([]),
      files: z.array(z.string()).default([]),
      commands: z.array(z.string()).default([]),
      tests: z.array(z.string()).default([]),
      decisions: z.array(z.string()).default([]),
      pending: z.array(z.string()).default([])
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ task_id, source_ranges, files, commands, tests, decisions, pending }) => toolResult(store.putCheckpoint({
    taskId: task_id,
    sourceRanges: source_ranges as SourceRange[],
    files,
    commands,
    tests,
    decisions,
    pending
  })));

  server.registerTool("context_get_checkpoint", {
    title: "Read Structured Task Checkpoint",
    description: "Read a previously stored continuation checkpoint.",
    inputSchema: { task_id: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ task_id }) => toolResult(store.getCheckpoint(task_id)));

  server.registerTool("hub_status", {
    title: "Get Hub Status",
    description: "Return local archive, memory, and skill counts.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => toolResult({
    sessions: store.listManifests().length,
    skills: store.listHubSkills(undefined, true).length,
    memorySync: store.listMemorySync().slice(0, 20),
    skillsDir: paths.skillsDir,
    lanceDbDir: paths.lanceDbDir
  }));

  server.registerTool("memory_search", {
    title: "Search Local Agent Memory",
    description: "Search local memory cases, skill hints, and optional profile entries.",
    inputSchema: {
      query: z.string().min(1).max(1000),
      project_root: z.string().optional(),
      types: z.array(z.enum(["case", "skill_hint", "profile"])).default([]),
      top_k: z.number().int().min(1).max(50).default(8)
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ query, project_root, types, top_k }) => toolResult(searchLocalMemory(store, query, project_root, types, top_k)));

  server.registerTool("memory_build_from_session", {
    title: "Build Memory From Session",
    description: "Create a local memory item from a previously archived session.",
    inputSchema: { session_id: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ session_id }) => toolResult(await buildMemoryFromSession(store, session_id)));

  server.registerTool("memory_get_context_pack", {
    title: "Build Restore Context Pack",
    description: "Generate a readable context pack for continuing a prior archived session.",
    inputSchema: { session_id: z.string().min(1), max_messages: z.number().int().min(1).max(200).default(40) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ session_id, max_messages }) => toolResult(buildContextPack(store, session_id, max_messages)));

  server.registerTool("skill_candidate_create", {
    title: "Create Reviewable Skill Candidate",
    description: "Create a candidate lesson for human approval before writing a global or project-level skill.",
    inputSchema: {
      candidate_id: z.string().min(1).optional(),
      scope: z.enum(["global", "project"]),
      type: z.enum(["pitfall", "workflow", "preference", "tooling", "debug-pattern"]).default("workflow"),
      title: z.string().min(1).max(160),
      lesson: z.string().min(1),
      evidence: z.array(z.string()).default([]),
      reuse_rule: z.string().min(1),
      redaction_status: z.enum(["redacted", "needs-human-review"]).default("redacted"),
      promotion_target: z.enum(["memory", "skill", "project-rule", "discard"]).default("skill"),
      project_root: z.string().min(1).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ candidate_id, scope, type, title, lesson, evidence, reuse_rule, redaction_status, promotion_target, project_root }) => toolResult(store.putSkillCandidate({
    candidateId: candidate_id ?? `cand-${Date.now()}`,
    scope,
    type,
    title,
    lesson,
    evidence,
    reuseRule: reuse_rule,
    redactionStatus: redaction_status,
    promotionTarget: promotion_target,
    projectRoot: project_root ?? null
  })));

  server.registerTool("skill_candidate_list", {
    title: "List Skill Candidates",
    description: "List reviewable skill candidates.",
    inputSchema: { status: z.enum(["pending", "promoted", "discarded"]).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ status }) => toolResult(store.listSkillCandidates(status)));

  server.registerTool("skill_candidate_promote", {
    title: "Promote Approved Skill Candidate",
    description: "Write an approved candidate to the Hub-managed skill directory only.",
    inputSchema: { candidate_id: z.string().min(1), approved: z.literal(true) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ candidate_id, approved }) => toolResult(promoteSkillCandidate(store, paths, candidate_id, approved)));

  server.registerTool("hub_skill_list", {
    title: "List Hub Skills",
    description: "List Hub-managed skills without reading Codex/Claude native skill directories.",
    inputSchema: { project_root: z.string().optional(), include_disabled: z.boolean().default(false) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ project_root, include_disabled }) => toolResult(store.listHubSkills(project_root, include_disabled)));

  server.registerTool("hub_skill_search", {
    title: "Search Hub Skills",
    description: "Search Hub-managed skills by query and optional project root.",
    inputSchema: { query: z.string().min(1), project_root: z.string().optional(), limit: z.number().int().min(1).max(50).default(10) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ query, project_root, limit }) => {
    const lowered = query.toLowerCase();
    return toolResult(store.listHubSkills(project_root).filter((skill) =>
      `${skill.title}\n${skill.reuseRule}`.toLowerCase().includes(lowered)
    ).slice(0, limit));
  });

  server.registerTool("hub_skill_get", {
    title: "Read Hub Skill",
    description: "Read one Hub-managed SKILL.md file by skill id.",
    inputSchema: { skill_id: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ skill_id }) => {
    const skill = store.getHubSkill(skill_id);
    if (!skill) {
      throw new Error(`Unknown Hub skill: ${skill_id}`);
    }
    return toolResult({ ...skill, content: readFileSync(skill.path, "utf8") });
  });

  server.registerTool("archive_export_session", {
    title: "Export Archived Session",
    description: "Export a redacted archived session as Markdown or JSON.",
    inputSchema: {
      session_id: z.string().min(1),
      format: z.enum(["markdown", "json"]),
      output_path: z.string().min(1).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ session_id, format, output_path }) => toolResult(exportSession(store, paths, session_id, format, output_path)));

  return server;
}

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function isWithin(root: string, path: string): boolean {
  const descendant = relative(root, path);
  return descendant !== "" && !descendant.startsWith("..") && !descendant.startsWith("\\") && !descendant.startsWith("/");
}
