import type { ModelProfile } from "../shared/config.js";
import { approximateTokens } from "../shared/redact.js";
import type { ContextBundle, SourceRange, StoredEvent } from "./types.js";
import { ArchiveStore } from "./store.js";

export interface BuildBundleInput {
  query?: string;
  sessionIds: string[];
  modelProfileName: string;
  modelProfile: ModelProfile;
  tokenBudget?: number;
  pinnedRanges?: SourceRange[];
}

export function buildContextBundle(store: ArchiveStore, input: BuildBundleInput): ContextBundle {
  const derivedBudget = Math.floor(input.modelProfile.contextWindowTokens * input.modelProfile.historicalTextRatio);
  const tokenBudget = Math.min(input.tokenBudget ?? derivedBudget, derivedBudget);
  const selected: StoredEvent[] = [];
  const seen = new Set<number>();
  const nextRanges: SourceRange[] = [];

  for (const range of input.pinnedRanges ?? []) {
    const events = store.getMessages(range.sessionId, range.offset, range.limit);
    const pinnedTokens = events.reduce((total, event) => total + approximateTokens(formatEvent(event)), 0);
    if (pinnedTokens > tokenBudget) {
      throw new Error(`Pinned source range ${range.sessionId}@${range.offset} exceeds the context budget; increase the budget or narrow the range.`);
    }
    selected.push(...events);
    events.forEach((event) => seen.add(event.id));
  }

  const matches = input.query
    ? store.searchMessages(input.query, input.sessionIds.length ? input.sessionIds : undefined, 100, 0)
    : [];
  for (const event of matches) {
    if (!seen.has(event.id)) {
      selected.push(event);
      seen.add(event.id);
    }
  }
  for (const event of store.getRecentMessages(input.sessionIds, 100)) {
    if (!seen.has(event.id)) {
      selected.push(event);
      seen.add(event.id);
    }
  }

  let usedTokens = 0;
  const excerpts: ContextBundle["excerpts"] = [];
  for (const event of selected) {
    const text = formatEvent(event);
    const estimatedTokens = approximateTokens(text);
    if (usedTokens + estimatedTokens > tokenBudget) {
      nextRanges.push({ sessionId: event.sessionId, offset: event.lineNumber, limit: 20 });
      continue;
    }
    usedTokens += estimatedTokens;
    excerpts.push({
      eventId: event.id,
      sourceAnchor: `${event.client}:${event.sessionId}#${event.lineNumber}`,
      text,
      estimatedTokens
    });
  }

  return {
    modelProfile: input.modelProfileName,
    tokenBudget,
    usedTokens,
    redacted: true,
    excerpts,
    truncated: nextRanges.length > 0,
    nextRanges: deduplicateRanges(nextRanges)
  };
}

function formatEvent(event: StoredEvent): string {
  return `[${event.client}:${event.sessionId}#${event.lineNumber}] ${event.role ?? event.eventType} ${event.timestamp ?? ""}\n${event.searchableText}`.trimEnd();
}

function deduplicateRanges(ranges: SourceRange[]): SourceRange[] {
  const seen = new Set<string>();
  return ranges.filter((range) => {
    const key = `${range.sessionId}:${range.offset}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
