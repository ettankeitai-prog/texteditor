import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NovelViewerAdapterId, NovelViewerToc } from "../../shared/novelViewer.js";

export const NOVEL_VIEWER_TOC_CACHE_SCHEMA_VERSION = 1;
export const NOVEL_VIEWER_TOC_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
export const NOVEL_VIEWER_TOC_CACHE_MAX_ENTRIES = 50;
export const NOVEL_VIEWER_TOC_CACHE_MAX_BYTES = 5 * 1024 * 1024;
export const NOVEL_VIEWER_TOC_CACHE_RENAME_RETRY_DELAYS_MS = [20, 60, 120] as const;

const STALE_TEMP_FILE_AGE_MS = 24 * 60 * 60 * 1_000;
const RETRYABLE_RENAME_ERROR_CODES = new Set(["EPERM", "EBUSY"]);

type RenameFile = (source: string, destination: string) => Promise<void>;
type Delay = (milliseconds: number) => Promise<void>;

export interface NovelViewerTocCacheWriteOptions {
  renameFile?: RenameFile;
  delay?: Delay;
}

export interface NovelViewerTocCacheEntry {
  key: string;
  adapterId: NovelViewerAdapterId;
  adapterVersion: number;
  workId: string;
  lastUsedAt: string;
  toc: NovelViewerToc;
}

export interface NovelViewerTocCacheFile {
  schemaVersion: 1;
  entries: NovelViewerTocCacheEntry[];
}

export interface NovelViewerTocCacheLookup {
  toc: NovelViewerToc;
  fresh: boolean;
  stale: boolean;
  staleReason?: "ttl" | "adapter-version" | "episode-missing";
}

function cacheKey(adapterId: NovelViewerAdapterId, workId: string): string {
  return `${adapterId}:${workId}`;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function isCachedToc(value: unknown): value is NovelViewerToc {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const toc = value as Record<string, unknown>;
  if (
    toc.schemaVersion !== 1 ||
    !["kakuyomu", "narou"].includes(String(toc.adapterId)) ||
    typeof toc.adapterVersion !== "number" || !Number.isInteger(toc.adapterVersion) ||
    typeof toc.workId !== "string" || toc.workId.length === 0 || toc.workId.length > 128 ||
    typeof toc.workTitle !== "string" || toc.workTitle.length === 0 || toc.workTitle.length > 300 ||
    typeof toc.canonicalWorkUrl !== "string" || toc.canonicalWorkUrl.length > 2048 ||
    !isIsoDate(toc.fetchedAt) ||
    !Array.isArray(toc.sections) || toc.sections.length === 0 || toc.sections.length > 500
  ) return false;
  let episodeCount = 0;
  for (const section of toc.sections as Array<Record<string, unknown>>) {
    if (!section || typeof section !== "object" || Array.isArray(section)) return false;
    if (typeof section.order !== "number" || !Number.isInteger(section.order) || (section.title !== undefined && (typeof section.title !== "string" || section.title.length > 300))) {
      return false;
    }
    if (!Array.isArray(section.episodes) || section.episodes.length === 0) return false;
    for (const episode of section.episodes as Array<Record<string, unknown>>) {
      episodeCount += 1;
      if (
        !episode || typeof episode !== "object" || Array.isArray(episode) ||
        typeof episode.episodeId !== "string" || episode.episodeId.length === 0 || episode.episodeId.length > 128 ||
        typeof episode.order !== "number" || !Number.isInteger(episode.order) ||
        typeof episode.title !== "string" || episode.title.length === 0 || episode.title.length > 500 ||
        typeof episode.canonicalUrl !== "string" || episode.canonicalUrl.length > 2048
      ) return false;
    }
  }
  return episodeCount > 0 && episodeCount <= 5_000;
}

function normalizeCacheFile(value: unknown): NovelViewerTocCacheFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid TOC cache object.");
  const file = value as Record<string, unknown>;
  if (file.schemaVersion !== NOVEL_VIEWER_TOC_CACHE_SCHEMA_VERSION || !Array.isArray(file.entries)) {
    throw new Error("Unsupported TOC cache schema.");
  }
  const keys = new Set<string>();
  const entries: NovelViewerTocCacheEntry[] = [];
  for (const raw of file.entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid TOC cache entry.");
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.key !== "string" || entry.key.length > 270 ||
      !["kakuyomu", "narou"].includes(String(entry.adapterId)) ||
      typeof entry.adapterVersion !== "number" || !Number.isInteger(entry.adapterVersion) ||
      typeof entry.workId !== "string" || entry.workId.length === 0 || entry.workId.length > 128 ||
      !isIsoDate(entry.lastUsedAt) ||
      !isCachedToc(entry.toc) ||
      entry.key !== cacheKey(entry.adapterId as NovelViewerAdapterId, entry.workId) ||
      keys.has(entry.key)
    ) throw new Error("Invalid TOC cache entry.");
    keys.add(entry.key);
    entries.push(entry as unknown as NovelViewerTocCacheEntry);
  }
  return { schemaVersion: 1, entries };
}

