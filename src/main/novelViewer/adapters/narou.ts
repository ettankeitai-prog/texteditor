import type { NovelViewerWorkIdentity } from "../../../shared/novelViewer.js";
import {
  NOVEL_VIEWER_TOC_ADAPTER_VERSION,
  currentDocumentSource,
  workPageSource,
  type NovelViewerSiteAdapter
} from "./types.js";

const NAROU_HOST = "ncode.syosetu.com";
const PRODUCTION_PATH = /^\/([Nn][0-9]{4}[A-Za-z]{2})\/(?:([0-9]{1,12})\/?)?$/;
const TEST_PATH = /^\/toc\/narou\/([Nn][0-9]{4}[A-Za-z]{2})\/(?:([0-9]{1,12})\/?)?$/;

const NAROU_EXTRACTOR = `(root, config) => {
  const normalize = (value) => String(value || "").replace(/[\\u0000-\\u001f\\u007f]/g, " ").replace(/\\s+/g, " ").trim();
  const episodePattern = config.test
    ? /^\\/toc\\/narou\\/([^/]+)\\/([0-9]+)\\/?$/i
    : /^\\/([^/]+)\\/([0-9]+)\\/?$/i;
  const toc = root.querySelector(".p-eplist");
  const sections = [];
  let currentSection = { episodes: [] };
  const seen = new Set();
  if (toc) {
    const nodes = toc.querySelectorAll('.p-eplist__chapter-title, a.p-eplist__subtitle[href], a[href]');
    for (const node of Array.from(nodes)) {
      if (node.matches(".p-eplist__chapter-title")) {
        if (currentSection.episodes.length > 0) sections.push(currentSection);
        currentSection = { title: normalize(node.textContent) || undefined, episodes: [] };
        continue;
      }
      if (!(node instanceof HTMLAnchorElement)) continue;
      let parsed;
      try {
        parsed = new URL(node.getAttribute("href") || "", config.canonicalWorkUrl);
      } catch {
        continue;
      }
      const matched = episodePattern.exec(parsed.pathname);
      const ncode = matched?.[1]?.toLowerCase();
      const episodeId = matched?.[2];
      if (!episodeId || ncode !== config.workId || seen.has(episodeId)) continue;
      const title = normalize(node.textContent);
      if (!title) continue;
      seen.add(episodeId);
      currentSection.episodes.push({ episodeId, title, canonicalUrl: parsed.href });
    }
  }
  if (currentSection.episodes.length > 0) sections.push(currentSection);
  const workTitleNode = root.querySelector("h1.p-novel__title:not(.p-novel__title--rensai)")
    || root.querySelector("h1.p-novel__title");
  const workLink = Array.from(root.querySelectorAll("a[href]")).find((link) => {
    try {
      const parsed = new URL(link.getAttribute("href") || "", config.canonicalWorkUrl);
      return parsed.pathname.toLowerCase() === new URL(config.canonicalWorkUrl).pathname.toLowerCase();
    } catch {
      return false;
    }
  });
  const workTitle = normalize(workTitleNode?.textContent || workLink?.textContent);
  const hasPagination = Boolean(toc?.querySelector('a[href*="?p="]'));
  return {
    complete: Boolean(toc && seen.size > 0 && !hasPagination),
    workTitle,
    sections
  };
}`;

export function createNarouAdapter(allowTestProtocol = false): NovelViewerSiteAdapter {
  const match = (url: URL): RegExpExecArray | null => {
    if (url.protocol === "https:" && url.hostname === NAROU_HOST && !url.port) {
      return PRODUCTION_PATH.exec(url.pathname);
    }
    if (allowTestProtocol && url.protocol === "novel-reader-test:" && url.hostname === "fixture") {
      return TEST_PATH.exec(url.pathname);
    }
    return null;
  };
  const normalizeWorkUrl = (identity: NovelViewerWorkIdentity): string => {
    if (identity.canonicalWorkUrl.startsWith("novel-reader-test:")) {
      return `novel-reader-test://fixture/toc/narou/${identity.workId}/`;
    }
    return `https://${NAROU_HOST}/${identity.workId}/`;
  };
  return {
    id: "narou",
    version: NOVEL_VIEWER_TOC_ADAPTER_VERSION,
    matchUrl(url) {
      const matched = match(url);
      if (!matched) return null;
      const workId = matched[1].toLowerCase();
      const test = url.protocol === "novel-reader-test:";
      return {
        adapterId: "narou",
        adapterVersion: NOVEL_VIEWER_TOC_ADAPTER_VERSION,
        workId,
        canonicalWorkUrl: test
          ? `novel-reader-test://fixture/toc/narou/${workId}/`
          : `https://${NAROU_HOST}/${workId}/`,
        currentEpisodeId: matched[2]
      };
    },
    normalizeWorkUrl,
    validateEpisodeUrl(identity, candidate) {
      const matched = match(candidate);
      return Boolean(matched && matched[1].toLowerCase() === identity.workId && matched[2]);
    },
    buildCurrentDocumentExtractionScript(identity) {
      return currentDocumentSource(NAROU_EXTRACTOR, {
        workId: identity.workId,
        canonicalWorkUrl: normalizeWorkUrl(identity),
        test: identity.canonicalWorkUrl.startsWith("novel-reader-test:")
      });
    },
    buildWorkPageExtractionScript(identity) {
      const canonicalWorkUrl = normalizeWorkUrl(identity);
      return workPageSource(NAROU_EXTRACTOR, {
        workId: identity.workId,
        canonicalWorkUrl,
        test: canonicalWorkUrl.startsWith("novel-reader-test:")
      }, canonicalWorkUrl);
    }
  };
}
