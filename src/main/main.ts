import AdmZip from "adm-zip";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, protocol } from "electron";
import type { OpenDialogOptions } from "electron";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  AppStateSnapshot,
  BackupMeta,
  GlobalSearchResult,
  ImportTextResult,
  Locale,
  MAIN_CHILD_TAB_TITLE,
  NewTabTemplateId,
  RecoveryState,
  TabDocument,
  TabsIndex,
  WorkspaceArchiveVersion,
  WorkspaceLayout,
  WorkspaceState,
  WorkspaceTransferResult,
  countWords,
  defaultWorkspace,
  emptyTabsIndex,
  getActiveChildTab,
  getChildTabs,
  groupTitleForTab,
  getMainChildTab,
  normalizeTabDocument,
  normalizeTabsIndex
} from "../shared/schema.js";
import { RemoteInboxServer, type RemoteInboxMutationResult, type RemoteInboxStatus } from "./remoteInbox.js";
import { NovelViewerController } from "./novelViewerController.js";
import {
  NovelViewerDiagnostics,
  shouldEnableNovelViewerDiagnostics,
  shouldShowNovelViewerDiagnosticMenu
} from "./novelViewerDiagnostics.js";
import { ReaderStateStore } from "./readerState.js";
import type {
  NovelViewerBoundsUpdate,
  NovelViewerOcclusionUpdate,
  NovelViewerRendererDiagnosticSnapshot,
  NovelViewerStartupState,
  NovelViewerStatus
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
type ShutdownResponse = { ok: boolean; error?: string };
type WorkspacePersistenceState = "ready" | "importing" | "restart-required" | "shutting-down";

app.setName("texteditor");
if (!app.isPackaged && process.env.TEXTEDITOR_NOVEL_VIEWER_TEST_MODE === "1") {
  protocol.registerSchemesAsPrivileged([{
    scheme: "novel-reader-test",
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  }]);
}

let currentLocale: Locale = "en";
let startupRecoveryState: RecoveryState = { abnormalShutdown: false };
let remoteInboxStatus: RemoteInboxStatus = { state: "stopped" };
let remoteInboxSettings = defaultWorkspace.remoteInbox;
let workspacePersistenceState: WorkspacePersistenceState = "ready";
let persistenceMutationTail: Promise<void> = Promise.resolve();
let remoteConfigurationTail: Promise<void> = Promise.resolve();
let jsonWriteSequence = 0;
let allowAppQuit = false;
let cleanShutdownApproved = false;
let activeLifecycleAction: { reason: ShutdownReason; promise: Promise<boolean> } | null = null;
let novelViewerController: NovelViewerController | null = null;
const windowsAllowedToClose = new WeakSet<BrowserWindow>();
const shutdownReadyWebContents = new Set<number>();
const loadedAppStateWebContents = new Set<number>();
const pendingShutdownRequests = new Map<string, {
  webContentsId: number;
  resolve: (value: ShutdownResponse) => void;
  timer: NodeJS.Timeout;
}>();
const jsonWriteQueues = new Map<string, Promise<void>>();
const pendingRemoteAppends = new Map<string, { resolve: (value: { ok: boolean; error?: string }) => void; timer: NodeJS.Timeout }>();
const pendingRemoteMutations = new Map<string, { resolve: (value: RemoteInboxMutationResult) => void; timer: NodeJS.Timeout }>();

const menuLabels: Record<
  Locale,
  {
    file: string;
    newTab: string;
    newGroup: string;
    importTxt: string;
    importTxtFiles: string;
    exportTxt: string;
    exportAllTxt: string;
    exportWorkspace: string;
    importWorkspace: string;
    backups: string;
    openRecent: string;
    edit: string;
    undo: string;
    redo: string;
    copyAll: string;
    find: string;
    globalSearch: string;
    replace: string;
    findNext: string;
    findPrevious: string;
    view: string;
    toggleTheme: string;
    toggleLocale: string;
    settings: string;
    splitRight: string;
    closeSplit: string;
    focusLeft: string;
    focusRight: string;
    novelViewer: string;
    focusNovelViewerAddress: string;
    closeNovelViewer: string;
    dumpNovelViewerState: string;
    bringNovelViewerToFront: string;
    fontSizeUp: string;
    fontSizeDown: string;
    reload: string;
    window: string;
  }
> = {
  en: {
    file: "File",
    newTab: "New Tab",
    newGroup: "New Group",
    importTxt: "Import TXT...",
    importTxtFiles: "Import TXT Files...",
    exportTxt: "Export TXT",
    exportAllTxt: "Export All TXT",
    exportWorkspace: "Export Workspace...",
    importWorkspace: "Import Workspace...",
    backups: "Backups",
    openRecent: "Open Recent / Closed",
    edit: "Edit",
    undo: "Undo",
    redo: "Redo",
    copyAll: "Copy All",
    find: "Find",
    globalSearch: "Find in Workspace",
    replace: "Replace",
    findNext: "Find Next",
    findPrevious: "Find Previous",
    view: "View",
    toggleTheme: "Toggle Theme",
    toggleLocale: "Switch to Japanese",
    settings: "Settings...",
    splitRight: "Split Right",
    closeSplit: "Close Split",
    focusLeft: "Focus Left Editor",
    focusRight: "Focus Right Editor",
    novelViewer: "Novel Viewer",
    focusNovelViewerAddress: "Focus Novel Viewer URL",
    closeNovelViewer: "Close Novel Viewer",
    dumpNovelViewerState: "Dump Novel Viewer State",
    bringNovelViewerToFront: "Bring Novel Viewer To Front",
    fontSizeUp: "Font Size Up",
    fontSizeDown: "Font Size Down",
    reload: "Reload",
    window: "Window"
  },
  jp: {
    file: "ファイル",
    newTab: "新規タブ",
    newGroup: "新規グループ",
    importTxt: "TXT を読み込み...",
    importTxtFiles: "複数 TXT を読み込み...",
    exportTxt: "TXT 出力",
    exportAllTxt: "全タブ TXT 出力",
    exportWorkspace: "Workspace をエクスポート...",
    importWorkspace: "Workspace をインポート...",
    backups: "バックアップ",
    openRecent: "最近閉じたタブ",
    edit: "編集",
    undo: "元に戻す",
    redo: "やり直し",
    copyAll: "本文をすべてコピー",
    find: "検索",
    globalSearch: "Workspace 全体検索",
    replace: "置換",
    findNext: "次を検索",
    findPrevious: "前を検索",
    view: "表示",
    toggleTheme: "テーマ切替",
    toggleLocale: "英語に切替",
    settings: "設定...",
    splitRight: "右に分割",
    closeSplit: "分割を閉じる",
    focusLeft: "左エディタへフォーカス",
    focusRight: "右エディタへフォーカス",
    novelViewer: "Novel Viewer",
    focusNovelViewerAddress: "Novel ViewerのURL欄へフォーカス",
    closeNovelViewer: "Novel Viewerを閉じる",
    dumpNovelViewerState: "Novel Viewer状態を診断ログへ出力",
    bringNovelViewerToFront: "Novel Viewerを診断用に最前面へ移動",
    fontSizeUp: "フォントサイズを大きく",
    fontSizeDown: "フォントサイズを小さく",
    reload: "再読み込み",
    window: "ウィンドウ"
  }
};

if (process.env.TEXTEDITOR_USER_DATA) {
  app.setPath("userData", process.env.TEXTEDITOR_USER_DATA);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

function dataRoot(): string {
  return path.join(app.getPath("userData"), "data");
}

function localIsoWithOffset(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absolute = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function workspacePath(): string {
  return path.join(dataRoot(), "workspace.json");
}

function sessionPath(): string {
  return path.join(dataRoot(), "session.json");
}

function readerStatePath(): string {
  return path.join(app.getPath("userData"), "reader", "state.json");
}

function novelViewerDebugLogPath(): string {
  return path.join(app.getPath("userData"), "reader", "novel-viewer-debug.log");
}

function tabsRoot(): string {
  return path.join(dataRoot(), "tabs");
}

function backupsRoot(): string {
  return path.join(dataRoot(), "backups");
}

function tabsIndexPath(): string {
  return path.join(tabsRoot(), "index.json");
}

function assertTabId(id: string): void {
  if (!/^tab-[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid tab id: ${id}`);
  }
}

function tabPath(id: string): string {
  assertTabId(id);
  return path.join(tabsRoot(), `${id}.json`);
}

function tabBackupRoot(id: string): string {
  assertTabId(id);
  return path.join(backupsRoot(), id);
}

function assertBackupFileName(fileName: string): void {
  if (!/^\d{8}-\d{6}(?:-\d+)?\.json$/.test(fileName)) {
    throw new Error(`Invalid backup file: ${fileName}`);
  }
}

function backupPath(id: string, fileName: string): string {
  assertBackupFileName(fileName);
  return path.join(tabBackupRoot(id), fileName);
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return fallback;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read JSON file "${filePath}": ${reason}`);
  }
}

function requireJsonObject(value: unknown, filePath: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid JSON object in "${filePath}".`);
  }
  return value as Record<string, unknown>;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  const queueKey = path.resolve(filePath);
  const previous = jsonWriteQueues.get(queueKey) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${++jsonWriteSequence}`;
    try {
      await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      await rename(tempPath, filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  });
  jsonWriteQueues.set(queueKey, operation);
  try {
    await operation;
  } finally {
    if (jsonWriteQueues.get(queueKey) === operation) {
      jsonWriteQueues.delete(queueKey);
    }
  }
}

function assertWorkspaceWritable(): void {
  if (workspacePersistenceState !== "ready") {
    if (workspacePersistenceState === "importing") {
      throw new Error("Workspace import is in progress.");
    }
    if (workspacePersistenceState === "shutting-down") {
      throw new Error("The app is shutting down. No new data was accepted.");
    }
    throw new Error("Workspace import completed. Restart the app before making more changes.");
  }
}

function isWorkspaceImporting(): boolean {
  return workspacePersistenceState === "importing";
}

function assertRendererStateLoaded(webContentsId: number): void {
  if (!loadedAppStateWebContents.has(webContentsId)) {
    throw new Error("The workspace is still loading. No data was saved.");
  }
}

function assertTrustedEditorSender(event: Electron.IpcMainInvokeEvent): NovelViewerController {
  const window = BrowserWindow.fromWebContents(event.sender);
  const expectedUrl = pathToFileURL(path.join(__dirname, "../renderer/index.html")).href;
  if (
    !window ||
    window.webContents !== event.sender ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== expectedUrl ||
    !novelViewerController ||
    !novelViewerController.belongsToWindow(window)
  ) {
    throw new Error("Novel Viewer IPC is only available to the trusted editor frame.");
  }
  return novelViewerController;
}

function enqueuePersistenceMutation<T>(operation: () => Promise<T>): Promise<T> {
  assertWorkspaceWritable();
  const result = persistenceMutationTail.then(operation, operation);
  persistenceMutationTail = result.then(() => undefined, () => undefined);
  return result;
}

async function waitForPersistenceIdle(): Promise<void> {
  await persistenceMutationTail;
  while (jsonWriteQueues.size > 0) {
    await Promise.allSettled([...jsonWriteQueues.values()]);
  }
}

async function ensureDataFiles(): Promise<void> {
  await mkdir(tabsRoot(), { recursive: true });
  await mkdir(backupsRoot(), { recursive: true });
  if (!existsSync(workspacePath())) {
    await writeJson(workspacePath(), defaultWorkspace);
  }
  if (!existsSync(tabsIndexPath())) {
    await writeJson(tabsIndexPath(), emptyTabsIndex);
  }
}

function normalizeRecoveryState(input: Partial<RecoveryState> | null): RecoveryState {
  return {
    abnormalShutdown: Boolean(input?.abnormalShutdown),
    startedAt: typeof input?.startedAt === "string" ? input.startedAt : undefined,
    lastShutdownAt: typeof input?.lastShutdownAt === "string" ? input.lastShutdownAt : undefined
  };
}

async function loadRecoveryState(): Promise<RecoveryState> {
  return normalizeRecoveryState(await readJson<Partial<RecoveryState> | null>(sessionPath(), null));
}

async function markSessionStarted(): Promise<RecoveryState> {
  const previous = await loadRecoveryState();
  const recovery: RecoveryState = {
    abnormalShutdown: previous.abnormalShutdown,
    startedAt: previous.startedAt,
    lastShutdownAt: previous.lastShutdownAt
  };
  await writeJson(sessionPath(), {
    abnormalShutdown: true,
    startedAt: new Date().toISOString(),
    lastShutdownAt: previous.lastShutdownAt
  });
  return recovery;
}

function markSessionCleanSync(): void {
  const tempPath = `${sessionPath()}.tmp-${process.pid}-${Date.now()}-${++jsonWriteSequence}`;
  try {
    mkdirSync(dataRoot(), { recursive: true });
    writeFileSync(
      tempPath,
      `${JSON.stringify(
        {
          abnormalShutdown: false,
          lastShutdownAt: new Date().toISOString()
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    renameSync(tempPath, sessionPath());
  } catch (error) {
    console.error("Failed to mark clean shutdown:", error);
  } finally {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Best effort cleanup during shutdown.
    }
  }
}

function normalizeWorkspace(input: Partial<WorkspaceState>): WorkspaceState {
  const inputLayout = input.layout;
  const defaultLayout = defaultWorkspace.layout;
  const normalizedLayout: WorkspaceLayout = {
    splitMode: inputLayout?.splitMode === "vertical" ? "vertical" : "single",
    activePaneId: inputLayout?.activePaneId === "right" ? "right" : "left",
    panes: defaultLayout.panes.map((pane) => {
      const inputPane = Array.isArray(inputLayout?.panes)
        ? inputLayout.panes.find((entry) => entry.id === pane.id)
        : undefined;
      return {
        id: pane.id,
        activeTabId: typeof inputPane?.activeTabId === "string" ? inputPane.activeTabId : null,
        activeChildTabId: typeof inputPane?.activeChildTabId === "string" ? inputPane.activeChildTabId : "main"
      };
    }),
    splitRatio: Math.min(0.8, Math.max(0.2, typeof inputLayout?.splitRatio === "number" ? inputLayout.splitRatio : defaultLayout.splitRatio))
  };

  return {
    ...defaultWorkspace,
    ...input,
    activeTabId: input.activeTabId ?? null,
    openedTabIds: Array.isArray(input.openedTabIds) ? input.openedTabIds : [],
    recentTabIds: Array.isArray(input.recentTabIds) ? input.recentTabIds : [],
    expandedIds: Array.isArray(input.expandedIds) ? input.expandedIds : defaultWorkspace.expandedIds,
    theme: input.theme === "light" ? "light" : "dark",
    locale: input.locale === "jp" ? "jp" : "en",
    fontSize: typeof input.fontSize === "number" ? input.fontSize : defaultWorkspace.fontSize,
    sidebarWidth: Math.min(420, Math.max(160, typeof input.sidebarWidth === "number" ? input.sidebarWidth : defaultWorkspace.sidebarWidth)),
    autoContinueLists: typeof input.autoContinueLists === "boolean" ? input.autoContinueLists : defaultWorkspace.autoContinueLists,
    newTabTemplate: normalizeNewTabTemplate(input.newTabTemplate),
    templates: {
      ...defaultWorkspace.templates,
      ...(input.templates && typeof input.templates === "object" ? input.templates : {}),
      custom: normalizeCustomTemplate(input.templates?.custom)
    },
    remoteInbox: {
      ...defaultWorkspace.remoteInbox,
      ...(input.remoteInbox && typeof input.remoteInbox === "object" ? input.remoteInbox : {}),
      enabled: Boolean(input.remoteInbox?.enabled),
      port: Number.isInteger(input.remoteInbox?.port) && (input.remoteInbox?.port ?? 0) >= 1024 && (input.remoteInbox?.port ?? 0) <= 65535 ? input.remoteInbox!.port : defaultWorkspace.remoteInbox.port,
      targetTabName: normalizeRemoteInboxTargetName(input.remoteInbox?.targetTabName),
      targetTabNames: normalizeRemoteInboxTargetNames(input.remoteInbox?.targetTabNames, typeof input.remoteInbox?.targetTabName === "string" ? input.remoteInbox.targetTabName : defaultWorkspace.remoteInbox.targetTabName),
      remoteReadableTabIds: Array.isArray(input.remoteInbox?.remoteReadableTabIds) ? [...new Set(input.remoteInbox.remoteReadableTabIds.filter((id): id is string => typeof id === "string" && /^tab-[A-Za-z0-9_-]+$/.test(id)))].slice(0, 500) : [],
      includeTimestamp: input.remoteInbox?.includeTimestamp !== false,
      notifyOnReceive: input.remoteInbox?.notifyOnReceive !== false,
      accessTeamDomain: typeof input.remoteInbox?.accessTeamDomain === "string" ? input.remoteInbox.accessTeamDomain.trim() : "",
      accessAudience: typeof input.remoteInbox?.accessAudience === "string" ? input.remoteInbox.accessAudience.trim() : "",
      allowedEmail: typeof input.remoteInbox?.allowedEmail === "string" ? input.remoteInbox.allowedEmail.trim() : ""
    },
    layout: normalizedLayout
  };
}

function normalizeRemoteInboxTargetNames(value: unknown, fallback: string): string[] {
  const primaryName = normalizeRemoteInboxTargetName(fallback);
  const names = Array.isArray(value) ? value : [fallback];
  const normalized = names
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim())
    .filter((name) => Boolean(name) && name.length <= 120 && !/[\u0000-\u001F\u007F]/.test(name));
  return [...new Set([primaryName, ...normalized])].slice(0, 30);
}

function normalizeRemoteInboxTargetName(value: unknown): string {
  if (typeof value !== "string") return defaultWorkspace.remoteInbox.targetTabName;
  const name = value.trim();
  return name && name.length <= 120 && !/[\u0000-\u001F\u007F]/.test(name) ? name : defaultWorkspace.remoteInbox.targetTabName;
}

async function loadWorkspace(): Promise<WorkspaceState> {
  const raw = requireJsonObject(await readJson<unknown>(workspacePath(), defaultWorkspace), workspacePath());
  return normalizeWorkspace(raw as Partial<WorkspaceState>);
}

async function loadIndex(): Promise<TabsIndex> {
  const raw = requireJsonObject(await readJson<unknown>(tabsIndexPath(), emptyTabsIndex), tabsIndexPath());
  return normalizeTabsIndex(raw as Partial<TabsIndex>);
}

function normalizeNewTabTemplate(value: unknown): NewTabTemplateId {
  return value === "novel" || value === "reference" || value === "custom" ? value : "simple";
}

function normalizeCustomTemplate(value: unknown): string[] {
  const names = Array.isArray(value) ? value : defaultWorkspace.templates.custom;
  const seen = new Set<string>();
  const cleaned = names
    .map((name) => (typeof name === "string" ? name.trim() : ""))
    .filter((name) => name.length > 0 && name !== MAIN_CHILD_TAB_TITLE)
    .filter((name) => {
      if (seen.has(name)) {
        return false;
      }
      seen.add(name);
      return true;
    });
  return [MAIN_CHILD_TAB_TITLE, ...cleaned];
}

function backupTimestamp(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function archiveTimestamp(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function decodeTextBuffer(buffer: Uint8Array): { content: string; encoding: "utf-8" | "shift_jis" } {
  try {
    return {
      content: stripBom(new TextDecoder("utf-8", { fatal: true }).decode(buffer)),
      encoding: "utf-8"
    };
  } catch {
    return {
      content: stripBom(new TextDecoder("shift_jis").decode(buffer)),
      encoding: "shift_jis"
    };
  }
}

async function importTextFiles(multiple: boolean): Promise<ImportTextResult> {
  const envPaths = process.env.TEXTEDITOR_IMPORT_TXT_PATHS;
  let filePaths = envPaths ? envPaths.split(path.delimiter).filter(Boolean) : [];
  if (filePaths.length === 0) {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const options: OpenDialogOptions = {
      title: multiple ? "Import TXT Files" : "Import TXT",
      filters: [{ name: "Text", extensions: ["txt"] }],
      properties: multiple ? ["openFile", "multiSelections"] : ["openFile"]
    };
    const result = focusedWindow
      ? await dialog.showOpenDialog(focusedWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, files: [] };
    }
    filePaths = result.filePaths;
  }

  const selectedPaths = multiple ? filePaths : filePaths.slice(0, 1);
  const files = await Promise.all(
    selectedPaths.map(async (filePath) => {
      const buffer = await readFile(filePath);
      const decoded = decodeTextBuffer(buffer);
      const fileName = path.basename(filePath);
      return {
        filePath,
        fileName,
        title: path.basename(fileName, path.extname(fileName)) || fileName,
        content: decoded.content,
        encoding: decoded.encoding
      };
    })
  );
  return { canceled: false, files };
}

async function listBackupFiles(id: string): Promise<string[]> {
  try {
    const files = await readdir(tabBackupRoot(id));
    return files.filter((file) => /^\d{8}-\d{6}(?:-\d+)?\.json$/.test(file)).sort();
  } catch {
    return [];
  }
}

async function pruneBackups(id: string, keep = 30): Promise<void> {
  const files = await listBackupFiles(id);
  const stale = files.slice(0, Math.max(0, files.length - keep));
  await Promise.allSettled(stale.map((file) => rm(backupPath(id, file), { force: true })));
}

function sameBackupContent(left: TabDocument, right: TabDocument): boolean {
  const normalizedLeft = normalizeTabDocument(left);
  const normalizedRight = normalizeTabDocument(right);
  return normalizedLeft.title === normalizedRight.title && JSON.stringify(normalizedLeft.childTabs) === JSON.stringify(normalizedRight.childTabs);
}

async function createBackup(tab: TabDocument, options: { force?: boolean } = {}): Promise<BackupMeta | null> {
  const normalizedTab = normalizeTabDocument(tab);
  assertTabId(normalizedTab.id);
  const root = tabBackupRoot(normalizedTab.id);
  await mkdir(root, { recursive: true });

  const files = await listBackupFiles(normalizedTab.id);
  const latestFile = files.at(-1);
  if (!options.force && latestFile) {
    const latest = await readJson<TabDocument | null>(backupPath(normalizedTab.id, latestFile), null);
    if (latest && sameBackupContent(latest, normalizedTab)) {
      return null;
    }
  }

  let fileName = `${backupTimestamp()}.json`;
  if (existsSync(path.join(root, fileName))) {
    fileName = `${backupTimestamp()}-${Date.now()}.json`;
  }
  await writeJson(path.join(root, fileName), normalizedTab);
  await pruneBackups(normalizedTab.id);

  return {
    tabId: normalizedTab.id,
    fileName,
    createdAt: normalizedTab.updatedAt,
    title: normalizedTab.title,
    wordCount: countWords(getMainChildTab(normalizedTab).content),
    size: Buffer.byteLength(JSON.stringify(normalizedTab), "utf8"),
    preview: previewBackupContent(normalizedTab),
    readable: true
  };
}

function previewBackupContent(tab: TabDocument): string {
  const main = getMainChildTab(normalizeTabDocument(tab));
  return main.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 120);
}

async function backupMetaFromFile(id: string, fileName: string): Promise<BackupMeta | null> {
  try {
    const filePath = backupPath(id, fileName);
    const stats = await stat(filePath);
    const rawTab = await readJson<TabDocument | null>(filePath, null);
    if (!rawTab) {
      return {
        tabId: id,
        fileName,
        createdAt: fileName,
        title: id,
        wordCount: 0,
        size: stats.size,
        preview: "",
        readable: false,
        error: "Unreadable backup"
      };
    }
    const tab = normalizeTabDocument(rawTab);
    return {
      tabId: id,
      fileName,
      createdAt: tab.updatedAt,
      title: tab.title,
      wordCount: countWords(getMainChildTab(tab).content),
      size: stats.size,
      preview: previewBackupContent(tab),
      readable: true
    };
  } catch (error) {
    return {
      tabId: id,
      fileName,
      createdAt: fileName,
      title: id,
      wordCount: 0,
      readable: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function listBackups(id: string): Promise<BackupMeta[]> {
  const files = await listBackupFiles(id);
  const items = await Promise.all(
    files.map((fileName) => backupMetaFromFile(id, fileName))
  );
  return items.filter((item): item is BackupMeta => item !== null).reverse();
}

async function listBackupHistory(): Promise<BackupMeta[]> {
  let tabDirs: string[] = [];
  try {
    tabDirs = (await readdir(backupsRoot(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^tab-[A-Za-z0-9_-]+$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const allItems = (
    await Promise.all(
      tabDirs.map(async (id) => {
        const files = await listBackupFiles(id);
        const recentFiles = files.slice(-30);
        const items = await Promise.all(recentFiles.map((fileName) => backupMetaFromFile(id, fileName)));
        return items.filter((item): item is BackupMeta => item !== null);
      })
    )
  ).flat();

  return allItems
    .sort((left, right) => `${right.fileName}`.localeCompare(`${left.fileName}`))
    .slice(0, 120);
}

async function createStartupBackups(workspace: WorkspaceState, index: TabsIndex): Promise<void> {
  const validIds = new Set(index.tabs.map((tab) => tab.id));
  const openedIds = workspace.openedTabIds.filter((id) => validIds.has(id));
  await Promise.allSettled(
    openedIds.map(async (id) => {
      const meta = index.tabs.find((tab) => tab.id === id);
      const tab = normalizeTabDocument(await readJson<TabDocument>(tabPath(id), {
        id,
        title: meta?.title ?? "Untitled",
        content: "",
        updatedAt: meta?.updatedAt ?? new Date().toISOString()
      }));
      await createBackup(tab);
    })
  );
}

function addWorkspaceToZip(zip: AdmZip): void {
  const version: WorkspaceArchiveVersion = {
    appVersion: app.getVersion(),
    workspaceVersion: 1,
    createdAt: new Date().toISOString()
  };
  zip.addFile("version.json", Buffer.from(`${JSON.stringify(version, null, 2)}\n`, "utf8"));
  if (existsSync(workspacePath())) {
    zip.addLocalFile(workspacePath(), "", "workspace.json");
  }
  if (existsSync(tabsRoot())) {
    zip.addLocalFolder(tabsRoot(), "tabs");
  }
  if (existsSync(backupsRoot())) {
    zip.addLocalFolder(backupsRoot(), "backups");
  }
}

async function writeWorkspaceZip(filePath: string): Promise<void> {
  await ensureDataFiles();
  await mkdir(path.dirname(filePath), { recursive: true });
  const zip = new AdmZip();
  addWorkspaceToZip(zip);
  zip.writeZip(filePath);
}

async function backupCurrentWorkspaceBeforeImport(): Promise<string> {
  const backupRoot = path.join(app.getPath("userData"), "workspace-import-backups");
  const backupPath = path.join(backupRoot, `TextEditorWorkspaceBackup_${archiveTimestamp()}.zip`);
  await writeWorkspaceZip(backupPath);
  return backupPath;
}

function readArchiveVersion(zip: AdmZip): WorkspaceArchiveVersion {
  const entry = zip.getEntry("version.json");
  if (!entry) {
    throw new Error("version.json was not found in the workspace zip.");
  }
  const version = JSON.parse(entry.getData().toString("utf8")) as Partial<WorkspaceArchiveVersion>;
  if (version.workspaceVersion !== 1) {
    throw new Error("このWorkspaceは現在のVersionでは読み込めません");
  }
  return {
    appVersion: typeof version.appVersion === "string" ? version.appVersion : "unknown",
    workspaceVersion: 1,
    createdAt: typeof version.createdAt === "string" ? version.createdAt : new Date().toISOString()
  };
}

function safeArchiveEntryName(entryName: string): string {
  const normalized = entryName.replace(/\\/g, "/").replace(/^\/+/, "");
  const allowed =
    normalized === "workspace.json" ||
    normalized === "version.json" ||
    normalized.startsWith("tabs/") ||
    normalized.startsWith("backups/");
  if (!allowed || normalized.includes("../") || path.isAbsolute(normalized)) {
    throw new Error(`Invalid workspace zip entry: ${entryName}`);
  }
  return normalized;
}

async function extractWorkspaceZip(zipPath: string): Promise<string> {
  const zip = new AdmZip(zipPath);
  readArchiveVersion(zip);
  if (!zip.getEntry("workspace.json") || !zip.getEntry("tabs/index.json")) {
    throw new Error("Workspace zip is missing required files.");
  }

  const backupPath = await backupCurrentWorkspaceBeforeImport();
  const importId = `${process.pid}-${Date.now()}`;
  const stagingRoot = path.join(app.getPath("userData"), `.texteditor-import-stage-${importId}`);
  const previousRoot = path.join(app.getPath("userData"), `.texteditor-import-previous-${importId}`);
  await rm(stagingRoot, { recursive: true, force: true });
  await rm(previousRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  let previousMoved = false;
  let importCommitted = false;

  try {
    for (const entry of zip.getEntries()) {
      const safeName = safeArchiveEntryName(entry.entryName);
      if (entry.isDirectory) {
        await mkdir(path.join(stagingRoot, safeName), { recursive: true });
        continue;
      }
      const outputPath = path.join(stagingRoot, safeName);
      const relative = path.relative(stagingRoot, outputPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Invalid workspace zip path: ${entry.entryName}`);
      }
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, entry.getData());
    }

    const stagedWorkspacePath = path.join(stagingRoot, "workspace.json");
    const stagedIndexPath = path.join(stagingRoot, "tabs", "index.json");
    normalizeWorkspace(requireJsonObject(await readJson<unknown>(stagedWorkspacePath, defaultWorkspace), stagedWorkspacePath) as Partial<WorkspaceState>);
    normalizeTabsIndex(requireJsonObject(await readJson<unknown>(stagedIndexPath, emptyTabsIndex), stagedIndexPath) as Partial<TabsIndex>);

    if (existsSync(dataRoot())) {
      await rename(dataRoot(), previousRoot);
      previousMoved = true;
    }
    try {
      await rename(stagingRoot, dataRoot());
      importCommitted = true;
    } catch (error) {
      if (previousMoved && !existsSync(dataRoot())) {
        await rename(previousRoot, dataRoot());
        previousMoved = false;
      }
      throw error;
    }

    return backupPath;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    if (importCommitted && previousMoved) {
      await rm(previousRoot, { recursive: true, force: true }).catch((error) => {
        console.error("Failed to remove the pre-import workspace staging directory:", error);
      });
    }
  }
}