export class NovelViewerTocCache {
  private file: NovelViewerTocCacheFile = { schemaVersion: 1, entries: [] };
  private loadPromise: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private corruptOriginalPending = false;
  private writeSequence = 0;
  private staleTempCleanupComplete = false;
  private readonly renameFile: RenameFile;
  private readonly delay: Delay;

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
    writeOptions: NovelViewerTocCacheWriteOptions = {}
  ) {
    this.renameFile = writeOptions.renameFile ?? rename;
    this.delay = writeOptions.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async get(
    adapterId: NovelViewerAdapterId,
    workId: string,
    adapterVersion: number,
    currentEpisodeId?: string
  ): Promise<NovelViewerTocCacheLookup | null> {
    await this.ensureLoaded();
    return this.enqueueMutation(async () => {
      const entry = this.file.entries.find((candidate) => candidate.key === cacheKey(adapterId, workId));
      if (!entry) return null;
      const currentTime = this.now();
      const previousLastUsedAt = entry.lastUsedAt;
      entry.lastUsedAt = currentTime.toISOString();
      try {
        await this.writeAtomic();
      } catch (error) {
        entry.lastUsedAt = previousLastUsedAt;
        throw error;
      }
      const adapterChanged = entry.adapterVersion !== adapterVersion || entry.toc.adapterVersion !== adapterVersion;
      const episodeMissing = Boolean(
        currentEpisodeId && !entry.toc.sections.some((section) => section.episodes.some((episode) => episode.episodeId === currentEpisodeId))
      );
      const expired = currentTime.getTime() - Date.parse(entry.toc.fetchedAt) >= NOVEL_VIEWER_TOC_CACHE_TTL_MS;
      const staleReason = adapterChanged ? "adapter-version" : episodeMissing ? "episode-missing" : expired ? "ttl" : undefined;
      return {
        toc: structuredClone(entry.toc),
        fresh: !staleReason,
        stale: Boolean(staleReason),
        staleReason
      };
    });
  }

  async put(toc: NovelViewerToc): Promise<void> {
    if (!isCachedToc(toc)) throw new Error("Refusing to cache an invalid or empty Novel Viewer TOC.");
    await this.ensureLoaded();
    await this.enqueueMutation(async () => {
      const previousFile = structuredClone(this.file);
      const key = cacheKey(toc.adapterId, toc.workId);
      const entry: NovelViewerTocCacheEntry = {
        key,
        adapterId: toc.adapterId,
        adapterVersion: toc.adapterVersion,
        workId: toc.workId,
        lastUsedAt: this.now().toISOString(),
        toc: structuredClone(toc)
      };
      try {
        this.file.entries = [...this.file.entries.filter((candidate) => candidate.key !== key), entry];
        this.prune(key);
        await this.writeAtomic();
      } catch (error) {
        this.file = previousFile;
        throw error;
      }
    });
  }

  async waitForIdle(): Promise<void> {
    await this.mutationTail;
  }

  async snapshot(): Promise<NovelViewerTocCacheFile> {
    await this.ensureLoaded();
    await this.waitForIdle();
    return structuredClone(this.file);
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.load();
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    await this.cleanupStaleTemporaryFiles();
    try {
      const content = await readFile(this.filePath, "utf8");
      if (Buffer.byteLength(content, "utf8") > NOVEL_VIEWER_TOC_CACHE_MAX_BYTES) {
        throw new Error("Novel Viewer TOC cache is too large.");
      }
      this.file = normalizeCacheFile(JSON.parse(content) as unknown);
      this.prune();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.file = { schemaVersion: 1, entries: [] };
        return;
      }
      this.file = { schemaVersion: 1, entries: [] };
      this.corruptOriginalPending = true;
      console.error("Novel Viewer TOC cache was ignored and will be regenerated:", error);
    }
  }

  private prune(preferredKey?: string): void {
    const oldestFirst = (): NovelViewerTocCacheEntry[] => [...this.file.entries]
      .filter((entry) => entry.key !== preferredKey)
      .sort((left, right) => Date.parse(left.lastUsedAt) - Date.parse(right.lastUsedAt));
    while (this.file.entries.length > NOVEL_VIEWER_TOC_CACHE_MAX_ENTRIES) {
      const oldest = oldestFirst()[0];
      if (!oldest) break;
      this.file.entries = this.file.entries.filter((entry) => entry.key !== oldest.key);
    }
    while (Buffer.byteLength(`${JSON.stringify(this.file)}\n`, "utf8") > NOVEL_VIEWER_TOC_CACHE_MAX_BYTES) {
      const oldest = oldestFirst()[0];
      if (!oldest) throw new Error("Novel Viewer TOC cache entry exceeds the cache size limit.");
      this.file.entries = this.file.entries.filter((entry) => entry.key !== oldest.key);
    }
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const operation = this.mutationTail.catch(() => undefined).then(mutation);
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async cleanupStaleTemporaryFiles(): Promise<void> {
    if (this.staleTempCleanupComplete) return;
    this.staleTempCleanupComplete = true;
    const directoryPath = path.dirname(this.filePath);
    const temporaryPrefix = `${path.basename(this.filePath)}.tmp-`;
    try {
      const names = await readdir(directoryPath);
      await Promise.all(names.filter((name) => name.startsWith(temporaryPrefix)).map(async (name) => {
        const temporaryPath = path.join(directoryPath, name);
        try {
          const metadata = await stat(temporaryPath);
          if (metadata.isFile() && Date.now() - metadata.mtimeMs >= STALE_TEMP_FILE_AGE_MS) {
            await rm(temporaryPath, { force: true });
          }
        } catch {
          // Stale temporary files are best-effort cleanup and never block cache recovery.
        }
      }));
    } catch {
      // The reader directory may not exist until the first successful cache write.
    }
  }

  private async renameWithRetry(source: string, destination: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.renameFile(source, destination);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        const retryDelay = NOVEL_VIEWER_TOC_CACHE_RENAME_RETRY_DELAYS_MS[attempt];
        if (!code || !RETRYABLE_RENAME_ERROR_CODES.has(code) || retryDelay === undefined) throw error;
        await this.delay(retryDelay);
      }
    }
  }

  private async writeAtomic(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    if (this.corruptOriginalPending) {
      const preservedPath = `${this.filePath}.corrupt-${this.now().toISOString().replace(/[:.]/g, "-")}`;
      await this.renameWithRetry(this.filePath, preservedPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      this.corruptOriginalPending = false;
    }
    const payload = `${JSON.stringify(this.file, null, 2)}\n`;
    if (Buffer.byteLength(payload, "utf8") > NOVEL_VIEWER_TOC_CACHE_MAX_BYTES) {
      throw new Error("Novel Viewer TOC cache exceeds the size limit.");
    }
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${++this.writeSequence}`;
    try {
      await writeFile(temporaryPath, payload, "utf8");
      await this.renameWithRetry(temporaryPath, this.filePath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
