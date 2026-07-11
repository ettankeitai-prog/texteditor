import AdmZip from "adm-zip";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification } from "electron";
import type { OpenDialogOptions } from "electron";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
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
import { RemoteInboxServer, type RemoteInboxStatus } from "./remoteInbox.js";

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

app.setName("texteditor");

let currentLocale: Locale = "en";
let startupRecoveryState: RecoveryState = { abnormalShutdown: false };
let remoteInboxStatus: RemoteInboxStatus = { state: "stopped" };
let remoteInboxSettings = defaultWorkspace.remoteInbox;
const pendingRemoteAppends = new Map<string, { resolve: (value: { ok: boolean; error?: string }) => void; timer: NodeJS.Timeout }>();

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
    fontSizeUp: string;
    fontSizeDown: string;
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
    fontSizeUp: "Font Size Up",
    fontSizeDown: "Font Size Down",
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
    fontSizeUp: "フォントサイズを大きく",
    fontSizeDown: "フォントサイズを小さく",
    window: "ウィンドウ"
  }
};

if (process.env.TEXTEDITOR_USER_DATA) {
  app.setPath("userData", process.env.TEXTEDITOR_USER_DATA);
}

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
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
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
  try {
    mkdirSync(dataRoot(), { recursive: true });
    writeFileSync(
      sessionPath(),
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
  } catch (error) {
    console.error("Failed to mark clean shutdown:", error);
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
      targetTabName: typeof input.remoteInbox?.targetTabName === "string" && input.remoteInbox.targetTabName.trim() ? input.remoteInbox.targetTabName.trim().slice(0, 120) : defaultWorkspace.remoteInbox.targetTabName,
      includeTimestamp: input.remoteInbox?.includeTimestamp !== false,
      notifyOnReceive: input.remoteInbox?.notifyOnReceive !== false,
      accessTeamDomain: typeof input.remoteInbox?.accessTeamDomain === "string" ? input.remoteInbox.accessTeamDomain.trim() : "",
      accessAudience: typeof input.remoteInbox?.accessAudience === "string" ? input.remoteInbox.accessAudience.trim() : "",
      allowedEmail: typeof input.remoteInbox?.allowedEmail === "string" ? input.remoteInbox.allowedEmail.trim() : ""
    },
    layout: normalizedLayout
  };
}

async function loadWorkspace(): Promise<WorkspaceState> {
  return normalizeWorkspace(await readJson<Partial<WorkspaceState>>(workspacePath(), defaultWorkspace));
}

async function loadIndex(): Promise<TabsIndex> {
  return normalizeTabsIndex(await readJson<Partial<TabsIndex>>(tabsIndexPath(), emptyTabsIndex));
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
  const tempRoot = path.join(app.getPath("temp"), `texteditor-import-${Date.now()}`);
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });

  try {
    for (const entry of zip.getEntries()) {
      const safeName = safeArchiveEntryName(entry.entryName);
      if (entry.isDirectory) {
        await mkdir(path.join(tempRoot, safeName), { recursive: true });
        continue;
      }
      const outputPath = path.join(tempRoot, safeName);
      const relative = path.relative(tempRoot, outputPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Invalid workspace zip path: ${entry.entryName}`);
      }
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, entry.getData());
    }

    await rm(dataRoot(), { recursive: true, force: true });
    await mkdir(dataRoot(), { recursive: true });
    await cp(tempRoot, dataRoot(), { recursive: true });
    currentLocale = (await loadWorkspace()).locale;
    Menu.setApplicationMenu(buildApplicationMenu());
    return backupPath;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function createWindow(): void {
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
        { label: label.fontSizeUp, accelerator: "CmdOrCtrl+Plus", click: () => sendMenuAction("font-up") },
        { label: label.fontSizeDown, accelerator: "CmdOrCtrl+-", click: () => sendMenuAction("font-down") },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" }
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
  }
});

ipcMain.handle("app:load", async (): Promise<AppStateSnapshot> => {
  await ensureDataFiles();
  const workspace = await loadWorkspace();
  remoteInboxSettings = workspace.remoteInbox;
  const tabIndex = await loadIndex();
  await createStartupBackups(workspace, tabIndex);
  return {
    workspace,
    tabIndex,
    dataRoot: dataRoot(),
    recovery: startupRecoveryState
  };
});

ipcMain.handle("app:recovery:ack", async (_event, restore: boolean): Promise<void> => {
  startupRecoveryState = { ...startupRecoveryState, abnormalShutdown: false };
  await writeJson(sessionPath(), {
    abnormalShutdown: true,
    startedAt: new Date().toISOString(),
    lastShutdownAt: startupRecoveryState.lastShutdownAt,
    recoveryChoice: restore ? "restore" : "skip"
  });
});

ipcMain.handle("app:quit", async (): Promise<void> => {
  app.quit();
});

ipcMain.handle("workspace:save", async (_event, workspace: WorkspaceState): Promise<WorkspaceState> => {
  const normalized = normalizeWorkspace(workspace);
  await writeJson(workspacePath(), normalized);
  remoteInboxSettings = normalized.remoteInbox;
  if (currentLocale !== normalized.locale) {
    currentLocale = normalized.locale;
    Menu.setApplicationMenu(buildApplicationMenu());
  }
  await remoteInboxServer.configure();
  return normalized;
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

ipcMain.handle("tabs:index:save", async (_event, index: TabsIndex): Promise<TabsIndex> => {
  const normalized = normalizeTabsIndex(index);
  await writeJson(tabsIndexPath(), normalized);
  return normalized;
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

ipcMain.handle("tab:save", async (_event, tab: TabDocument): Promise<TabDocument> => {
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

ipcMain.handle("tab:delete", async (_event, id: string): Promise<TabsIndex> => {
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

ipcMain.handle("tab:backup:create", async (_event, tab: TabDocument): Promise<BackupMeta | null> => {
  return createBackup(tab);
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

ipcMain.handle("workspace:import", async (): Promise<WorkspaceTransferResult> => {
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

  const backupPath = await extractWorkspaceZip(filePath);
  return { canceled: false, filePath, backupPath };
});

ipcMain.handle("clipboard:writeText", async (_event, text: string): Promise<void> => {
  clipboard.writeText(text);
});

app.whenReady().then(async () => {
  await ensureDataFiles();
  startupRecoveryState = await markSessionStarted();
  currentLocale = (await loadWorkspace()).locale;
  remoteInboxSettings = (await loadWorkspace()).remoteInbox;
  await remoteInboxServer.configure();
  Menu.setApplicationMenu(buildApplicationMenu());
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("will-quit", () => {
  void remoteInboxServer.stop();
  markSessionCleanSync();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
