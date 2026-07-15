import type { NovelViewerWorkIdentity } from "../../../shared/novelViewer.js";
import {
  NOVEL_VIEWER_TOC_ADAPTER_VERSION,
  currentDocumentSource,
  workPageSource,
  type NovelViewerSiteAdapter
} from "./types.js";

const KAKUYOMU_HOST = "kakuyomu.jp";
const PRODUCTION_PATH = /^\/works\/([A-Za-z0-9_-]{1,128})(?:\/episodes\/([A-Za-z0-9_-]{1,128}))?\/?$/;
const TEST_PATH = /^\/toc\/kakuyomu\/works\/([A-Za-z0-9_-]{1,128})(?:\/episodes\/([A-Za-z0-9_-]{1,128}))?\/?$/;

const KAKUYOMU_EXTRACTOR = `(root, config) => {
  const normalize = (value) => String(value || "").replace(/[\\u0000-\\u001f\\u007f]/g, " ").replace(/\\s+/g, " ").trim();
  const episodePattern = config.test
    ? /^\\/toc\\/kakuyomu\\/works\\/([^/]+)\\/episodes\\/([^/?#]+)\\/?$/
    : /^\\/works\\/([^/]+)\\/episodes\\/([^/?#]+)\\/?$/;
  const allAnchors = Array.from(root.querySelectorAll("a[href]"));
  const tocAnchors = Array.from(root.querySelectorAll('a[class*="WorkTocSection_link__"][href]'));
  const sectionTitleByAnchor = new Map();
  for (const heading of Array.from(root.querySelectorAll("h2"))) {
    let container = heading.parentElement;
    for (let depth = 0; container && depth < 5; depth += 1, container = container.parentElement) {
      const links = Array.from(container.querySelectorAll("a[href]")).filter((link) => {
        try {
          const parsed = new URL(link.getAttribute("href") || "", config.canonicalWorkUrl);
          const matched = episodePattern.exec(parsed.pathname);
          return Boolean(matched && matched[1] === config.workId);
        } catch {
          return false;
        }
      });
      if (links.length > 0) {
        const title = normalize(heading.textContent);
        for (const link of links) sectionTitleByAnchor.set(link, title || undefined);
        break;
      }
    }
  }
  const mappedAnchors = allAnchors.filter((anchor) => sectionTitleByAnchor.has(anchor));
  const candidates = tocAnchors.length ? tocAnchors : mappedAnchors.length ? mappedAnchors : allAnchors;
  const sections = [];
  const sectionIndexes = new Map();
  const seen = new Set();
  for (const anchor of candidates) {
    let parsed;
    try {
      parsed = new URL(anchor.getAttribute("href") || "", config.canonicalWorkUrl);
    } catch {
      continue;
    }
    const matched = episodePattern.exec(parsed.pathname);
    if (!matched || matched[1] !== config.workId || seen.has(matched[2])) continue;
    const titleNode = anchor.querySelector('[class*="WorkTocSection_title__"]');
    const title = normalize(titleNode?.textContent || anchor.textContent);
    if (!title) continue;
    seen.add(matched[2]);
    const sectionTitle = sectionTitleByAnchor.get(anchor);
    const sectionKey = sectionTitle || "";
    let sectionIndex = sectionIndexes.get(sectionKey);
    if (sectionIndex === undefined) {
      sectionIndex = sections.length;
      sectionIndexes.set(sectionKey, sectionIndex);
      sections.push({ title: sectionTitle, episodes: [] });
    }
    sections[sectionIndex].episodes.push({
      episodeId: matched[2],
      title,
      canonicalUrl: parsed.href
    });
  }
  const workLink = Array.from(root.querySelectorAll("h1 a[href]")).find((link) => {
    try {
      const parsed = new URL(link.getAttribute("href") || "", config.canonicalWorkUrl);
      return parsed.pathname.replace(/\\/$/, "") === new URL(config.canonicalWorkUrl).pathname.replace(/\\/$/, "");
    } catch {
      return false;
    }
  });
  const metaTitle = root.querySelector('meta[property="og:title"]')?.getAttribute("content") || "";
  const workTitle = normalize(workLink?.getAttribute("title") || workLink?.textContent || metaTitle.split(" - ").pop());
  return {
    complete: seen.size > 0 && (config.workPage || tocAnchors.length > 0),
    workTitle,
    sections
  };
}`;

export function createKakuyomuAdapter(allowTestProtocol = false): NovelViewerSiteAdapter {
  const match = (url: URL): RegExpExecArray | null => {
    if (url.protocol === "https:" && url.hostname === KAKUYOMU_HOST && !url.port) {
      return PRODUCTION_PATH.exec(url.pathname);
    }
    if (allowTestProtocol && url.protocol === "novel-reader-test:" && url.hostname === "fixture") {
      return TEST_PATH.exec(url.pathname);
    }
    return null;
  };
  const normalizeWorkUrl = (identity: NovelViewerWorkIdentity): string => {
    if (identity.canonicalWorkUrl.startsWith("novel-reader-test:")) {
      return `novel-reader-test://fixture/toc/kakuyomu/works/${identity.workId}`;
    }
    return `https://${KAKUYOMU_HOST}/works/${identity.workId}`;
  };
  return {
    id: "kakuyomu",
    version: NOVEL_VIEWER_TOC_ADAPTER_VERSION,
    matchUrl(url) {
      const matched = match(url);
      if (!matched) return null;
      const test = url.protocol === "novel-reader-test:";
      const workId = matched[1];
      return {
        adapterId: "kakuyomu",
        adapterVersion: NOVEL_VIEWER_TOC_ADAPTER_VERSION,
        workId,
        canonicalWorkUrl: test
          ? `novel-reader-test://fixture/toc/kakuyomu/works/${workId}`
          : `https://${KAKUYOMU_HOST}/works/${workId}`,
        currentEpisodeId: matched[2]
      };
    },
    normalizeWorkUrl,
    validateEpisodeUrl(identity, candidate) {
      const matched = match(candidate);
      return Boolean(matched && matched[1] === identity.workId && matched[2]);
    },
    buildCurrentDocumentExtractionScript(identity) {
      return currentDocumentSource(KAKUYOMU_EXTRACTOR, {
        workId: identity.workId,
        canonicalWorkUrl: normalizeWorkUrl(identity),
        test: identity.canonicalWorkUrl.startsWith("novel-reader-test:"),
        workPage: false
      });
    },
    buildWorkPageExtractionScript(identity) {
      const canonicalWorkUrl = normalizeWorkUrl(identity);
      return workPageSource(KAKUYOMU_EXTRACTOR, {
        workId: identity.workId,
        canonicalWorkUrl,
        test: canonicalWorkUrl.startsWith("novel-reader-test:"),
        workPage: true
      }, canonicalWorkUrl);
    }
  };
}
