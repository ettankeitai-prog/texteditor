import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const INVALID_DIAGNOSTIC_URL = "[invalid-url]";
const REDACTED_DIAGNOSTIC_URL = "[redacted-url]";
const CIRCULAR_DIAGNOSTIC_VALUE = "[circular]";
const URL_IN_TEXT_PATTERN = /\b[a-zA-Z][a-zA-Z\d+.-]*:\/\/[^\s<>"']+/g;

function isUrlField(key: string): boolean {
  const normalized = key.replace(/[^a-zA-Z\d]/g, "").toLowerCase();
  return normalized.endsWith("url") || normalized.endsWith("urls") ||
    normalized.endsWith("href") || normalized.endsWith("hrefs");
}

function isUrlBearingTextField(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes("message") || normalized.includes("reason") || normalized.includes("description");
}

export function sanitizeNovelViewerDiagnosticUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (["data:", "javascript:", "blob:", "file:"].includes(parsed.protocol)) {
      return REDACTED_DIAGNOSTIC_URL;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return INVALID_DIAGNOSTIC_URL;
  }
}

function sanitizeUrlsInText(value: string): string {
  return value.replace(URL_IN_TEXT_PATTERN, (candidate) => sanitizeNovelViewerDiagnosticUrl(candidate));
}

export function sanitizeNovelViewerDiagnosticPayload(payload: unknown): unknown {
  const ancestors = new WeakSet<object>();

  const sanitize = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") {
      if (isUrlField(key)) return sanitizeNovelViewerDiagnosticUrl(value);
      if (isUrlBearingTextField(key)) return sanitizeUrlsInText(value);
      return value;
    }
    if (typeof value === "bigint") return value.toString();
    if (value === null || typeof value !== "object") return value;
    if (ancestors.has(value)) return CIRCULAR_DIAGNOSTIC_VALUE;

    ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => sanitize(item, key));
      const sanitized: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        sanitized[childKey] = sanitize(childValue, childKey);
      }
      return sanitized;
    } catch {
      return "[unserializable]";
    } finally {
      ancestors.delete(value);
    }
  };

  return sanitize(payload);
}

export function shouldEnableNovelViewerDiagnostics(isPackaged: boolean, debugFlag: string | undefined): boolean {
  return !isPackaged || debugFlag === "1";
}

export function shouldShowNovelViewerDiagnosticMenu(isPackaged: boolean): boolean {
  return !isPackaged;
}

export class NovelViewerDiagnostics {
  private writeTail: Promise<void>;
  private writtenBytes = 0;

  constructor(
    readonly filePath: string,
    readonly enabled: boolean
  ) {
    this.writeTail = enabled ? this.initialize() : Promise.resolve();
  }

  record(event: string, state: Record<string, unknown> = {}): void {
    if (!this.enabled) return;
    const payload = sanitizeNovelViewerDiagnosticPayload({ timestamp: new Date().toISOString(), event, ...state });
    const line = `${JSON.stringify(payload)}\n`;
    const byteLength = Buffer.byteLength(line, "utf8");
    const operation = this.writeTail.then(async () => {
      if (this.writtenBytes + byteLength > MAX_LOG_BYTES) await this.rotate();
      await appendFile(this.filePath, line, "utf8");
      this.writtenBytes += byteLength;
    });
    this.writeTail = operation.catch((error) => {
      console.error("Failed to write Novel Viewer diagnostics:", error);
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