async function requestRendererShutdown(window: BrowserWindow, reason: ShutdownReason): Promise<ShutdownResponse> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    return { ok: false, error: "The editor window is unavailable." };
  }
  const webContentsId = window.webContents.id;
  if (!shutdownReadyWebContents.has(webContentsId)) {
    return { ok: false, error: "The editor has not finished initializing its save handler." };
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise<ShutdownResponse>((resolve) => {
    const timer = setTimeout(() => {
      pendingShutdownRequests.delete(id);
      resolve({ ok: false, error: "Timed out while waiting for the editor to finish saving." });
    }, 15_000);
    pendingShutdownRequests.set(id, { webContentsId, resolve, timer });
    try {
      window.webContents.send("app:shutdown-request", { id, reason });
    } catch (error) {
      clearTimeout(timer);
      pendingShutdownRequests.delete(id);
      resolve({ ok: false, error: error instanceof Error ? error.message : "Unable to contact the editor." });
    }
  });
}

async function confirmUnsafeLifecycleAction(window: BrowserWindow, reason: ShutdownReason, error: string): Promise<boolean> {
  const japanese = currentLocale === "jp";
  const forceLabel = japanese
    ? reason === "reload" ? "保存せず再読み込み" : reason === "restart" ? "保存せず再起動" : "保存せず終了"
    : reason === "reload" ? "Reload Without Saving" : reason === "restart" ? "Restart Without Saving" : "Quit Without Saving";
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    buttons: [japanese ? "編集に戻る" : "Keep Editing", forceLabel],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: japanese ? "保存処理を完了できませんでした。" : "The save operation could not be completed.",
    detail: japanese
      ? `${error}\n\n安全のため操作を中止しました。保存せずに続行する場合のみ、2番目のボタンを選択してください。`
      : `${error}\n\nThe action was canceled to protect your data. Choose the second button only if you want to continue without saving.`
  };
  const result = window.isDestroyed()
    ? await dialog.showMessageBox(options)
    : await dialog.showMessageBox(window, options);
  return result.response === 1;
}

