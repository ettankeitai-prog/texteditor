import type { NovelViewerSiteAdapter } from "./types.js";
import { createKakuyomuAdapter } from "./kakuyomu.js";
import { createNarouAdapter } from "./narou.js";

export { createKakuyomuAdapter } from "./kakuyomu.js";
export { createNarouAdapter } from "./narou.js";
export type { NovelViewerRawTocResult, NovelViewerSiteAdapter } from "./types.js";

export function createNovelViewerAdapters(allowTestProtocol = false): NovelViewerSiteAdapter[] {
  return [createKakuyomuAdapter(allowTestProtocol), createNarouAdapter(allowTestProtocol)];
}

export function findNovelViewerAdapter(adapters: readonly NovelViewerSiteAdapter[], url: URL): NovelViewerSiteAdapter | null {
  return adapters.find((adapter) => adapter.matchUrl(url)) ?? null;
}
