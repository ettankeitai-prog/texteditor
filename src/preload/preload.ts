import { contextBridge, ipcRenderer } from "electron";
import {
  AppStateSnapshot,
  BackupMeta,
  GlobalSearchResult,
  ImportTextResult,
  TabDocument,
  TabsIndex,
  WorkspaceState,
  WorkspaceTransferResult
} from "../shared/schema.js";
import type {
  NovelViewerBoundsUpdate,
  NovelViewerOcclusionUpdate,
  NovelViewerRendererDiagnosticSnapshot,
  NovelViewerStartupState,
  NovelViewerStatus,
  NovelViewerTocEpisodeSelection,
  NovelViewerTocState,
  NovelViewerUiLayoutUpdate
} from "../shared/novelViewer.js";

type MenuAction =
  | "new-tab"
  | "new-group"
  | "import-txt"
  | "import-txt-files"
  | "export-txt"
  | "export-all-txt"
  | "export-workspace"
  | "import-workspace"
  | "open-backups"
  | "open-recent"
  | "undo"
  | "redo"
  | "copy-all"
  | "find"
  | "global-search"
  | "replace"
  | "find-next"
  | "find-previous"
  | "toggle-theme"
  | "toggle-locale"
  | "open-settings"
  | "split-right"
  | "close-split"
  | "focus-left"
  | "focus-right"
  | "toggle-novel-viewer"
  | "focus-novel-viewer-address"
  | "close-novel-viewer"
  | "font-up"
  | "font-down"
  | "reload-app";

type ShutdownReason = "close" | "quit" | "reload" | "restart";
type ShutdownResult = { ok: boolean; error?: string };