async function performLifecycleAction(window: BrowserWindow, reason: ShutdownReason): Promise<boolean> {
  const saveResult = await requestRendererShutdown(window, reason);
  if (isWorkspaceImporting()) {
    return false;
  }
  let force = false;
  if (!saveResult.ok) {
    force = await confirmUnsafeLifecycleAction(window, reason, saveResult.error ?? "Unknown save error");
    if (!force || isWorkspaceImporting()) {
      return false;
    }
  }

  if (reason === "quit" || reason === "restart") {
    BrowserWindow.getAllWindows().forEach((openWindow) => {
      loadedAppStateWebContents.delete(openWindow.webContents.id);
    });
  } else if (!window.isDestroyed()) {
    loadedAppStateWebContents.delete(window.webContents.id);
  }

  const shouldStopRemoteInbox = reason !== "reload" && (reason !== "close" || process.platform !== "darwin");
  if (saveResult.ok) {
    if (shouldStopRemoteInbox) {
      workspacePersistenceState = "shutting-down";
    }
    await waitForPersistenceIdle();
  }

  const readerController = novelViewerController?.belongsToWindow(window) ? novelViewerController : null;
  try {
    await readerController?.checkpointBeforeLifecycle();
  } catch (error) {
    console.error("Novel Viewer checkpoint failed during lifecycle transition:", error);
  }

  if (reason === "reload") {
    try {
      await readerController?.suspendForRendererReload(true);
    } catch (error) {
      console.error("Novel Viewer cleanup failed before reload:", error);
    }
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      shutdownReadyWebContents.delete(window.webContents.id);
      setImmediate(() => {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.reload();
        }
      });
      return true;
    }
    return false;
  }

  if (saveResult.ok && shouldStopRemoteInbox) {
    await stopRemoteInboxAfterConfiguration();
  }

  try {
    await readerController?.shutdown(true);
  } catch (error) {
    console.error("Novel Viewer cleanup failed during shutdown:", error);
  }

  cleanShutdownApproved = saveResult.ok;
  if (reason === "close") {
    windowsAllowedToClose.add(window);
    setImmediate(() => {
      if (!window.isDestroyed()) window.close();
    });
    return true;
  }

  allowAppQuit = true;
  BrowserWindow.getAllWindows().forEach((openWindow) => {
    loadedAppStateWebContents.delete(openWindow.webContents.id);
    windowsAllowedToClose.add(openWindow);
  });
  setImmediate(() => {
    if (reason === "restart") app.relaunch();
    app.quit();
  });
  return true;
}

