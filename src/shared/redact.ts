const patterns: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{12,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9_]{12,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[:=]\s*["']?)[^"',\s}\]]{8,}/gi
];

export function redactSensitive(text: string): string {
  let output = text;
  for (const pattern of patterns) {
    output = output.replace(pattern, (_match, prefix?: string) => `${prefix ?? ""}[REDACTED]`);
  }
  return output;
}

export function containsSensitive(text: string): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

export function approximateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
