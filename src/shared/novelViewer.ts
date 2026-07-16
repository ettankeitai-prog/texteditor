export type NovelViewerLifecycle =
  | "closed"
  | "creating"
  | "visible"
  | "occluded"
  | "error"
  | "closing";

export type NovelViewerErrorCode =
  | "unsupported-url"
  | "navigation-refused"
  | "load-failed"
  | "offline"
  | "certificate-error"
  | "renderer-crashed"
  | "unresponsive"
  | "reader-state-corrupt"
  | "reader-state-save-failed"
  | "scroll-restore-failed";

export interface NovelViewerErrorState {
  code: NovelViewerErrorCode;
  message: string;
  recoverable: boolean;
}

export interface ReaderScrollState {
  url: string;
  scrollY: number;
  documentHeight: number;
  viewportHeight: number;
  progressRatio: number;
}

export const NOVEL_VIEWER_TOC_WIDTH_DEFAULT = 280;
export const NOVEL_VIEWER_TOC_WIDTH_MIN = 220;
export const NOVEL_VIEWER_TOC_WIDTH_MAX = 420;
export const NOVEL_VIEWER_TOC_RESIZER_WIDTH = 5;
export const NOVEL_VIEWER_TOC_REMOTE_MIN_WIDTH = 320;
export const NOVEL_VIEWER_SPLIT_RATIO_DEFAULT = 0.5;
export const NOVEL_VIEWER_SPLIT_RATIO_MIN = 0.1;
export const NOVEL_VIEWER_SPLIT_RATIO_MAX = 0.9;
export const NOVEL_VIEWER_EDITOR_MIN_WIDTH = 320;
export const NOVEL_VIEWER_PANE_MIN_WIDTH = 480;

export interface NovelViewerUiLayoutUpdate {
  tocWidthPx?: number;
  novelViewerSplitRatio?: number;
}

export interface ReaderState {
  schemaVersion: 1;
  progress: {
    lastReadableUrl?: string;
    title?: string;
    scroll?: ReaderScrollState;
    lastViewedAt?: string;
  };
  ui: {
    wasOpen: boolean;
    preferredPane: "right" | "current";
    tocWidthPx?: number;
    novelViewerSplitRatio?: number;
  };
  favorites: NovelViewerFavorite[];
}

export interface NovelViewerStatus {
  lifecycle: NovelViewerLifecycle;
  isOpen: boolean;
  pendingUrl?: string;
  committedUrl?: string;
  lastReadableUrl?: string;
  title?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  tocWidthPx?: number;
  novelViewerSplitRatio?: number;
  error?: NovelViewerErrorState;
}

export type NovelViewerAdapterId = "kakuyomu" | "narou";

export interface NovelViewerFavorite {
  adapterId: NovelViewerAdapterId;
  workId: string;
  canonicalWorkUrl: string;
  workTitle: string;
  addedAt: string;
}

export interface NovelViewerFavoritesState {
  items: NovelViewerFavorite[];
  supported: boolean;
  currentWorkUrl?: string;
  currentFavorite: boolean;
}

export interface NovelViewerWorkIdentity {
  adapterId: NovelViewerAdapterId;
  adapterVersion: number;
  workId: string;
  canonicalWorkUrl: string;
  currentEpisodeId?: string;
}

export interface NovelViewerTocEpisode {
  episodeId: string;
  order: number;
  title: string;
  canonicalUrl: string;
}

export interface NovelViewerTocSection {
  sectionId?: string;
  order: number;
  title?: string;
  episodes: NovelViewerTocEpisode[];
}

export interface NovelViewerToc {
  schemaVersion: 1;
  adapterId: NovelViewerAdapterId;
  adapterVersion: number;
  workId: string;
  workTitle: string;
  canonicalWorkUrl: string;
  sections: NovelViewerTocSection[];
  fetchedAt: string;
}

export type NovelViewerTocStatus =
  | "closed"
  | "unsupported"
  | "idle"
  | "loading"
  | "ready"
  | "stale"
  | "error";

export type NovelViewerTocErrorCode =
  | "extraction-failed"
  | "invalid-result"
  | "fetch-failed"
  | "too-large";

export interface NovelViewerTocState {
  status: NovelViewerTocStatus;
  panelOpen: boolean;
  supported: boolean;
  adapterId?: NovelViewerAdapterId;
  workId?: string;
  workTitle?: string;
  sections: NovelViewerTocSection[];
  currentEpisodeId?: string;
  cached: boolean;
  stale: boolean;
  fetchedAt?: string;
  canRefresh: boolean;
  error?: {
    code: NovelViewerTocErrorCode;
    message: string;
  };
}

export interface NovelViewerTocEpisodeSelection {
  adapterId: NovelViewerAdapterId;
  workId: string;
  episodeId: string;
}

export interface NovelViewerStartupState {
  shouldRestore: boolean;
  status: NovelViewerStatus;
}

export interface NovelViewerBoundsUpdate {
  layoutRevision: number;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

export type NovelViewerOcclusionReason =
  | "dialog"
  | "context-menu"
  | "editor-search"
  | "global-search"
  | "command-palette"
  | "workspace-import"
  | "toc-panel-narrow"
  | "toc-resize"
  | "main-split-resize";

export interface NovelViewerOcclusionUpdate {
  revision: number;
  reasons: NovelViewerOcclusionReason[];
}

export interface NovelViewerRendererDiagnosticSnapshot {
  pane: {
    isConnected: boolean;
    rect: { x: number; y: number; width: number; height: number };
    offsetWidth: number;
    offsetHeight: number;
    display: string;
    visibility: string;
  };
  slot: {
    isConnected: boolean;
    rect: { x: number; y: number; width: number; height: number };
    offsetWidth: number;
    offsetHeight: number;
    display: string;
    visibility: string;
  };
  open: boolean;
  narrowFallback: boolean;
  splitMode: string;
  occlusionReasons: NovelViewerOcclusionReason[];
  layoutRevision: number;
  nativeViewExpected: boolean;
  placeholderVisible: boolean;
  placeholderText: string;
  title: string;
  url: string;
  lifecycle: NovelViewerLifecycle;
}
