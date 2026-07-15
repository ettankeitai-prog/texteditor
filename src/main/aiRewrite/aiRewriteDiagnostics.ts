import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_LOG_BYTES = 512 * 1024;
const MAX_DETAIL_LENGTH = 16_384;
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]"],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted-api-key]"],
  [/([?&](?:access_?token|token|secret|api_?key)=)[^&#\s]+/gi, "$1[redacted]"]
];
const OMITTED_DETAIL_KEYS = new Set([
  "body",
  "content",
  "generatedtext",
  "input",
  "inputtext",
  "originaltext",
  "output",
  "outputtext",
  "prompt",
  "rewrittentext",
  "sourcetext",
  "text"
]);

export function sanitizeAiRewriteDiagnosticText(value: string): string {
  let sanitized = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) sanitized = sanitized.replace(pattern, replacement);
  return sanitized.slice(0, MAX_DETAIL_LENGTH);
}

function sanitizeDiagnosticValue(value: unknown, key: string | undefined, ancestors: WeakSet<object>): unknown {
  if (key && OMITTED_DETAIL_KEYS.has(key.toLowerCase())) return "[omitted]";
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeAiRewriteDiagnosticText(value);
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "object") return String(value).slice(0, MAX_DETAIL_LENGTH);
  if (ancestors.has(value)) return "[circular]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => sanitizeDiagnosticValue(entry, undefined, ancestors));
    }
    const sanitized: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      sanitized[entryKey] = sanitizeDiagnosticValue(entryValue, entryKey, ancestors);
    }
    return sanitized;
  } finally {
    ancestors.delete(value);
  }
}

export function sanitizeAiRewriteDiagnosticDetails(details: Record<string, unknown>): Record<string, unknown> {
  return sanitizeDiagnosticValue(details, undefined, new WeakSet()) as Record<string, unknown>;
}

export class AiRewriteDiagnostics {
  private writeTail: Promise<void>;
  private writtenBytes = 0;

  constructor(readonly filePath: string) {
    this.writeTail = this.initialize();
  }

  record(event: string, details: Record<string, unknown> = {}): void {
    const payload = {
      timestamp: new Date().toISOString(),
      event: event.slice(0, 120),
      ...sanitizeAiRewriteDiagnosticDetails(details)
    };
    const line = `${JSON.stringify(payload)}\n`;
    const byteLength = Buffer.byteLength(line, "utf8");
    const operation = this.writeTail.then(async () => {
      if (this.writtenBytes + byteLength > MAX_LOG_BYTES) await this.rotate();
      await appendFile(this.filePath, line, "utf8");
      this.writtenBytes += byteLength;
    });
    this.writeTail = operation.catch((error) => {
      console.error("Failed to write AI rewrite diagnostics:", error instanceof Error ? error.name : "UnknownError");
    });
  }

  async flush(): Promise<void> {
    await this.writeTail;
  }

  private async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await rm(`${this.filePath}.1`, { force: true });
    await writeFile(this.filePath, "", "utf8");
    this.writtenBytes = 0;
  }

  private async rotate(): Promise<void> {
    const previousPath = `${this.filePath}.1`;
    await rm(previousPath, { force: true });
    await rename(this.filePath, previousPath).catch(() => undefined);
    await writeFile(this.filePath, "", "utf8");
    this.writtenBytes = 0;
  }
}
