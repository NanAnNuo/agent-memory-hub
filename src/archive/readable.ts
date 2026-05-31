import type { StoredEvent } from "./types.js";

const readableRoles = new Set(["user", "assistant"]);

export function isReadableConversationEvent(event: StoredEvent): boolean {
  if (!event.role || !readableRoles.has(event.role)) {
    return false;
  }
  const text = event.searchableText.trim();
  if (!text) {
    return false;
  }
  return !looksLikeToolOrControlText(text);
}

export function readableConversationEvents(events: StoredEvent[]): StoredEvent[] {
  return events.filter(isReadableConversationEvent);
}

function looksLikeToolOrControlText(text: string): boolean {
  const normalized = text.slice(0, 160).trim().toLowerCase();
  return normalized.startsWith("[call")
    || normalized.startsWith("[tool")
    || normalized.startsWith("tool_call")
    || normalized.startsWith("function_call")
    || normalized.startsWith("<tool")
    || normalized.startsWith("{\"cmd\"")
    || normalized.startsWith("{\"tool\"")
    || normalized.startsWith("{\"arguments\"");
}
