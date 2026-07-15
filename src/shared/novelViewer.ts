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
  };
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
  error?: NovelViewerErrorState;
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
  | "workspace-import";

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
