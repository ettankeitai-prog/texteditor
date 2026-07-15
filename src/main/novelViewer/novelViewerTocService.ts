import type { WebContents } from "electron";
import type {
  NovelViewerToc,
  NovelViewerTocEpisodeSelection,
  NovelViewerTocErrorCode,
  NovelViewerTocState,
  NovelViewerWorkIdentity
} from "../../shared/novelViewer.js";
import { validateNovelViewerUrl } from "../novelViewerSecurity.js";
import type { NovelViewerTocCacheLookup } from "./novelViewerTocCache.js";
import { NovelViewerTocCache } from "./novelViewerTocCache.js";
import {
  createNovelViewerAdapters,
  type NovelViewerRawTocResult,
  type NovelViewerSiteAdapter
} from "./adapters/index.js";

const TOC_ISOLATED_WORLD_ID = 1_001;
const MAX_STRUCTURED_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_WORK_TITLE_LENGTH = 300;
const MAX_SECTION_TITLE_LENGTH = 300;
const MAX_EPISODE_TITLE_LENGTH = 500;
const MAX_URL_LENGTH = 2_048;
const MAX_SECTIONS = 500;
const MAX_EPISODES = 5_000;

type TocContext = {
  adapter: NovelViewerSiteAdapter;
  identity: NovelViewerWorkIdentity;
  navigationEpoch: number;
  committedUrl: string;
};

type TocLog = (event: string, details?: Record<string, unknown>) => void;

function normalizedText(value: unknown, maximumLength: number, required: boolean): string | undefined {
  if (typeof value !== "string") {
    if (required) throw new Error("toc-invalid-title");
    return undefined;
  }
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) {
    if (required) throw new Error("toc-empty-title");
    return undefined;
  }
  if (normalized.length > maximumLength) throw new Error("toc-title-too-long");
  return normalized;
}

function normalizeCanonicalUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href.length <= MAX_URL_LENGTH ? url : null;
  } catch {
    return null;
  }
}

export function normalizeNovelViewerTocResult(
  adapter: NovelViewerSiteAdapter,
  identity: NovelViewerWorkIdentity,
  rawValue: unknown,
  allowTestProtocol = false,
  now = new Date()
): NovelViewerToc {
  let serialized: string;
  try {
    const encoded = JSON.stringify(rawValue);
    if (typeof encoded !== "string") throw new Error("toc-invalid-result");
    serialized = encoded;
  } catch {
    throw new Error("toc-invalid-result");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_STRUCTURED_PAYLOAD_BYTES) throw new Error("toc-payload-too-large");
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) throw new Error("toc-invalid-result");
  const raw = rawValue as NovelViewerRawTocResult;
  if (raw.complete !== true || !Array.isArray(raw.sections) || raw.sections.length === 0 || raw.sections.length > MAX_SECTIONS) {
    throw new Error("toc-incomplete-result");
  }
  const workTitle = normalizedText(raw.workTitle, MAX_WORK_TITLE_LENGTH, true)!;
  const canonicalWorkUrl = adapter.normalizeWorkUrl(identity);
  const validatedWorkUrl = validateNovelViewerUrl(canonicalWorkUrl, { allowTestProtocol });
  if (!validatedWorkUrl.ok || validatedWorkUrl.url.href !== canonicalWorkUrl) throw new Error("toc-invalid-work-url");
  const seenEpisodeIds = new Set<string>();
  const seenEpisodeUrls = new Set<string>();
  const sections: NovelViewerToc["sections"] = [];
  let rawEpisodeCount = 0;
  let episodeOrder = 0;
  for (const rawSectionValue of raw.sections) {
    if (!rawSectionValue || typeof rawSectionValue !== "object" || Array.isArray(rawSectionValue)) {
      throw new Error("toc-invalid-section");
    }
    const rawSection = rawSectionValue as { title?: unknown; episodes?: unknown };
    if (!Array.isArray(rawSection.episodes)) throw new Error("toc-invalid-section");
    rawEpisodeCount += rawSection.episodes.length;
    if (rawEpisodeCount > MAX_EPISODES) throw new Error("toc-too-many-episodes");
    const title = normalizedText(rawSection.title, MAX_SECTION_TITLE_LENGTH, false);
    const episodes: NovelViewerToc["sections"][number]["episodes"] = [];
    for (const rawEpisodeValue of rawSection.episodes) {
      if (!rawEpisodeValue || typeof rawEpisodeValue !== "object" || Array.isArray(rawEpisodeValue)) continue;
      const rawEpisode = rawEpisodeValue as { episodeId?: unknown; title?: unknown; canonicalUrl?: unknown };
      if (typeof rawEpisode.episodeId !== "string" || rawEpisode.episodeId.length === 0 || rawEpisode.episodeId.length > 128) continue;
      const episodeTitle = normalizedText(rawEpisode.title, MAX_EPISODE_TITLE_LENGTH, false);
      if (!episodeTitle) continue;
      const candidate = normalizeCanonicalUrl(rawEpisode.canonicalUrl);
      if (!candidate) continue;
      const validated = validateNovelViewerUrl(candidate.href, { allowTestProtocol });
      if (!validated.ok || !adapter.validateEpisodeUrl(identity, candidate)) continue;
      if (seenEpisodeIds.has(rawEpisode.episodeId) || seenEpisodeUrls.has(candidate.href)) continue;
      seenEpisodeIds.add(rawEpisode.episodeId);
      seenEpisodeUrls.add(candidate.href);
      episodes.push({
        episodeId: rawEpisode.episodeId,
        order: episodeOrder++,
        title: episodeTitle,
        canonicalUrl: candidate.href
      });
    }
    if (episodes.length > 0) {
      sections.push({
        sectionId: title ? `${identity.workId}:section:${sections.length}` : undefined,
        order: sections.length,
        title,
        episodes
      });
    }
  }
  if (episodeOrder === 0 || sections.length === 0) throw new Error("toc-empty-result");
  return {
    schemaVersion: 1,
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    workId: identity.workId,
    workTitle,
    canonicalWorkUrl,
    sections,
    fetchedAt: now.toISOString()
  };
}