async function requestLifecycleAction(window: BrowserWindow, requestedReason: ShutdownReason): Promise<boolean> {
  const reason = requestedReason === "reload" && workspacePersistenceState === "restart-required"
    ? "restart"
    : requestedReason;
  if (activeLifecycleAction) {
    return activeLifecycleAction.reason === reason ? activeLifecycleAction.promise : false;
  }
  const promise = performLifecycleAction(window, reason);
  activeLifecycleAction = { reason, promise };
  try {
    return await promise;
  } finally {
    if (activeLifecycleAction?.promise === promise) {
      activeLifecycleAction = null;
    }
  }
}

function createWindow(): void {
  cleanShutdownApproved = false;
  const mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    title: "Text Editor",
    backgroundColor: "#1f1f1f",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  const webContentsId = mainWindow.webContents.id;
  const readerDiagnostics = new NovelViewerDiagnostics(
    novelViewerDebugLogPath(),
    shouldEnableNovelViewerDiagnostics(app.isPackaged, process.env.TEXTEDITOR_NOVEL_VIEWER_DEBUG)
  );
  const readerController = new NovelViewerController(
    mainWindow,
    new ReaderStateStore(readerStatePath()),
    readerDiagnostics
  );
  novelViewerController = readerController;

  mainWindow.on("close", (event) => {
    if (windowsAllowedToClose.has(mainWindow)) {
      return;
    }
    event.preventDefault();
    void requestLifecycleAction(mainWindow, "close").catch((error) => {
      console.error("Failed to complete the close handshake:", error);
    });
  });
  mainWindow.webContents.on("destroyed", () => {
    shutdownReadyWebContents.delete(webContentsId);
    loadedAppStateWebContents.delete(webContentsId);
    for (const [id, pending] of pendingShutdownRequests) {
      if (pending.webContentsId !== webContentsId) continue;
      clearTimeout(pending.timer);
      pendingShutdownRequests.delete(id);
      pending.resolve({ ok: false, error: "The editor process stopped before saving completed." });
    }
  });
  mainWindow.on("closed", () => {
    if (novelViewerController === readerController) {
      novelViewerController = null;
    }
    void readerController.shutdown().catch((error) => {
      console.error("Novel Viewer cleanup failed after window close:", error);
    });
  });
  void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

function sendMenuAction(action: MenuAction): void {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  target?.webContents.send("menu:action", action);
}

function buildApplicationMenu(): Menu {
  const label = menuLabels[currentLocale];
  return Menu.buildFromTemplate([
    {
      label: label.file,
      submenu: [
        { label: label.newTab, accelerator: "CmdOrCtrl+N", click: () => sendMenuAction("new-tab") },
        { label: label.newGroup, click: () => sendMenuAction("new-group") },
        { type: "separator" },
        { label: label.importTxt, click: () => sendMenuAction("import-txt") },
        { label: label.importTxtFiles, click: () => sendMenuAction("import-txt-files") },
        { type: "separator" },
        { label: label.exportTxt, accelerator: "CmdOrCtrl+S", click: () => sendMenuAction("export-txt") },
        { label: label.exportAllTxt, click: () => sendMenuAction("export-all-txt") },
        { type: "separator" },
        { label: label.exportWorkspace, click: () => sendMenuAction("export-workspace") },
        { label: label.importWorkspace, click: () => sendMenuAction("import-workspace") },
        { type: "separator" },
        { label: label.backups, accelerator: "CmdOrCtrl+Shift+B", click: () => sendMenuAction("open-backups") },
        { label: label.openRecent, accelerator: "CmdOrCtrl+Shift+R", click: () => sendMenuAction("open-recent") },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: label.edit,
      submenu: [
        { label: label.undo, accelerator: "CmdOrCtrl+Z", click: () => sendMenuAction("undo") },
        { label: label.redo, accelerator: "CmdOrCtrl+Y", click: () => sendMenuAction("redo") },
        { type: "separator" },
        { label: label.copyAll, accelerator: "CmdOrCtrl+Shift+C", click: () => sendMenuAction("copy-all") },
        { type: "separator" },
        { label: label.find, accelerator: "CmdOrCtrl+F", click: () => sendMenuAction("find") },
        { label: label.globalSearch, accelerator: "CmdOrCtrl+Shift+F", click: () => sendMenuAction("global-search") },
        { label: label.replace, accelerator: "CmdOrCtrl+H", click: () => sendMenuAction("replace") },
        { label: label.findNext, accelerator: "F3", click: () => sendMenuAction("find-next") },
        { label: label.findPrevious, accelerator: "Shift+F3", click: () => sendMenuAction("find-previous") }
      ]
    },
    {
      label: label.view,
      submenu: [
        { label: label.toggleTheme, click: () => sendMenuAction("toggle-theme") },
        { label: label.toggleLocale, accelerator: "CmdOrCtrl+Shift+L", click: () => sendMenuAction("toggle-locale") },
        { type: "separator" },
        { label: label.settings, click: () => sendMenuAction("open-settings") },
        { type: "separator" },
        { label: label.splitRight, accelerator: "CmdOrCtrl+\\", click: () => sendMenuAction("split-right") },
        { label: label.closeSplit, click: () => sendMenuAction("close-split") },
        { label: label.focusLeft, accelerator: "CmdOrCtrl+1", click: () => sendMenuAction("focus-left") },
        { label: label.focusRight, accelerator: "CmdOrCtrl+2", click: () => sendMenuAction("focus-right") },
        { type: "separator" },
        { label: label.novelViewer, accelerator: "CmdOrCtrl+Shift+V", click: () => sendMenuAction("toggle-novel-viewer") },
        { label: label.focusNovelViewerAddress, accelerator: "CmdOrCtrl+L", click: () => sendMenuAction("focus-novel-viewer-address") },
        { label: label.closeNovelViewer, accelerator: "CmdOrCtrl+Shift+W", click: () => sendMenuAction("close-novel-viewer") },
        ...(shouldShowNovelViewerDiagnosticMenu(app.isPackaged) ? [
          { type: "separator" as const },
          {
            id: "novel-viewer-diagnostic-dump",
            label: label.dumpNovelViewerState,
            click: () => {
              void novelViewerController?.dumpDiagnosticState("menu-dump").catch((error) =>
                console.error("Failed to dump Novel Viewer diagnostics:", error)
              );
            }
          },
          {
            id: "novel-viewer-diagnostic-bring-to-front",
            label: label.bringNovelViewerToFront,
            click: () => {
              void novelViewerController?.bringToFrontForDiagnostics().catch((error) =>
                console.error("Failed to bring Novel Viewer to front:", error)
              );
            }
          }
        ] : []),
        { type: "separator" },
        { label: label.fontSizeUp, accelerator: "CmdOrCtrl+Plus", click: () => sendMenuAction("font-up") },
        { label: label.fontSizeDown, accelerator: "CmdOrCtrl+-", click: () => sendMenuAction("font-down") },
        { type: "separator" },
        { label: label.reload, accelerator: "CmdOrCtrl+R", click: () => sendMenuAction("reload-app") },
        ...(!app.isPackaged ? [{ role: "toggleDevTools" as const }] : [])
      ]
    },
    {
      label: label.window,
      submenu: [{ role: "minimize" }, { role: "close" }]
    },
  ]);
}

const remoteInboxServer = new RemoteInboxServer({
  dataRoot,
  getSettings: () => remoteInboxSettings,
  onStatus: (status) => { remoteInboxStatus = status; },
  append: async (text, includeTimestamp, targetTabName) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return { ok: false, error: "Renderer unavailable" };
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => { pendingRemoteAppends.delete(id); resolve({ ok: false, error: "Renderer timeout" }); }, 10_000);
      pendingRemoteAppends.set(id, { resolve, timer });
      window.webContents.send("remote-inbox:append-request", { id, text, includeTimestamp, targetTabName });
    });
    if (result.ok && (await loadWorkspace()).remoteInbox.notifyOnReceive && Notification.isSupported()) {
      try { new Notification({ title: "Remote memo received", body: `${targetTabName} was updated.` }).show(); } catch { /* notification does not affect save */ }
    }
    return result.ok ? { ok: true, receivedAt: localIsoWithOffset() } : { ok: false, error: result.error ?? "Save failed" };
  },
  read: async (targetTabName) => {
    const index = await loadIndex();
    const matches = index.tabs.filter((tab) => tab.title === targetTabName);
    if (matches.length > 1) return { error: "Remote Inbox target is ambiguous" };
    const meta = matches[0];
    if (!meta) return { content: "" };
    try {
      const tab = normalizeTabDocument(await readJson<TabDocument>(tabPath(meta.id), { id: meta.id, title: meta.title, content: "", updatedAt: meta.updatedAt }));
      return { content: getMainChildTab(tab).content };
    } catch {
      return { error: "Read failed" };
    }
  },
  getRemoteInbox: async (targetTabName) => {
    const index = await loadIndex();
    const matches = index.tabs.filter((tab) => tab.title === targetTabName);
    if (matches.length > 1) throw new Error("Remote Inbox target is ambiguous");
    const meta = matches[0];
    if (!meta) return { target: targetTabName, content: "", revision: 0, updatedAt: new Date(0).toISOString() };
    const tab = normalizeTabDocument(await readJson<TabDocument>(tabPath(meta.id), { id: meta.id, title: meta.title, content: "", updatedAt: meta.updatedAt, revision: 0 }));
    return { id: tab.id, target: targetTabName, content: getMainChildTab(tab).content, revision: tab.revision ?? 0, updatedAt: tab.updatedAt };
  },
  mutateRemoteInbox: async (operation, targetTabName, content, revision) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return { ok: false, error: "Renderer unavailable" };
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise<RemoteInboxMutationResult>((resolve) => {
      const timer = setTimeout(() => { pendingRemoteMutations.delete(id); resolve({ ok: false, error: "Renderer timeout" }); }, 10_000);
      pendingRemoteMutations.set(id, { resolve, timer });
      window.webContents.send("remote-inbox:mutate-request", { id, operation, targetTabName, content, revision });
    });
  },
  listTabs: async () => {
    const index = await loadIndex();
    const allowed = new Set(remoteInboxSettings.remoteReadableTabIds);
    const remoteNames = new Set(remoteInboxSettings.targetTabNames);
    return index.tabs.filter((tab) => allowed.has(tab.id) && !remoteNames.has(tab.title)).map((tab) => ({ id: tab.id, title: tab.title, pinned: Boolean(tab.pinned), updatedAt: tab.updatedAt }));
  },
  readTab: async (id) => {
    if (!remoteInboxSettings.remoteReadableTabIds.includes(id)) return null;
    const index = await loadIndex();
    const meta = index.tabs.find((tab) => tab.id === id && !remoteInboxSettings.targetTabNames.includes(tab.title));
    if (!meta) return null;
    const tab = normalizeTabDocument(await readJson<TabDocument>(tabPath(meta.id), { id: meta.id, title: meta.title, content: "", updatedAt: meta.updatedAt }));
    return { id: meta.id, title: meta.title, pinned: Boolean(meta.pinned), updatedAt: tab.updatedAt, content: getMainChildTab(tab).content };
  }
});

