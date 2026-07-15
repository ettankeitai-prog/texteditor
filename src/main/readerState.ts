import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  NOVEL_VIEWER_SPLIT_RATIO_MAX,
  NOVEL_VIEWER_SPLIT_RATIO_MIN,
  NOVEL_VIEWER_TOC_WIDTH_MAX,
  NOVEL_VIEWER_TOC_WIDTH_MIN,
  type ReaderScrollState,
  type ReaderState
} from "../shared/novelViewer.js";

const MAX_SCROLL_VALUE = 100_000_000;

export const defaultReaderState: ReaderState = {
  schemaVersion: 1,
  progress: {},
  ui: {
    wasOpen: false,
    preferredPane: "right"
  }
};

function optionalString(value: unknown, maximumLength: number, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximumLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid Reader state field: ${field}`);
  }
  return value;
}

function finiteNumber(value: unknown, maximum: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new Error(`Invalid Reader state field: ${field}`);
  }
  return value;
}

function optionalClampedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid Reader state field: ${field}`);
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeScroll(value: unknown): ReaderScrollState | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Reader state field: progress.scroll");
  }
  const scroll = value as Record<string, unknown>;
  const url = optionalString(scroll.url, 4096, "progress.scroll.url");
  if (!url) throw new Error("Invalid Reader state field: progress.scroll.url");
  return {
    url,
    scrollY: finiteNumber(scroll.scrollY, MAX_SCROLL_VALUE, "progress.scroll.scrollY"),
    documentHeight: finiteNumber(scroll.documentHeight, MAX_SCROLL_VALUE, "progress.scroll.documentHeight"),
    viewportHeight: finiteNumber(scroll.viewportHeight, MAX_SCROLL_VALUE, "progress.scroll.viewportHeight"),
    progressRatio: Math.min(1, finiteNumber(scroll.progressRatio, 1, "progress.scroll.progressRatio"))
  };
}

export function normalizeReaderState(value: unknown): ReaderState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Reader state must be a JSON object.");
  }
  const root = value as Record<string, unknown>;
  if (root.schemaVersion !== 1) throw new Error("Unsupported Reader state schema version.");
  if (!root.progress || typeof root.progress !== "object" || Array.isArray(root.progress)) {
    throw new Error("Invalid Reader state progress object.");
  }
  if (!root.ui || typeof root.ui !== "object" || Array.isArray(root.ui)) {
    throw new Error("Invalid Reader state ui object.");
  }
  const progress = root.progress as Record<string, unknown>;
  const ui = root.ui as Record<string, unknown>;
  if (typeof ui.wasOpen !== "boolean") throw new Error("Invalid Reader state field: ui.wasOpen");
  if (ui.preferredPane !== "right" && ui.preferredPane !== "current") {
    throw new Error("Invalid Reader state field: ui.preferredPane");
  }
  const tocWidthPx = optionalClampedNumber(
    ui.tocWidthPx,
    NOVEL_VIEWER_TOC_WIDTH_MIN,
    NOVEL_VIEWER_TOC_WIDTH_MAX,
    "ui.tocWidthPx"
  );
  const novelViewerSplitRatio = optionalClampedNumber(
    ui.novelViewerSplitRatio,
    NOVEL_VIEWER_SPLIT_RATIO_MIN,
    NOVEL_VIEWER_SPLIT_RATIO_MAX,
    "ui.novelViewerSplitRatio"
  );
  return {
    schemaVersion: 1,
    progress: {
      lastReadableUrl: optionalString(progress.lastReadableUrl, 4096, "progress.lastReadableUrl"),
      title: optionalString(progress.title, 300, "progress.title"),
      scroll: normalizeScroll(progress.scroll),
      lastViewedAt: optionalString(progress.lastViewedAt, 64, "progress.lastViewedAt")
    },
    ui: {
      wasOpen: ui.wasOpen,
      preferredPane: ui.preferredPane,
      ...(tocWidthPx === undefined ? {} : { tocWidthPx }),
      ...(novelViewerSplitRatio === undefined ? {} : { novelViewerSplitRatio })
    }
  };
}

export type ReaderStateLoadResult =
  | { ok: true; state: ReaderState; existed: boolean }
  | { ok: false; state: ReaderState; error: string };

export class ReaderStateStore {
  private state: ReaderState = structuredClone(defaultReaderState);
  private loaded = false;
  private writable = true;
  private writeTail: Promise<void> = Promise.resolve();
  private writeSequence = 0;

  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath;
  }

  get canWrite(): boolean {
    return this.writable;
  }

  get current(): ReaderState {
    return structuredClone(this.state);
  }

  async load(): Promise<ReaderStateLoadResult> {
    if (this.loaded) return { ok: this.writable, state: this.current, ...(this.writable ? { existed: true } : { error: "Reader state is read-only." }) } as ReaderStateLoadResult;
    this.loaded = true;
    try {
      const source = await readFile(this.filePath, "utf8");
      this.state = normalizeReaderState(JSON.parse(source) as unknown);
      return { ok: true, state: this.current, existed: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.state = structuredClone(defaultReaderState);
        return { ok: true, state: this.current, existed: false };
      }
      this.writable = false;
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, state: this.current, error: `Failed to read Reader state: ${reason}` };
    }
  }

  async save(state: ReaderState): Promise<void> {
    if (!this.loaded) throw new Error("Reader state has not been loaded.");
    if (!this.writable) throw new Error("Reader state is read-only because the original file is damaged.");
    const normalized = normalizeReaderState(state);
    const operation = this.writeTail.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${++this.writeSequence}`;
      try {
        await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
        await rename(tempPath, this.filePath);
        this.state = normalized;
      } finally {
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
    });
    this.writeTail = operation;
    await operation;
  }

  async waitForIdle(): Promise<void> {
    await this.writeTail;
  }
}