function closedState(): NovelViewerTocState {
  return {
    status: "closed",
    panelOpen: false,
    supported: false,
    sections: [],
    cached: false,
    stale: false,
    canRefresh: false
  };
}

export class NovelViewerTocService {
  private readonly adapters: NovelViewerSiteAdapter[];
  private context: TocContext | null = null;
  private currentToc: NovelViewerToc | null = null;
  private panelOpen = false;
  private requestEpoch = 0;
  private activeFetch: { key: string; promise: Promise<void>; manual: boolean } | null = null;
  private currentState: NovelViewerTocState = closedState();

  constructor(
    private readonly cache: NovelViewerTocCache,
    private readonly emit: (state: NovelViewerTocState) => void,
    private readonly log: TocLog = () => undefined,
    private readonly allowTestProtocol = false,
    adapters?: NovelViewerSiteAdapter[]
  ) {
    this.adapters = adapters ?? createNovelViewerAdapters(allowTestProtocol);
  }

  get state(): NovelViewerTocState {
    return structuredClone(this.currentState);
  }

  setLocation(rawUrl: string | undefined, navigationEpoch: number, contents?: WebContents | null): void {
    const previousKey = this.context ? `${this.context.identity.adapterId}:${this.context.identity.workId}` : null;
    let nextContext: TocContext | null = null;
    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        const adapter = this.adapters.find((candidate) => candidate.matchUrl(parsed));
        const identity = adapter?.matchUrl(parsed) ?? null;
        if (adapter && identity) nextContext = { adapter, identity, navigationEpoch, committedUrl: parsed.href };
      } catch {
        nextContext = null;
      }
    }
    const nextKey = nextContext ? `${nextContext.identity.adapterId}:${nextContext.identity.workId}` : null;
    if (navigationEpoch !== this.context?.navigationEpoch || previousKey !== nextKey) {
      this.requestEpoch += 1;
      this.abortExtraction(contents);
    }
    this.context = nextContext;
    if (!nextContext) {
      this.currentToc = null;
      this.updateState(this.panelOpen ? {
        status: "unsupported",
        panelOpen: true,
        supported: false,
        sections: [],
        cached: false,
        stale: false,
        canRefresh: false
      } : closedState());
      return;
    }
    if (previousKey !== nextKey) this.currentToc = null;
    const identity = nextContext.identity;
    if (this.currentToc) {
      this.updateState({
        ...this.stateFromToc(this.currentToc, this.currentState.cached, this.currentState.stale),
        status: this.panelOpen ? this.currentState.status === "stale" ? "stale" : "ready" : "closed",
        panelOpen: this.panelOpen,
        currentEpisodeId: identity.currentEpisodeId
      });
    } else {
      this.updateState({
        status: this.panelOpen ? "idle" : "closed",
        panelOpen: this.panelOpen,
        supported: true,
        adapterId: identity.adapterId,
        workId: identity.workId,
        sections: [],
        currentEpisodeId: identity.currentEpisodeId,
        cached: false,
        stale: false,
        canRefresh: this.panelOpen
      });
    }
  }

  async open(contents: WebContents | null, committedUrl: string | undefined, navigationEpoch: number): Promise<NovelViewerTocState> {
    this.panelOpen = true;
    this.setLocation(committedUrl, navigationEpoch, contents);
    this.log("toc-panel-opened", this.contextDetails());
    if (!contents || contents.isDestroyed() || !this.context) return this.state;
    await this.load(contents, false);
    return this.state;
  }

  async documentReady(contents: WebContents, committedUrl: string | undefined, navigationEpoch: number): Promise<void> {
    this.setLocation(committedUrl, navigationEpoch, contents);
    if (this.panelOpen && this.context && !contents.isDestroyed()) await this.load(contents, false);
  }

  close(contents?: WebContents | null): NovelViewerTocState {
    this.panelOpen = false;
    this.requestEpoch += 1;
    this.abortExtraction(contents);
    this.currentState = {
      ...this.currentState,
      status: "closed",
      panelOpen: false,
      error: undefined,
      canRefresh: false
    };
    this.log("toc-panel-closed", this.contextDetails());
    this.emitState();
    return this.state;
  }

  async refresh(contents: WebContents | null, committedUrl: string | undefined, navigationEpoch: number): Promise<NovelViewerTocState> {
    this.panelOpen = true;
    this.setLocation(committedUrl, navigationEpoch, contents);
    if (!contents || contents.isDestroyed() || !this.context) return this.state;
    const key = `${this.context.identity.adapterId}:${this.context.identity.workId}`;
    if (this.activeFetch?.key === key && this.activeFetch.manual) {
      await this.activeFetch.promise;
      return this.state;
    }
    this.requestEpoch += 1;
    this.abortExtraction(contents);
    await this.load(contents, true);
    return this.state;
  }

  selectEpisode(selection: NovelViewerTocEpisodeSelection): string | null {
    const context = this.context;
    const toc = this.currentToc;
    if (
      !context || !toc ||
      selection.adapterId !== context.identity.adapterId ||
      selection.workId !== context.identity.workId ||
      selection.adapterId !== toc.adapterId ||
      selection.workId !== toc.workId
    ) return null;
    const episode = toc.sections.flatMap((section) => section.episodes)
      .find((candidate) => candidate.episodeId === selection.episodeId);
    if (!episode) return null;
    try {
      const candidate = new URL(episode.canonicalUrl);
      if (!context.adapter.validateEpisodeUrl(context.identity, candidate)) return null;
      const validated = validateNovelViewerUrl(candidate.href, { allowTestProtocol: this.allowTestProtocol });
      if (!validated.ok || validated.url.href.length > MAX_URL_LENGTH) return null;
      this.log("toc-episode-selected", {
        ...this.contextDetails(),
        episodeId: episode.episodeId,
        url: validated.url.href
      });
      return validated.url.href;
    } catch {
      return null;
    }
  }

  async dispose(contents?: WebContents | null): Promise<void> {
    this.panelOpen = false;
    this.requestEpoch += 1;
    this.abortExtraction(contents);
    this.activeFetch = null;
    this.context = null;
    this.currentToc = null;
    this.currentState = closedState();
    await this.cache.waitForIdle();
  }

  async waitForIdle(): Promise<void> {
    await this.cache.waitForIdle();
  }

  private async load(contents: WebContents, force: boolean): Promise<void> {
    const context = this.context;
    if (!context || contents.isDestroyed()) return;
    const key = `${context.identity.adapterId}:${context.identity.workId}`;
    if (!force && this.activeFetch?.key === key) return this.activeFetch.promise;
    const epoch = ++this.requestEpoch;
    const navigationEpoch = context.navigationEpoch;
    let cached: NovelViewerTocCacheLookup | null = null;
    try {
      cached = await this.cache.get(
        context.identity.adapterId,
        context.identity.workId,
        context.adapter.version,
        context.identity.currentEpisodeId
      );
      if (cached) {
        cached = { ...cached, toc: this.validateCachedToc(context, cached.toc) };
      }
    } catch (error) {
      cached = null;
      this.log("toc-cache-read-failed", { ...this.contextDetails(), reason: this.errorReason(error) });
    }
    if (!this.isCurrent(epoch, navigationEpoch, key)) return;
    if (cached) {
      this.currentToc = cached.toc;
      this.updateState({
        ...this.stateFromToc(cached.toc, true, cached.stale),
        status: cached.stale ? "stale" : "ready",
        panelOpen: true,
        currentEpisodeId: context.identity.currentEpisodeId,
        canRefresh: !force
      });
      this.log(cached.stale ? "toc-cache-stale" : "toc-cache-hit", {
        ...this.contextDetails(),
        staleReason: cached.staleReason,
        episodeCount: this.episodeCount(cached.toc)
      });
      if (!force && cached.fresh) return;
    } else {
      this.updateState({
        status: "loading",
        panelOpen: true,
        supported: true,
        adapterId: context.identity.adapterId,
        workId: context.identity.workId,
        sections: [],
        currentEpisodeId: context.identity.currentEpisodeId,
        cached: false,
        stale: false,
        canRefresh: false
      });
    }
    this.log("toc-fetch-start", { ...this.contextDetails(), force, requestEpoch: epoch });
    const promise = this.extractAndStore(contents, context, epoch, key, Boolean(cached));
    this.activeFetch = { key, promise, manual: force };
    await promise;
    if (this.activeFetch?.promise === promise) this.activeFetch = null;
  }

  private async extractAndStore(
    contents: WebContents,
    context: TocContext,
    epoch: number,
    key: string,
    hadCache: boolean
  ): Promise<void> {
    try {
      let raw: unknown;
      try {
        raw = await contents.executeJavaScriptInIsolatedWorld(
          TOC_ISOLATED_WORLD_ID,
          context.adapter.buildCurrentDocumentExtractionScript(context.identity)
        );
      } catch {
        raw = null;
      }
      let toc: NovelViewerToc | null = null;
      if (raw) {
        try {
          toc = normalizeNovelViewerTocResult(
            context.adapter,
            context.identity,
            raw,
            this.allowTestProtocol
          );
        } catch {
          toc = null;
        }
      }
      if (!toc) {
        const canonicalWorkUrl = context.adapter.normalizeWorkUrl(context.identity);
        const validated = validateNovelViewerUrl(canonicalWorkUrl, { allowTestProtocol: this.allowTestProtocol });
        if (!validated.ok || validated.url.href !== context.identity.canonicalWorkUrl) throw new Error("toc-invalid-work-url");
        raw = await contents.executeJavaScriptInIsolatedWorld(
          TOC_ISOLATED_WORLD_ID,
          context.adapter.buildWorkPageExtractionScript(context.identity)
        );
        toc = normalizeNovelViewerTocResult(
          context.adapter,
          context.identity,
          raw,
          this.allowTestProtocol
        );
      }
      if (!this.isCurrent(epoch, context.navigationEpoch, key)) {
        this.log("toc-result-ignored", { ...this.contextDetails(), requestEpoch: epoch });
        return;
      }
      await this.cache.put(toc);
      if (!this.isCurrent(epoch, context.navigationEpoch, key)) {
        this.log("toc-result-ignored", { ...this.contextDetails(), requestEpoch: epoch, phase: "cache-write" });
        return;
      }
      this.currentToc = toc;
      this.updateState({
        ...this.stateFromToc(toc, false, false),
        status: "ready",
        panelOpen: true,
        currentEpisodeId: context.identity.currentEpisodeId
      });
      this.log("toc-fetch-success", {
        ...this.contextDetails(),
        requestEpoch: epoch,
        sectionCount: toc.sections.length,
        episodeCount: this.episodeCount(toc)
      });
    } catch (error) {
      if (!this.isCurrent(epoch, context.navigationEpoch, key)) {
        this.log("toc-result-ignored", { ...this.contextDetails(), requestEpoch: epoch, phase: "error" });
        return;
      }
      const errorCode = this.errorCode(error);
      const safeError = { code: errorCode, message: "Novel Viewer could not update this table of contents." };
      if (hadCache && this.currentToc) {
        this.updateState({
          ...this.stateFromToc(this.currentToc, true, true),
          status: "stale",
          panelOpen: true,
          currentEpisodeId: context.identity.currentEpisodeId,
          error: safeError
        });
      } else {
        this.updateState({
          status: "error",
          panelOpen: true,
          supported: true,
          adapterId: context.identity.adapterId,
          workId: context.identity.workId,
          sections: [],
          currentEpisodeId: context.identity.currentEpisodeId,
          cached: false,
          stale: false,
          canRefresh: true,
          error: safeError
        });
      }
      this.log("toc-fetch-failed", {
        ...this.contextDetails(),
        requestEpoch: epoch,
        errorCode,
        reason: this.errorReason(error),
        cacheRetained: hadCache
      });
    }
  }

  private stateFromToc(toc: NovelViewerToc, cached: boolean, stale: boolean): NovelViewerTocState {
    return {
      status: stale ? "stale" : "ready",
      panelOpen: this.panelOpen,
      supported: true,
      adapterId: toc.adapterId,
      workId: toc.workId,
      workTitle: toc.workTitle,
      sections: structuredClone(toc.sections),
      currentEpisodeId: this.context?.identity.currentEpisodeId,
      cached,
      stale,
      fetchedAt: toc.fetchedAt,
      canRefresh: true
    };
  }

  private isCurrent(epoch: number, navigationEpoch: number, key: string): boolean {
    const currentKey = this.context ? `${this.context.identity.adapterId}:${this.context.identity.workId}` : null;
    return this.panelOpen && epoch === this.requestEpoch && navigationEpoch === this.context?.navigationEpoch && key === currentKey;
  }

  private updateState(state: NovelViewerTocState): void {
    this.currentState = state;
    this.emitState();
  }

  private emitState(): void {
    this.emit(this.state);
  }

  private abortExtraction(contents?: WebContents | null): void {
    if (!contents || contents.isDestroyed()) return;
    void contents.executeJavaScriptInIsolatedWorld(TOC_ISOLATED_WORLD_ID, [{
      code: `(() => {
        const aborters = globalThis.__novelViewerTocAbortControllers;
        if (!aborters) return 0;
        let count = 0;
        for (const controller of aborters) { controller.abort(); count += 1; }
        aborters.clear();
        return count;
      })()`
    }]).catch(() => undefined);
  }

  private contextDetails(): Record<string, unknown> {
    return this.context ? {
      adapterId: this.context.identity.adapterId,
      workId: this.context.identity.workId,
      navigationEpoch: this.context.navigationEpoch
    } : {};
  }

  private episodeCount(toc: NovelViewerToc): number {
    return toc.sections.reduce((total, section) => total + section.episodes.length, 0);
  }

  private validateCachedToc(context: TocContext, toc: NovelViewerToc): NovelViewerToc {
    if (toc.adapterId !== context.adapter.id || toc.workId !== context.identity.workId) {
      throw new Error("toc-invalid-cache-identity");
    }
    const raw = {
      complete: true,
      workTitle: toc.workTitle,
      sections: toc.sections.map((section) => ({
        title: section.title,
        episodes: section.episodes.map((episode) => ({
          episodeId: episode.episodeId,
          title: episode.title,
          canonicalUrl: episode.canonicalUrl
        }))
      }))
    };
    const normalized = normalizeNovelViewerTocResult(
      context.adapter,
      context.identity,
      raw,
      this.allowTestProtocol,
      new Date(toc.fetchedAt)
    );
    if (this.episodeCount(normalized) !== this.episodeCount(toc)) throw new Error("toc-invalid-cache-episode");
    return { ...normalized, adapterVersion: toc.adapterVersion, fetchedAt: toc.fetchedAt };
  }

  private errorCode(error: unknown): NovelViewerTocErrorCode {
    const reason = this.errorReason(error);
    if (reason.includes("too-large") || reason.includes("payload-too-large")) return "too-large";
    if (reason.includes("http") || reason.includes("fetch") || reason.includes("abort")) return "fetch-failed";
    if (reason.includes("invalid") || reason.includes("empty") || reason.includes("incomplete")) return "invalid-result";
    return "extraction-failed";
  }

  private errorReason(error: unknown): string {
    const value = error instanceof Error ? error.message : String(error);
    return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
  }
}