function enqueueRemoteInboxConfiguration(): Promise<RemoteInboxStatus> {
  const operation = remoteConfigurationTail.then(
    () => remoteInboxServer.configure(),
    () => remoteInboxServer.configure()
  );
  remoteConfigurationTail = operation.then(() => undefined, () => undefined);
  return operation;
}

async function stopRemoteInboxAfterConfiguration(): Promise<void> {
  await remoteConfigurationTail;
  await remoteInboxServer.stop();
}

ipcMain.on("app:shutdown-handler-ready", (event) => {
  shutdownReadyWebContents.add(event.sender.id);
});

ipcMain.on("app:shutdown-response", (event, payload: { id?: string; ok?: boolean; error?: string }) => {
  if (typeof payload?.id !== "string") return;
  const pending = pendingShutdownRequests.get(payload.id);
  if (!pending || pending.webContentsId !== event.sender.id) return;
  clearTimeout(pending.timer);
  pendingShutdownRequests.delete(payload.id);
  pending.resolve({
    ok: payload.ok === true,
    error: typeof payload.error === "string" ? payload.error : undefined
  });
});

ipcMain.handle("app:load", async (event): Promise<AppStateSnapshot> => {
  await ensureDataFiles();
  const workspace = await loadWorkspace();
  remoteInboxSettings = workspace.remoteInbox;
  const tabIndex = await loadIndex();
  await createStartupBackups(workspace, tabIndex);
  loadedAppStateWebContents.add(event.sender.id);
  return {
    workspace,
    tabIndex,
    dataRoot: dataRoot(),
    recovery: startupRecoveryState
  };
});

