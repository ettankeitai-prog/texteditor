import type { NovelViewerAdapterId, NovelViewerFavorite } from "./novelViewer.js";

export const NOVEL_VIEWER_FAVORITES_MAX = 100;

export interface NovelViewerWorkReference {
  adapterId: NovelViewerAdapterId;
  workId: string;
  canonicalWorkUrl: string;
}

const KAKUYOMU_PATH = /^\/works\/([A-Za-z0-9_-]{1,128})(?:\/episodes\/[A-Za-z0-9_-]{1,128})?\/?$/;
const KAKUYOMU_TEST_PATH = /^\/toc\/kakuyomu\/works\/([A-Za-z0-9_-]{1,128})(?:\/episodes\/[A-Za-z0-9_-]{1,128})?\/?$/;
const NAROU_PATH = /^\/([Nn][0-9]{4}[A-Za-z]{2})(?:\/(?:[0-9]{1,12}\/?|))?$/;
const NAROU_TEST_PATH = /^\/toc\/narou\/([Nn][0-9]{4}[A-Za-z]{2})(?:\/(?:[0-9]{1,12}\/?|))?$/;

function safeUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.username || url.password ? null : url;
  } catch {
    return null;
  }
}

export function normalizeNovelViewerWorkUrl(
  value: unknown,
  options: { allowTestProtocol?: boolean } = {}
): NovelViewerWorkReference | null {
  const url = safeUrl(value);
  if (!url || url.port) return null;

  if (url.protocol === "https:" && url.hostname === "kakuyomu.jp") {
    const matched = KAKUYOMU_PATH.exec(url.pathname);
    if (!matched) return null;
    return {
      adapterId: "kakuyomu",
      workId: matched[1],
      canonicalWorkUrl: `https://kakuyomu.jp/works/${matched[1]}`
    };
  }

  if (url.protocol === "https:" && url.hostname === "ncode.syosetu.com") {
    const matched = NAROU_PATH.exec(url.pathname);
    if (!matched) return null;
    const workId = matched[1].toLowerCase();
    return {
      adapterId: "narou",
      workId,
      canonicalWorkUrl: `https://ncode.syosetu.com/${workId}/`
    };
  }

  if (options.allowTestProtocol && url.protocol === "novel-reader-test:" && url.hostname === "fixture") {
    const kakuyomu = KAKUYOMU_TEST_PATH.exec(url.pathname);
    if (kakuyomu) {
      return {
        adapterId: "kakuyomu",
        workId: kakuyomu[1],
        canonicalWorkUrl: `novel-reader-test://fixture/toc/kakuyomu/works/${kakuyomu[1]}`
      };
    }
    const narou = NAROU_TEST_PATH.exec(url.pathname);
    if (narou) {
      const workId = narou[1].toLowerCase();
      return {
        adapterId: "narou",
        workId,
        canonicalWorkUrl: `novel-reader-test://fixture/toc/narou/${workId}/`
      };
    }
  }

  return null;
}

function cleanTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 300) : null;
}

export function normalizeNovelViewerFavorite(
  value: unknown,
  options: { allowTestProtocol?: boolean } = {}
): NovelViewerFavorite | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const work = normalizeNovelViewerWorkUrl(candidate.canonicalWorkUrl, options);
  const title = cleanTitle(candidate.workTitle);
  if (!work || candidate.adapterId !== work.adapterId || candidate.workId !== work.workId || !title) return null;
  if (typeof candidate.addedAt !== "string" || candidate.addedAt.length > 64 || !Number.isFinite(Date.parse(candidate.addedAt))) {
    return null;
  }
  return {
    adapterId: work.adapterId,
    workId: work.workId,
    canonicalWorkUrl: work.canonicalWorkUrl,
    workTitle: title,
    addedAt: new Date(candidate.addedAt).toISOString()
  };
}

export function normalizeNovelViewerFavorites(
  value: unknown,
  options: { allowTestProtocol?: boolean } = {}
): NovelViewerFavorite[] {
  if (!Array.isArray(value)) return [];
  const result: NovelViewerFavorite[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const favorite = normalizeNovelViewerFavorite(entry, options);
    if (!favorite || seen.has(favorite.canonicalWorkUrl)) continue;
    seen.add(favorite.canonicalWorkUrl);
    result.push(favorite);
    if (result.length >= NOVEL_VIEWER_FAVORITES_MAX) break;
  }
  return result;
}

export function addNovelViewerFavorite(
  favorites: readonly NovelViewerFavorite[],
  favorite: NovelViewerFavorite
): NovelViewerFavorite[] {
  const normalized = normalizeNovelViewerFavorite(favorite, { allowTestProtocol: true });
  if (!normalized) return [...favorites];
  return [
    normalized,
    ...favorites.filter((entry) => entry.canonicalWorkUrl !== normalized.canonicalWorkUrl)
  ].slice(0, NOVEL_VIEWER_FAVORITES_MAX);
}

export function removeNovelViewerFavorite(
  favorites: readonly NovelViewerFavorite[],
  canonicalWorkUrl: string
): NovelViewerFavorite[] {
  return favorites.filter((entry) => entry.canonicalWorkUrl !== canonicalWorkUrl);
}
