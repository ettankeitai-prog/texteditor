import type { WebSource } from "electron";
import type {
  NovelViewerAdapterId,
  NovelViewerToc,
  NovelViewerWorkIdentity
} from "../../../shared/novelViewer.js";

export const NOVEL_VIEWER_TOC_ADAPTER_VERSION = 1;
export const NOVEL_VIEWER_TOC_MAX_HTML_BYTES = 2 * 1024 * 1024;
export const NOVEL_VIEWER_TOC_FETCH_TIMEOUT_MS = 10_000;

export interface NovelViewerRawTocEpisode {
  episodeId?: unknown;
  title?: unknown;
  canonicalUrl?: unknown;
}

export interface NovelViewerRawTocSection {
  title?: unknown;
  episodes?: unknown;
}

export interface NovelViewerRawTocResult {
  complete?: unknown;
  workTitle?: unknown;
  sections?: unknown;
}

export interface NovelViewerSiteAdapter {
  readonly id: NovelViewerAdapterId;
  readonly version: number;
  matchUrl(url: URL): NovelViewerWorkIdentity | null;
  normalizeWorkUrl(identity: NovelViewerWorkIdentity): string;
  validateEpisodeUrl(identity: NovelViewerWorkIdentity, candidate: URL): boolean;
  buildCurrentDocumentExtractionScript(identity: NovelViewerWorkIdentity): WebSource[];
  buildWorkPageExtractionScript(identity: NovelViewerWorkIdentity): WebSource[];
}

export interface NovelViewerNormalizedTocResult {
  toc: NovelViewerToc;
  episodeCount: number;
}

export function currentDocumentSource(extractorExpression: string, configuration: object): WebSource[] {
  return [{
    code: `(async () => {
      const extract = ${extractorExpression};
      return extract(document, ${JSON.stringify(configuration)});
    })()`
  }];
}

export function workPageSource(
  extractorExpression: string,
  configuration: object,
  canonicalWorkUrl: string
): WebSource[] {
  return [{
    code: `(async () => {
      const controller = new AbortController();
      const aborters = globalThis.__novelViewerTocAbortControllers ||= new Set();
      for (const active of aborters) active.abort();
      aborters.clear();
      aborters.add(controller);
      const timer = setTimeout(() => controller.abort(), ${NOVEL_VIEWER_TOC_FETCH_TIMEOUT_MS});
      try {
        const response = await fetch(${JSON.stringify(canonicalWorkUrl)}, {
          method: "GET",
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal
        });
        if (!response.ok) throw new Error("toc-http-status");
        const contentType = response.headers.get("content-type") || "";
        if (!/^text\\/html(?:;|$)/i.test(contentType)) throw new Error("toc-content-type");
        const declaredLength = Number(response.headers.get("content-length") || "0");
        if (Number.isFinite(declaredLength) && declaredLength > ${NOVEL_VIEWER_TOC_MAX_HTML_BYTES}) {
          throw new Error("toc-html-too-large");
        }
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > ${NOVEL_VIEWER_TOC_MAX_HTML_BYTES}) throw new Error("toc-html-too-large");
        const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        const parsed = new DOMParser().parseFromString(html, "text/html");
        const extract = ${extractorExpression};
        return extract(parsed, ${JSON.stringify(configuration)});
      } finally {
        clearTimeout(timer);
        aborters.delete(controller);
      }
    })()`
  }];
}