ipcMain.handle("app:recovery:ack", async (event, restore: boolean): Promise<void> => {
  assertRendererStateLoaded(event.sender.id);
  return enqueuePersistenceMutation(async () => {
    startupRecoveryState = { ...startupRecoveryState, abnormalShutdown: false };
    await writeJson(sessionPath(), {
      abnormalShutdown: true,
      startedAt: new Date().toISOString(),
      lastShutdownAt: startupRecoveryState.lastShutdownAt,
      recoveryChoice: restore ? "restore" : "skip"
    });
  });
});

ipcMain.handle("novel-viewer:initialize", async (event, restoreAllowed: boolean): Promise<NovelViewerStartupState> => {
  if (typeof restoreAllowed !== "boolean") throw new Error("Invalid Novel Viewer recovery option.");
  return assertTrustedEditorSender(event).initialize(restoreAllowed);
});

ipcMain.handle("novel-viewer:open", async (event): Promise<NovelViewerStatus> =>
  assertTrustedEditorSender(event).open()
);

ipcMain.handle("novel-viewer:close", async (event): Promise<NovelViewerStatus> =>
  assertTrustedEditorSender(event).close()
);

ipcMain.handle("novel-viewer:navigate", async (event, url: string): Promise<NovelViewerStatus> => {
  if (typeof url !== "string" || url.length > 4096) throw new Error("Invalid Novel Viewer URL.");
  return assertTrustedEditorSender(event).navigate(url);
});

ipcMain.handle("novel-viewer:back", async (event): Promise<NovelViewerStatus> =>
  assertTrustedEditorSender(event).goBack()
);

ipcMain.handle("novel-viewer:forward", async (event): Promise<NovelViewerStatus> =>
  assertTrustedEditorSender(event).goForward()
);

ipcMain.handle("novel-viewer:reload-or-stop", async (event): Promise<NovelViewerStatus> =>
  assertTrustedEditorSender(event).reloadOrStop()
);

ipcMain.handle("novel-viewer:open-external", async (event): Promise<boolean> =>
  assertTrustedEditorSender(event).openExternal()
);

ipcMain.handle("novel-viewer:bounds", async (event, update: NovelViewerBoundsUpdate): Promise<void> => {
  assertTrustedEditorSender(event).updateBounds(update);
});

ipcMain.handle("novel-viewer:occlusion", async (event, update: NovelViewerOcclusionUpdate): Promise<void> => {
  assertTrustedEditorSender(event).setOcclusion(update);
});

ipcMain.handle("novel-viewer:focus-remote", async (event): Promise<void> => {
  assertTrustedEditorSender(event).focusRemote();
});

