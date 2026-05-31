import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAllowedOpenCodeDatabases, getAllowedTranscriptRoots, getHubPaths, ensureHubDirectories, loadModelProfiles, getEverCoreConfig } from "../shared/config.js";
import { buildContextBundle } from "./context.js";
import { exportSession } from "./export.js";
import { findJsonlFiles, importJsonlFile, importOpenCodeDatabase } from "./importers.js";
import { ArchiveStore } from "./store.js";
import type { ClientKind, SourceRange } from "./types.js";
import { EverCoreClient, syncPendingEverCoreSessions } from "../evercore/client.js";
import { promoteSkillCandidate } from "../skills/promotion.js";

const clientSchema = z.enum(["codex", "claude", "opencode"]);

export function createArchiveServer(dataDir?: string): McpServer {
  const paths = getHubPaths(dataDir);
  ensureHubDirectories(paths);
  const store = new ArchiveStore(paths);
  const profiles = loadModelProfiles();
  const everCoreClient = new EverCoreClient(getEverCoreConfig());
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

  server.registerTool("evercore_status", {
    title: "Get EverCore Status",
    description: "Check the configured EverCore endpoint used for semantic agent memory.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async () => toolResult(await everCoreClient.status()));

  server.registerTool("evercore_sync_pending_sessions", {
    title: "Sync Archived Sessions To EverCore",
    description: "Incrementally send unsynced archived sessions to EverCore agent memory. Uses session_id plus file_sha256 for idempotence.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ limit }) => toolResult(await syncPendingEverCoreSessions(store, everCoreClient, limit)));

  server.registerTool("evercore_search_agent_memory", {
    title: "Search EverCore Agent Memory",
    description: "Search EverCore agent_memory and return agent cases and reusable skills.",
    inputSchema: {
      query: z.string().min(1).max(1000),
      top_k: z.number().int().min(1).max(50).default(8),
      method: z.enum(["keyword", "vector", "hybrid", "rrf", "agentic"]).default("hybrid")
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ query, top_k, method }) => toolResult(await everCoreClient.searchAgentMemory(query, top_k, method)));

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
    description: "Write an approved candidate to both Codex and Claude global skill directories or to the project .project-skills directory.",
    inputSchema: { candidate_id: z.string().min(1), approved: z.literal(true) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ candidate_id, approved }) => toolResult(promoteSkillCandidate(store, candidate_id, approved)));

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
