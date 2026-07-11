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
  | "font-up"
  | "font-down";

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
  quitApp: (): Promise<void> => ipcRenderer.invoke("app:quit"),
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
  onMenuAction: (callback: (action: MenuAction) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: MenuAction): void => callback(action);
    ipcRenderer.on("menu:action", listener);
    return () => ipcRenderer.removeListener("menu:action", listener);
  }
};

contextBridge.exposeInMainWorld("textEditor", api);

export type TextEditorApi = typeof api;