ipcMain.handle(
  "novel-viewer:diagnostic-renderer-snapshot",
  async (event, reason: string, snapshot: NovelViewerRendererDiagnosticSnapshot): Promise<void> => {
    if (typeof reason !== "string" || reason.length > 120) throw new Error("Invalid Novel Viewer diagnostic reason.");
    assertTrustedEditorSender(event).recordRendererDiagnosticSnapshot(reason, snapshot);
  }
);

ipcMain.handle("app:quit", async (event): Promise<boolean> => {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window ? requestLifecycleAction(window, "quit") : false;
});

ipcMain.handle("app:request-reload", async (event): Promise<boolean> => {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window ? requestLifecycleAction(window, "reload") : false;
});

ipcMain.handle("app:request-restart", async (event): Promise<boolean> => {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window ? requestLifecycleAction(window, "restart") : false;
});

ipcMain.handle("workspace:save", async (event, workspace: WorkspaceState): Promise<WorkspaceState> => {
  assertRendererStateLoaded(event.sender.id);
  const result = await enqueuePersistenceMutation(async () => {
    const normalized = normalizeWorkspace(workspace);
    await writeJson(workspacePath(), normalized);
    const remoteSettingsChanged = JSON.stringify(remoteInboxSettings) !== JSON.stringify(normalized.remoteInbox);
    remoteInboxSettings = normalized.remoteInbox;
    if (currentLocale !== normalized.locale) {
      currentLocale = normalized.locale;
      Menu.setApplicationMenu(buildApplicationMenu());
    }
    return {
      normalized,
      configured: remoteSettingsChanged
        ? enqueueRemoteInboxConfiguration()
        : Promise.resolve(remoteInboxStatus)
    };
  });
  await result.configured;
  return result.normalized;
});