const api = {
  loadApp: (): Promise<AppStateSnapshot> => ipcRenderer.invoke("app:load"),
  saveWorkspace: (workspace: WorkspaceState): Promise<WorkspaceState> =>
    ipcRenderer.invoke("workspace:save", workspace),
  saveTabsIndex: (index: TabsIndex): Promise<TabsIndex> => ipcRenderer.invoke("tabs:index:save", index),
  loadTab: (id: string): Promise<TabDocument> => ipcRenderer.invoke("tab:load", id),
  saveTab: (tab: TabDocument): Promise<TabDocument> => ipcRenderer.invoke("tab:save", tab),
  deleteTab: (id: string): Promise<TabsIndex> => ipcRenderer.invoke("tab:delete", id),
  createBackup: (tab: TabDocument): Promise<BackupMeta | null> => ipcRenderer.invoke("tab:backup:create", tab),
  listBackups: (id: string): Promise<BackupMeta[]> => ipcRenderer.invoke("tab:backup:list", id),
  listBackupHistory: (): Promise<BackupMeta[]> => ipcRenderer.invoke("tab:backup:listAll"),
  loadBackup: (id: string, fileName: string): Promise<TabDocument> => ipcRenderer.invoke("tab:backup:load", id, fileName),
  acknowledgeRecovery: (restore: boolean): Promise<void> => ipcRenderer.invoke("app:recovery:ack", restore),
  quitApp: (): Promise<boolean> => ipcRenderer.invoke("app:quit"),
  reloadApp: (): Promise<boolean> => ipcRenderer.invoke("app:request-reload"),
  restartApp: (): Promise<boolean> => ipcRenderer.invoke("app:request-restart"),
  onBeforeClose: (callback: (reason: ShutdownReason) => Promise<ShutdownResult>): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: { id?: string; reason?: ShutdownReason }): void => {
      if (typeof request?.id !== "string" || !request.reason || !["close", "quit", "reload", "restart"].includes(request.reason)) {
        return;
      }
      void callback(request.reason).then(
        (result) => ipcRenderer.send("app:shutdown-response", {
          id: request.id,
          ok: result?.ok === true,
          error: typeof result?.error === "string" ? result.error : undefined
        }),
        (error: unknown) => ipcRenderer.send("app:shutdown-response", {
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : "Save failed"
        })
      );
    };
    ipcRenderer.on("app:shutdown-request", listener);
    ipcRenderer.send("app:shutdown-handler-ready");
    return () => ipcRenderer.removeListener("app:shutdown-request", listener);
  },
  exportTxt: (tab: TabDocument): Promise<{ canceled: boolean; filePath?: string }> =>
    ipcRenderer.invoke("tab:exportTxt", tab),
  exportAllTxt: (): Promise<{ canceled: boolean; filePath?: string }> => ipcRenderer.invoke("tabs:exportAllTxt"),
  importTxt: (multiple: boolean): Promise<ImportTextResult> => ipcRenderer.invoke("txt:import", multiple),
  searchAllTabs: (query: string): Promise<GlobalSearchResult[]> => ipcRenderer.invoke("tabs:search", query),
  exportWorkspace: (): Promise<WorkspaceTransferResult> => ipcRenderer.invoke("workspace:export"),
  importWorkspace: async (): Promise<WorkspaceTransferResult> => {
    const result = (await ipcRenderer.invoke("workspace:import")) as WorkspaceTransferResult;
    if (!result.canceled) {
      const rendererGlobal = globalThis as unknown as {
        CustomEvent: new (type: string) => unknown;
        dispatchEvent: (event: unknown) => boolean;
      };
      rendererGlobal.dispatchEvent(new rendererGlobal.CustomEvent("texteditor:workspace-imported"));
    }
    return result;
  },
  writeClipboardText: (text: string): Promise<void> => ipcRenderer.invoke("clipboard:writeText", text),
  remoteInboxStatus: (): Promise<{ state: "stopped" | "running" | "error"; message?: string; url?: string }> => ipcRenderer.invoke("remote-inbox:status"),
  onRemoteInboxAppend: (callback: (request: { id: string; text: string; includeTimestamp: boolean; targetTabName: string }) => Promise<void>): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: { id: string; text: string; includeTimestamp: boolean; targetTabName: string }): void => {
      void callback(request).then(() => ipcRenderer.send("remote-inbox:append-result", { id: request.id, ok: true }), (error: unknown) => ipcRenderer.send("remote-inbox:append-result", { id: request.id, ok: false, error: error instanceof Error ? error.message : "Save failed" }));
    };
    ipcRenderer.on("remote-inbox:append-request", listener);
    return () => ipcRenderer.removeListener("remote-inbox:append-request", listener);
  },
  auditRemoteInboxPcClear: (payload: { tabId: string; targetTabName: string; revision: number; beforeCharacters: number }): Promise<void> => ipcRenderer.invoke("remote-inbox:pc-clear-audit", payload),
  onRemoteInboxMutate: (callback: (request: { id: string; operation: "replace" | "clear"; targetTabName: string; content: string; revision: number }) => Promise<{ ok: true; tabId: string; content: string; revision: number; updatedAt: string; beforeCharacters: number } | { ok: false; error: string; conflict?: boolean; tabId?: string; revision?: number; updatedAt?: string }>): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: { id: string; operation: "replace" | "clear"; targetTabName: string; content: string; revision: number }): void => {
      void callback(request).then((result) => ipcRenderer.send("remote-inbox:mutate-result", { id: request.id, ...result }), (error: unknown) => ipcRenderer.send("remote-inbox:mutate-result", { id: request.id, ok: false, error: error instanceof Error ? error.message : "Save failed" }));
    };
    ipcRenderer.on("remote-inbox:mutate-request", listener);
    return () => ipcRenderer.removeListener("remote-inbox:mutate-request", listener);
  },
  onMenuAction: (callback: (action: MenuAction) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: MenuAction): void => callback(action);
    ipcRenderer.on("menu:action", listener);
    return () => ipcRenderer.removeListener("menu:action", listener);
  },
  initializeNovelViewer: (restoreAllowed: boolean): Promise<NovelViewerStartupState> =>
    ipcRenderer.invoke("novel-viewer:initialize", restoreAllowed),
  openNovelViewer: (): Promise<NovelViewerStatus> => ipcRenderer.invoke("novel-viewer:open"),
  closeNovelViewer: (): Promise<NovelViewerStatus> => ipcRenderer.invoke("novel-viewer:close"),
  navigateNovelViewer: (url: string): Promise<NovelViewerStatus> => ipcRenderer.invoke("novel-viewer:navigate", url),
  goBackNovelViewer: (): Promise<NovelViewerStatus> => ipcRenderer.invoke("novel-viewer:back"),
  goForwardNovelViewer: (): Promise<NovelViewerStatus> => ipcRenderer.invoke("novel-viewer:forward"),
  reloadOrStopNovelViewer: (): Promise<NovelViewerStatus> => ipcRenderer.invoke("novel-viewer:reload-or-stop"),
  openNovelViewerExternal: (): Promise<boolean> => ipcRenderer.invoke("novel-viewer:open-external"),
  updateNovelViewerBounds: (update: NovelViewerBoundsUpdate): Promise<void> => ipcRenderer.invoke("novel-viewer:bounds", update),
  setNovelViewerOcclusion: (update: NovelViewerOcclusionUpdate): Promise<void> => ipcRenderer.invoke("novel-viewer:occlusion", update),
  focusNovelViewerRemote: (): Promise<void> => ipcRenderer.invoke("novel-viewer:focus-remote"),
  openNovelViewerToc: (): Promise<NovelViewerTocState> => ipcRenderer.invoke("novel-viewer:toc-open"),
  closeNovelViewerToc: (): Promise<NovelViewerTocState> => ipcRenderer.invoke("novel-viewer:toc-close"),
  refreshNovelViewerToc: (): Promise<NovelViewerTocState> => ipcRenderer.invoke("novel-viewer:toc-refresh"),
  selectNovelViewerTocEpisode: (selection: NovelViewerTocEpisodeSelection): Promise<NovelViewerStatus> =>
    ipcRenderer.invoke("novel-viewer:toc-select-episode", selection),
  updateNovelViewerUiLayout: (update: NovelViewerUiLayoutUpdate): Promise<NovelViewerStatus> =>
    ipcRenderer.invoke("novel-viewer:update-ui-layout", update),
  onNovelViewerState: (callback: (status: NovelViewerStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: NovelViewerStatus): void => callback(status);
    ipcRenderer.on("novel-viewer:state", listener);
    return () => ipcRenderer.removeListener("novel-viewer:state", listener);
  },
  onNovelViewerTocState: (callback: (state: NovelViewerTocState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: NovelViewerTocState): void => callback(state);
    ipcRenderer.on("novel-viewer:toc-state", listener);
    return () => ipcRenderer.removeListener("novel-viewer:toc-state", listener);
  },
  onNovelViewerFocusAddress: (callback: () => void): (() => void) => {
    const listener = (): void => callback();
    ipcRenderer.on("novel-viewer:focus-address", listener);
    return () => ipcRenderer.removeListener("novel-viewer:focus-address", listener);
  },
  onNovelViewerRequestClose: (callback: () => void): (() => void) => {
    const listener = (): void => callback();
    ipcRenderer.on("novel-viewer:request-close", listener);
    return () => ipcRenderer.removeListener("novel-viewer:request-close", listener);
  },
  onNovelViewerScrollRestoreWarning: (callback: () => void): (() => void) => {
    const listener = (): void => callback();
    ipcRenderer.on("novel-viewer:scroll-restore-warning", listener);
    return () => ipcRenderer.removeListener("novel-viewer:scroll-restore-warning", listener);
  },
  onNovelViewerRequestBounds: (callback: () => void): (() => void) => {
    const listener = (): void => callback();
    ipcRenderer.on("novel-viewer:request-bounds", listener);
    return () => ipcRenderer.removeListener("novel-viewer:request-bounds", listener);
  },
  submitNovelViewerDiagnosticSnapshot: (reason: string, snapshot: NovelViewerRendererDiagnosticSnapshot): Promise<void> =>
    ipcRenderer.invoke("novel-viewer:diagnostic-renderer-snapshot", reason, snapshot),
  onNovelViewerRequestDiagnosticSnapshot: (callback: (reason: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, reason: string): void => callback(reason);
    ipcRenderer.on("novel-viewer:request-diagnostic-snapshot", listener);
    return () => ipcRenderer.removeListener("novel-viewer:request-diagnostic-snapshot", listener);
  }
};

contextBridge.exposeInMainWorld("textEditor", api);

export type TextEditorApi = typeof api;