ipcMain.handle("remote-inbox:status", async (): Promise<RemoteInboxStatus> => remoteInboxStatus);
ipcMain.on("remote-inbox:append-result", (_event, payload: { id?: string; ok?: boolean; error?: string }) => {
  if (typeof payload?.id !== "string") return;
  const pending = pendingRemoteAppends.get(payload.id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRemoteAppends.delete(payload.id);
  pending.resolve({ ok: Boolean(payload.ok), error: typeof payload.error === "string" ? payload.error : undefined });
});
ipcMain.on("remote-inbox:mutate-result", (_event, payload: RemoteInboxMutationResult & { id?: string }) => {
  if (typeof payload?.id !== "string") return;
  const pending = pendingRemoteMutations.get(payload.id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRemoteMutations.delete(payload.id);
  pending.resolve(payload);
});
ipcMain.handle("remote-inbox:pc-clear-audit", async (event, payload: { tabId: string; targetTabName: string; revision: number; beforeCharacters: number }): Promise<void> => {
  assertRendererStateLoaded(event.sender.id);
  return enqueuePersistenceMutation(async () => {
    await remoteInboxServer.auditPcClear(payload.tabId, payload.targetTabName, payload.revision, payload.beforeCharacters);
  });
});

ipcMain.handle("tabs:index:save", async (event, index: TabsIndex): Promise<TabsIndex> => {
  assertRendererStateLoaded(event.sender.id);
  return enqueuePersistenceMutation(async () => {
    const normalized = normalizeTabsIndex(index);
    await writeJson(tabsIndexPath(), normalized);
    return normalized;
  });
});

ipcMain.handle("tab:load", async (_event, id: string): Promise<TabDocument> => {
  assertTabId(id);
  const index = await loadIndex();
  const meta = index.tabs.find((tab) => tab.id === id);
  return normalizeTabDocument(await readJson<TabDocument>(tabPath(id), {
    id,
    title: meta?.title ?? "Untitled",
    content: "",
    updatedAt: meta?.updatedAt ?? new Date().toISOString()
  }));
});

ipcMain.handle("tab:save", async (event, tab: TabDocument): Promise<TabDocument> => {
  assertRendererStateLoaded(event.sender.id);
  return enqueuePersistenceMutation(async () => {
    assertTabId(tab.id);
    const updatedAt = new Date().toISOString();
    const normalized: TabDocument = normalizeTabDocument({
      ...tab,
      title: tab.title.trim() || "Untitled",
      updatedAt,
      childTabs: getChildTabs(tab).map((child) => ({
        ...child,
        updatedAt: child.updatedAt || updatedAt
      }))
    });

    await writeJson(tabPath(tab.id), normalized);

    const index = await loadIndex();
    const meta = {
      id: normalized.id,
      title: normalized.title,
      updatedAt,
      wordCount: countWords(getMainChildTab(normalized).content),
      pinned: index.tabs.find((entry) => entry.id === tab.id)?.pinned ?? false
    };
    const tabs = index.tabs.some((entry) => entry.id === tab.id)
      ? index.tabs.map((entry) => (entry.id === tab.id ? meta : entry))
      : [...index.tabs, meta];
    const nextIndex = normalizeTabsIndex({
      ...index,
      tabs,
      ungroupedTabIds: index.tabs.some((entry) => entry.id === tab.id)
        ? index.ungroupedTabIds
        : [...(index.ungroupedTabIds ?? []), normalized.id]
    });
    await writeJson(tabsIndexPath(), nextIndex);

    return normalized;
  });
});

ipcMain.handle("tab:delete", async (event, id: string): Promise<TabsIndex> => {
  assertRendererStateLoaded(event.sender.id);
  return enqueuePersistenceMutation(async () => {
    assertTabId(id);
    const index = await loadIndex();
    const meta = index.tabs.find((tab) => tab.id === id);
    const tab = normalizeTabDocument(await readJson<TabDocument>(tabPath(id), {
      id,
      title: meta?.title ?? "Untitled",
      content: "",
      updatedAt: meta?.updatedAt ?? new Date().toISOString()
    }));
    try {
      await createBackup(tab, { force: true });
    } catch (error) {
      console.error("Failed to create final backup before delete:", error);
    }
    await rm(tabPath(id), { force: true });
    const nextIndex = normalizeTabsIndex({
      ...index,
      groups: index.groups?.map((group) => ({
        ...group,
        tabIds: group.tabIds.filter((tabId) => tabId !== id)
      })),
      ungroupedTabIds: index.ungroupedTabIds?.filter((tabId) => tabId !== id),
      tabs: index.tabs.filter((tab) => tab.id !== id)
    });
    await writeJson(tabsIndexPath(), nextIndex);
    return nextIndex;
  });
});

ipcMain.handle("tab:backup:create", async (event, tab: TabDocument): Promise<BackupMeta | null> => {
  assertRendererStateLoaded(event.sender.id);
  return enqueuePersistenceMutation(() => createBackup(tab));
});

ipcMain.handle("tab:backup:list", async (_event, id: string): Promise<BackupMeta[]> => {
  assertTabId(id);
  return listBackups(id);
});

ipcMain.handle("tab:backup:listAll", async (): Promise<BackupMeta[]> => {
  return listBackupHistory();
});

ipcMain.handle("tab:backup:load", async (_event, id: string, fileName: string): Promise<TabDocument> => {
  assertTabId(id);
  return normalizeTabDocument(await readJson<TabDocument>(backupPath(id, fileName), {
    id,
    title: "Untitled",
    content: "",
    updatedAt: new Date().toISOString()
  }));
});

ipcMain.handle("tab:exportTxt", async (_event, tab: TabDocument): Promise<{ canceled: boolean; filePath?: string }> => {
  const safeTitle = (tab.title.trim() || tab.id).replace(/[\\/:*?"<>|]/g, "_");
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const options = {
    title: "TXT Export",
    defaultPath: `${safeTitle}.txt`,
    filters: [{ name: "Text", extensions: ["txt"] }]
  };
  const result = focusedWindow
    ? await dialog.showSaveDialog(focusedWindow, options)
    : await dialog.showSaveDialog(options);

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  await writeFile(result.filePath, getActiveChildTab(tab, tab.activeChildTabId).content, "utf8");
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle("tabs:exportAllTxt", async (): Promise<{ canceled: boolean; filePath?: string }> => {
  const index = await loadIndex();
  const documents = await Promise.all(
    index.tabs.map(async (meta) => {
      const doc = normalizeTabDocument(await readJson<TabDocument>(tabPath(meta.id), {
        id: meta.id,
        title: meta.title,
        content: "",
        updatedAt: meta.updatedAt
      }));
      return {
        title: doc.title.trim() || meta.title || doc.id,
        content: getMainChildTab(doc).content
      };
    })
  );

  const output = documents.map((doc) => `# ${doc.title}\n\n${doc.content}`).join("\n\n");
  if (process.env.TEXTEDITOR_EXPORT_ALL_PATH) {
    await writeFile(process.env.TEXTEDITOR_EXPORT_ALL_PATH, output, "utf8");
    return { canceled: false, filePath: process.env.TEXTEDITOR_EXPORT_ALL_PATH };
  }

  const focusedWindow = BrowserWindow.getFocusedWindow();
  const options = {
    title: "Export All TXT",
    defaultPath: "all-tabs.txt",
    filters: [{ name: "Text", extensions: ["txt"] }]
  };
  const result = focusedWindow
    ? await dialog.showSaveDialog(focusedWindow, options)
    : await dialog.showSaveDialog(options);

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  await writeFile(result.filePath, output, "utf8");
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle("txt:import", async (_event, multiple: boolean): Promise<ImportTextResult> => {
  return importTextFiles(multiple);
});

ipcMain.handle("tabs:search", async (_event, rawQuery: string): Promise<GlobalSearchResult[]> => {
  const query = rawQuery.trim();
  if (!query) {
    return [];
  }

  const normalizedQuery = query.toLocaleLowerCase();
  const results: GlobalSearchResult[] = [];
  const index = await loadIndex();

  for (const meta of index.tabs) {
    const doc = normalizeTabDocument(await readJson<TabDocument>(tabPath(meta.id), {
      id: meta.id,
      title: meta.title,
      content: "",
      updatedAt: meta.updatedAt
    }));
    const title = doc.title.trim() || meta.title || doc.id;
    const groupTitle = groupTitleForTab(index, doc.id);
    const normalizedTitle = title.toLocaleLowerCase();
    let titleMatch = normalizedTitle.indexOf(normalizedQuery);
    while (titleMatch !== -1) {
        results.push({
          tabId: doc.id,
          title,
          groupTitle,
          childTabId: "main",
          childTitle: getMainChildTab(doc).title,
          field: "title",
          lineNumber: null,
          preview: title,
        matchStart: titleMatch,
        matchEnd: titleMatch + query.length
      });
      titleMatch = normalizedTitle.indexOf(normalizedQuery, titleMatch + Math.max(1, query.length));
    }

    for (const child of getChildTabs(doc)) {
      const normalizedChildTitle = child.title.toLocaleLowerCase();
      let childTitleMatch = normalizedChildTitle.indexOf(normalizedQuery);
      while (childTitleMatch !== -1) {
        results.push({
          tabId: doc.id,
          title,
          groupTitle,
          childTabId: child.id,
          childTitle: child.title,
          field: "title",
          lineNumber: null,
          preview: child.title,
          matchStart: childTitleMatch,
          matchEnd: childTitleMatch + query.length
        });
        childTitleMatch = normalizedChildTitle.indexOf(normalizedQuery, childTitleMatch + Math.max(1, query.length));
      }

      const lines = child.content.split(/\r?\n/);
      lines.forEach((line, index) => {
        const normalizedLine = line.toLocaleLowerCase();
        let match = normalizedLine.indexOf(normalizedQuery);
        while (match !== -1) {
          results.push({
            tabId: doc.id,
            title,
            groupTitle,
            childTabId: child.id,
            childTitle: child.title,
            field: "content",
            lineNumber: index + 1,
            preview: line.trim() || line,
            matchStart: match,
            matchEnd: match + query.length
          });
          match = normalizedLine.indexOf(normalizedQuery, match + Math.max(1, query.length));
        }
      });
    }
  }

  return results;
});

ipcMain.handle("workspace:export", async (): Promise<WorkspaceTransferResult> => {
  const defaultPath = `TextEditorWorkspace_${archiveTimestamp()}.zip`;
  const targetPath = process.env.TEXTEDITOR_WORKSPACE_EXPORT_PATH;
  if (targetPath) {
    await writeWorkspaceZip(targetPath);
    return { canceled: false, filePath: targetPath };
  }

  const focusedWindow = BrowserWindow.getFocusedWindow();
  const options = {
    title: "Export Workspace",
    defaultPath,
    filters: [{ name: "Zip", extensions: ["zip"] }]
  };
  const result = focusedWindow
    ? await dialog.showSaveDialog(focusedWindow, options)
    : await dialog.showSaveDialog(options);

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  await writeWorkspaceZip(result.filePath);
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle("workspace:import", async (event): Promise<WorkspaceTransferResult> => {
  assertRendererStateLoaded(event.sender.id);
  const selectedPath = process.env.TEXTEDITOR_WORKSPACE_IMPORT_PATH;
  let filePath = selectedPath;
  if (!filePath) {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const options: OpenDialogOptions = {
      title: "Import Workspace",
      filters: [{ name: "Zip", extensions: ["zip"] }],
      properties: ["openFile"]
    };
    const result = focusedWindow
      ? await dialog.showOpenDialog(focusedWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    filePath = result.filePaths[0];
  }

  assertRendererStateLoaded(event.sender.id);
  assertWorkspaceWritable();
  workspacePersistenceState = "importing";
  let importCommitted = false;
  let backupPath: string | undefined;
  try {
    await waitForPersistenceIdle();
    await stopRemoteInboxAfterConfiguration();
    backupPath = await extractWorkspaceZip(filePath);
    importCommitted = true;
    const importedWorkspace = await loadWorkspace();
    currentLocale = importedWorkspace.locale;
    remoteInboxSettings = importedWorkspace.remoteInbox;
    workspacePersistenceState = "restart-required";
    Menu.setApplicationMenu(buildApplicationMenu());
    return { canceled: false, filePath, backupPath, restartRequired: true };
  } catch (error) {
    const existingWorkspaceIntact = existsSync(workspacePath()) && existsSync(tabsIndexPath());
    let canResumeCurrentWorkspace = !importCommitted && existingWorkspaceIntact;
    workspacePersistenceState = canResumeCurrentWorkspace ? "ready" : "restart-required";
    if (canResumeCurrentWorkspace) {
      try {
        const currentWorkspace = await loadWorkspace();
        currentLocale = currentWorkspace.locale;
        remoteInboxSettings = currentWorkspace.remoteInbox;
        Menu.setApplicationMenu(buildApplicationMenu());
        await enqueueRemoteInboxConfiguration();
      } catch (restoreError) {
        canResumeCurrentWorkspace = false;
        workspacePersistenceState = "restart-required";
        console.error("Failed to restore Remote Inbox after a canceled workspace import:", restoreError);
      }
    }
    if (!canResumeCurrentWorkspace) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        canceled: false,
        filePath,
        backupPath,
        restartRequired: true,
        error: `${reason} Restart the app before continuing.`
      };
    }
    throw error;
  }
});

ipcMain.handle("clipboard:writeText", async (_event, text: string): Promise<void> => {
  clipboard.writeText(text);
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    } else if (app.isReady()) {
      createWindow();
    }
  });

  app.whenReady().then(async () => {
    try {
      await ensureDataFiles();
      startupRecoveryState = await markSessionStarted();
      const initialWorkspace = await loadWorkspace();
      currentLocale = initialWorkspace.locale;
      remoteInboxSettings = initialWorkspace.remoteInbox;
      await enqueueRemoteInboxConfiguration();
      Menu.setApplicationMenu(buildApplicationMenu());
      createWindow();
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createWindow();
        }
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox(
        currentLocale === "jp" ? "Workspaceを開けません" : "Unable to Open Workspace",
        currentLocale === "jp"
          ? `JSONファイルを読み込めませんでした。データ保護のため起動を中止します。\n\n${reason}`
          : `A JSON file could not be read. Startup was stopped to protect your data.\n\n${reason}`
      );
      allowAppQuit = true;
      app.quit();
    }
  });
}

app.on("before-quit", (event) => {
  if (allowAppQuit || !hasSingleInstanceLock) {
    return;
  }
  event.preventDefault();
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (window) {
    void requestLifecycleAction(window, "quit").catch((error) => {
      console.error("Failed to complete the quit handshake:", error);
    });
    return;
  }
  allowAppQuit = true;
  app.quit();
});

app.on("certificate-error", (event, webContents, _url, _error, _certificate, callback) => {
  if (!novelViewerController?.handleCertificateError(webContents)) return;
  event.preventDefault();
  callback(false);
});

app.on("will-quit", () => {
  void stopRemoteInboxAfterConfiguration();
  if (cleanShutdownApproved) {
    markSessionCleanSync();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
