import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { findNext, findPrevious, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import { EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import "./styles.css";
import {
  BackupMeta,
  ChildTabDocument,
  GlobalSearchResult,
  Locale,
  MAIN_CHILD_TAB_ID,
  MAIN_CHILD_TAB_TITLE,
  NewTabTemplateId,
  PaneId,
  TabGroup,
  TabDocument,
  TabMeta,
  TabsIndex,
  UNGROUPED_GROUP_ID,
  WorkspaceState,
  countWords,
  defaultWorkspace,
  groupTitleForTab,
  getActiveChildTab,
  getChildTabs,
  getMainChildTab,
  normalizeTabDocument,
  normalizeTabsIndex
} from "../shared/schema";
import type {
  NovelViewerOcclusionReason,
  NovelViewerRendererDiagnosticSnapshot,
  NovelViewerStatus
} from "../shared/novelViewer";

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

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root was not found.");
}

app.innerHTML = `
  <div class="shell" data-theme="dark">
    <div class="workspace">
      <aside class="sidebar" id="sidebar"></aside>
      <aside class="search-panel" id="search-panel" hidden>
        <div class="search-panel-header">
          <label for="global-search-input" id="global-search-label">Search:</label>
          <button type="button" class="icon-button" data-action="close-global-search" title="Close">x</button>
        </div>
        <input class="search-input" id="global-search-input" autocomplete="off" />
        <div class="search-summary" id="global-search-summary"></div>
        <div class="search-results" id="global-search-results"></div>
      </aside>
      <div class="sidebar-resizer" id="sidebar-resizer" title="Resize sidebar"></div>
      <main class="editor-area" id="editor-area">
        <div class="editor-header">
          <div class="editor-title-block">
            <input class="active-title-input" id="active-title-input" value="No tab" aria-label="Active tab title" disabled />
            <div class="active-meta" id="active-meta" hidden></div>
          </div>
          <div class="child-tab-bar single-child-tab-bar" id="single-child-tab-bar"></div>
        </div>
        <div class="save-state" id="save-state" aria-live="polite">Loading</div>
        <div class="editor-split" id="editor-split">
          <section class="editor-pane is-active" data-pane-id="left">
            <div class="pane-editor-header">
              <input class="pane-editor-title pane-title-input" id="left-pane-title" data-pane-id="left" value="No tab" aria-label="Left editor tab title" disabled />
              <div class="child-tab-bar" id="left-child-tab-bar"></div>
            </div>
            <div class="editor-host" id="left-editor-host" data-testid="active-editor-host"></div>
          </section>
          <div class="split-resizer" id="split-resizer" hidden></div>
          <section class="editor-pane" data-pane-id="right" hidden>
            <div class="pane-editor-header">
              <input class="pane-editor-title pane-title-input" id="right-pane-title" data-pane-id="right" value="No tab" aria-label="Right editor tab title" disabled />
              <div class="child-tab-bar" id="right-child-tab-bar"></div>
            </div>
            <div class="editor-host" id="right-editor-host" data-testid="editor-host-right"></div>
          </section>
          <section class="novel-viewer-pane" id="novel-viewer-pane" data-testid="novel-viewer-pane" hidden>
            <form class="novel-viewer-header" id="novel-viewer-address-form">
              <button type="button" class="novel-viewer-button" id="novel-viewer-back" data-action="novel-viewer-back" aria-label="Back" title="Back">←</button>
              <button type="button" class="novel-viewer-button" id="novel-viewer-forward" data-action="novel-viewer-forward" aria-label="Forward" title="Forward">→</button>
              <button type="button" class="novel-viewer-button" id="novel-viewer-reload" data-action="novel-viewer-reload" aria-label="Reload" title="Reload">↻</button>
              <input class="novel-viewer-address" id="novel-viewer-address" type="text" inputmode="url" autocomplete="off" spellcheck="false" aria-label="Novel Viewer URL" placeholder="https://kakuyomu.jp/…" />
              <button type="button" class="novel-viewer-button" id="novel-viewer-external" data-action="novel-viewer-external" aria-label="Open in external browser" title="Open in external browser">↗</button>
              <button type="button" class="novel-viewer-button" id="novel-viewer-close" data-action="novel-viewer-close" aria-label="Close Novel Viewer" title="Close Novel Viewer">×</button>
            </form>
            <div class="novel-viewer-slot" id="novel-viewer-slot" tabindex="0">
              <div class="novel-viewer-local-state" id="novel-viewer-local-state" aria-live="polite"></div>
            </div>
          </section>
        </div>
      </main>
      <aside class="minimap-panel">
        <pre id="minimap" aria-hidden="true"></pre>
      </aside>
    </div>
    <footer class="status-bar">
      <span id="status-left"></span>
      <span id="status-right"></span>
    </footer>
  </div>
`;

const shell = document.querySelector<HTMLDivElement>(".shell")!;
const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
const searchPanel = document.querySelector<HTMLElement>("#search-panel")!;
const globalSearchLabel = document.querySelector<HTMLLabelElement>("#global-search-label")!;
const globalSearchInput = document.querySelector<HTMLInputElement>("#global-search-input")!;
const globalSearchSummary = document.querySelector<HTMLDivElement>("#global-search-summary")!;
const globalSearchResults = document.querySelector<HTMLDivElement>("#global-search-results")!;
const workspaceElement = document.querySelector<HTMLDivElement>(".workspace")!;
const editorArea = document.querySelector<HTMLElement>("#editor-area")!;
const sidebarResizer = document.querySelector<HTMLDivElement>("#sidebar-resizer")!;
const editorSplit = document.querySelector<HTMLDivElement>("#editor-split")!;
const splitResizer = document.querySelector<HTMLDivElement>("#split-resizer")!;
const leftPaneElement = document.querySelector<HTMLElement>('[data-pane-id="left"]')!;
const rightPaneElement = document.querySelector<HTMLElement>('[data-pane-id="right"]')!;
const novelViewerPane = document.querySelector<HTMLElement>("#novel-viewer-pane")!;
const novelViewerSlot = document.querySelector<HTMLDivElement>("#novel-viewer-slot")!;
const novelViewerLocalState = document.querySelector<HTMLDivElement>("#novel-viewer-local-state")!;
const novelViewerAddressForm = document.querySelector<HTMLFormElement>("#novel-viewer-address-form")!;
const novelViewerAddress = document.querySelector<HTMLInputElement>("#novel-viewer-address")!;
const novelViewerBack = document.querySelector<HTMLButtonElement>("#novel-viewer-back")!;
const novelViewerForward = document.querySelector<HTMLButtonElement>("#novel-viewer-forward")!;
const novelViewerReload = document.querySelector<HTMLButtonElement>("#novel-viewer-reload")!;
const novelViewerExternal = document.querySelector<HTMLButtonElement>("#novel-viewer-external")!;
const novelViewerClose = document.querySelector<HTMLButtonElement>("#novel-viewer-close")!;
const leftEditorHost = document.querySelector<HTMLDivElement>("#left-editor-host")!;
const rightEditorHost = document.querySelector<HTMLDivElement>("#right-editor-host")!;
const leftPaneTitle = document.querySelector<HTMLInputElement>("#left-pane-title")!;
const rightPaneTitle = document.querySelector<HTMLInputElement>("#right-pane-title")!;
const leftChildTabBar = document.querySelector<HTMLDivElement>("#left-child-tab-bar")!;
const rightChildTabBar = document.querySelector<HTMLDivElement>("#right-child-tab-bar")!;
const singleChildTabBar = document.querySelector<HTMLDivElement>("#single-child-tab-bar")!;
const activeTitleInput = document.querySelector<HTMLInputElement>("#active-title-input")!;
const activeMeta = document.querySelector<HTMLDivElement>("#active-meta")!;
const saveState = document.querySelector<HTMLDivElement>("#save-state")!;
const statusBar = document.querySelector<HTMLElement>(".status-bar")!;
const statusLeft = document.querySelector<HTMLSpanElement>("#status-left")!;
const statusRight = document.querySelector<HTMLSpanElement>("#status-right")!;
const minimap = document.querySelector<HTMLPreElement>("#minimap")!;

let workspace: WorkspaceState = { ...defaultWorkspace };
let tabIndex: TabsIndex = { tabs: [] };
let activeTabId: string | null = null;
let saveTimer: number | null = null;
let saveRetryTimer: number | null = null;
let saveRetryAttempt = 0;
let backupTimer: number | null = null;
let creatingTab = false;
let titleBeforeEdit = "";
let draggedItem: { type: "tab" | "group"; id: string } | null = null;
let selectedGroupId: string | null = null;
let globalSearchTimer: number | null = null;
let minimapTimer: number | null = null;
let globalSearchSequence = 0;
let globalSearchCache: GlobalSearchResult[] = [];
let workspaceImportedNeedsRestart = false;
let workspaceImportInProgress = false;
let appStateLoaded = false;
let bootstrapReadyForClose = false;
let statusContentCache = "";
let statusCharacterCountCache = 0;
let novelViewerOpen = false;
let novelViewerSinglePane = false;
let novelViewerAddressDirty = false;
let novelViewerLayoutRevision = 0;
let novelViewerBoundsFrame: number | null = null;
let novelViewerOcclusionRevision = 0;
let novelViewerOcclusionReasons = new Set<NovelViewerOcclusionReason>();
let lastPlaceholderDiagnosticSignature = "";
let novelViewerStatus: NovelViewerStatus = {
  lifecycle: "closed",
  isOpen: false,
  loading: false,
  canGoBack: false,
  canGoForward: false
};

const UNGROUPED_COLLAPSED_ID = "ungrouped:collapsed";
const SPLIT_PANE_MIN_WIDTH = 320;
const SPLIT_RESIZER_WIDTH = 5;

const contentCache = new Map<string, TabDocument>();
const dirtyTabIds = new Set<string>();

type EditorPaneState = {
  id: PaneId;
  element: HTMLElement;
  host: HTMLDivElement;
  titleElement: HTMLInputElement;
  childBar: HTMLDivElement;
  view: EditorView | null;
  activeTabId: string | null;
  activeChildTabId: string;
  programmaticChange: boolean;
  stateCache: Map<string, EditorState>;
  fontSizeCompartment: Compartment;
  themeCompartment: Compartment;
  readOnlyCompartment: Compartment;
};

const panes: Record<PaneId, EditorPaneState> = {
  left: {
    id: "left",
    element: leftPaneElement,
    host: leftEditorHost,
    titleElement: leftPaneTitle,
    childBar: leftChildTabBar,
    view: null,
    activeTabId: null,
    activeChildTabId: MAIN_CHILD_TAB_ID,
    programmaticChange: false,
    stateCache: new Map(),
    fontSizeCompartment: new Compartment(),
    themeCompartment: new Compartment(),
    readOnlyCompartment: new Compartment()
  },
  right: {
    id: "right",
    element: rightPaneElement,
    host: rightEditorHost,
    titleElement: rightPaneTitle,
    childBar: rightChildTabBar,
    view: null,
    activeTabId: null,
    activeChildTabId: MAIN_CHILD_TAB_ID,
    programmaticChange: false,
    stateCache: new Map(),
    fontSizeCompartment: new Compartment(),
    themeCompartment: new Compartment(),
    readOnlyCompartment: new Compartment()
  }
};

let activePaneId: PaneId = "left";

type UiText = {
  tabs: string;
  open: string;
  newTab: string;
  untitled: string;
  noOpenTab: string;
  data: string;
  lines: string;
  words: string;
  dark: string;
  light: string;
  empty: string;
  cancel: string;
  ok: string;
  rename: string;
  close: string;
  duplicate: string;
  pinTab: string;
  unpinTab: string;
  removeFromGroup: string;
  openInMain: string;
  openInSub: string;
  deletePermanently: string;
  delete: string;
  restore: string;
  newTitle: string;
  newTabInGroup: string;
  newGroup: string;
  groupTitle: string;
  ungrouped: string;
  deleteGroup: string;
  deleteGroupConfirm: (title: string) => string;
  newChildTab: string;
  childTabTitle: string;
  childTabDeleteConfirm: (title: string) => string;
  mainChildTab: string;
  memoChildTab: string;
  plotChildTab: string;
  settingChildTab: string;
  settings: string;
  newTabTemplate: string;
  templateSimple: string;
  templateNovel: string;
  templateReference: string;
  templateCustom: string;
  editCustomTemplate: string;
  customTemplateTitle: string;
  addTemplateItem: string;
  autoContinueLists: string;
  templateSaved: string;
  recentClosed: string;
  backupHistory: string;
  restoreBackup: string;
  restoreAsNewTab: string;
  noBackups: string;
  restoreConfirm: (title: string) => string;
  backupPreview: string;
  backupUnreadable: string;
  restoredTabSuffix: string;
  recoveryTitle: string;
  recoveryMessage: string;
  recoverPreviousSession: string;
  skipRecovery: string;
  deleteConfirm: (title: string) => string;
  globalSearch: string;
  closeSearch: string;
  searchPlaceholder: string;
  searchReady: string;
  searchRunning: string;
  noSearchResults: string;
  searchResults: (count: number) => string;
  titleMatch: string;
  searchFailed: string;
  exportWorkspaceFailed: string;
  importWorkspaceFailed: string;
  workspaceExported: string;
  workspaceImported: string;
  restartRequired: string;
  restartNow: string;
  restartFailed: string;
  currentWorkspaceBackup: string;
  splitRight: string;
  closeSplit: string;
  focusLeft: string;
  focusRight: string;
  saving: string;
  saved: string;
  unsaved: string;
  autosaveFailed: string;
  backupFailed: string;
  backupListFailed: string;
  noActiveTab: string;
  backupRestored: string;
  renamed: string;
  newTabCreated: string;
  newTabFailed: string;
  tabDuplicated: string;
  tabPinned: string;
  tabUnpinned: string;
  txtImported: string;
  importTxtFailed: string;
  tabOrderSaved: string;
  exported: string;
  exportAllFailed: string;
  copied: string;
  copyFailed: string;
  characters: string;
  selectedCharacters: (count: number) => string;
  lineColumn: (line: number, column: number) => string;
  actionFailed: string;
  startupFailed: string;
  languageChanged: string;
};

const uiText: Record<Locale, UiText> = {
  en: {
    tabs: "Open Tabs",
    open: "Open",
    newTab: "New tab",
    untitled: "Untitled",
    noOpenTab: "No open tab",
    data: "Data",
    lines: "lines",
    words: "words",
    dark: "dark",
    light: "light",
    empty: "Empty",
    cancel: "Cancel",
    ok: "OK",
    rename: "Rename",
    close: "Close",
    duplicate: "Duplicate",
    pinTab: "Pin",
    unpinTab: "Unpin",
    removeFromGroup: "Remove from Group",
    openInMain: "Open in Main",
    openInSub: "Open in Sub",
    deletePermanently: "Delete Permanently",
    delete: "Delete",
    restore: "Restore",
    newTitle: "New title",
    newTabInGroup: "Add New Tab",
    newGroup: "New Group",
    groupTitle: "Group name",
    ungrouped: "Ungrouped",
    deleteGroup: "Delete Group",
    deleteGroupConfirm: (title) => `Delete group "${title}"? Tabs in this group will move to Ungrouped.`,
    newChildTab: "New child tab",
    childTabTitle: "Child tab title",
    childTabDeleteConfirm: (title) => `Delete child tab "${title}"?`,
    mainChildTab: "Text",
    memoChildTab: "Memo",
    plotChildTab: "Plot",
    settingChildTab: "Setting",
    settings: "Settings",
    newTabTemplate: "New tab template",
    templateSimple: "Simple",
    templateNovel: "Novel",
    templateReference: "Reference",
    templateCustom: "Custom",
    editCustomTemplate: "Edit custom template",
    customTemplateTitle: "Custom template",
    addTemplateItem: "Add",
    autoContinueLists: "Continue lists automatically",
    templateSaved: "Template saved",
    recentClosed: "Recent / Closed",
    backupHistory: "Backup History",
    restoreBackup: "Restore Backup",
    restoreAsNewTab: "Restore as New Tab",
    noBackups: "No backups",
    restoreConfirm: (title) => `Restore "${title}" as a new tab?`,
    backupPreview: "Preview",
    backupUnreadable: "Unreadable backup",
    restoredTabSuffix: "Restored",
    recoveryTitle: "Restore previous session?",
    recoveryMessage: "The app did not shut down normally last time. Restore the previous editing session?",
    recoverPreviousSession: "Restore",
    skipRecovery: "Start without restoring",
    deleteConfirm: (title) => `Completely delete "${title}"? This removes the JSON file after creating a final backup.`,
    globalSearch: "Search",
    closeSearch: "Close search",
    searchPlaceholder: "Search all tabs",
    searchReady: "Type to search titles and text.",
    searchRunning: "Searching...",
    noSearchResults: "No results",
    searchResults: (count) => `${count} result${count === 1 ? "" : "s"}`,
    titleMatch: "Title",
    searchFailed: "Search failed",
    exportWorkspaceFailed: "Workspace export failed",
    importWorkspaceFailed: "Workspace import failed",
    workspaceExported: "Workspace exported",
    workspaceImported: "Workspace imported",
    restartRequired: "Import completed. Please restart the app to load the imported workspace.",
    restartNow: "Restart now",
    restartFailed: "Restart failed",
    currentWorkspaceBackup: "Current workspace backup",
    splitRight: "Split Right",
    closeSplit: "Close Split",
    focusLeft: "Focus Left Editor",
    focusRight: "Focus Right Editor",
    saving: "Saving",
    saved: "Saved",
    unsaved: "Unsaved",
    autosaveFailed: "Autosave failed",
    backupFailed: "Backup failed",
    backupListFailed: "Backup list failed",
    noActiveTab: "No active tab",
    backupRestored: "Backup restored",
    renamed: "Renamed",
    newTabCreated: "New tab created",
    newTabFailed: "New tab failed",
    tabDuplicated: "Tab duplicated",
    tabPinned: "Tab pinned",
    tabUnpinned: "Tab unpinned",
    txtImported: "TXT imported",
    importTxtFailed: "TXT import failed",
    tabOrderSaved: "Tab order saved",
    exported: "Exported",
    exportAllFailed: "Export all failed",
    copied: "Copied",
    copyFailed: "Copy failed",
    characters: "characters",
    selectedCharacters: (count) => `Selection ${count} characters`,
    lineColumn: (line, column) => `Ln ${line}, Col ${column}`,
    actionFailed: "Action failed",
    startupFailed: "Startup failed",
    languageChanged: "Language switched"
  },
  jp: {
    tabs: "開いているタブ",
    open: "開いているタブ",
    newTab: "新規タブ",
    untitled: "無題",
    noOpenTab: "開いているタブはありません",
    data: "保存先",
    lines: "行",
    words: "文字/語",
    dark: "ダーク",
    light: "ライト",
    empty: "空です",
    cancel: "キャンセル",
    ok: "OK",
    rename: "名前変更",
    close: "閉じる",
    duplicate: "複製",
    pinTab: "ピン留め",
    unpinTab: "ピン留めを解除",
    removeFromGroup: "グループから外す",
    openInMain: "メインで開く",
    openInSub: "サブで開く",
    deletePermanently: "完全削除",
    delete: "削除",
    restore: "復元",
    newTitle: "新しいタブ名",
    newTabInGroup: "新規タブを追加",
    newGroup: "新規グループ",
    groupTitle: "大項目名",
    ungrouped: "未分類",
    deleteGroup: "グループ削除",
    deleteGroupConfirm: (title) => `大項目「${title}」を削除しますか？ 配下のタブは未分類へ移動します。`,
    newChildTab: "小タブを追加",
    childTabTitle: "小タブ名",
    childTabDeleteConfirm: (title) => `小タブ「${title}」を削除しますか？`,
    mainChildTab: "本文",
    memoChildTab: "メモ",
    plotChildTab: "プロット",
    settingChildTab: "設定",
    settings: "設定",
    newTabTemplate: "新規タブテンプレート",
    templateSimple: "シンプル",
    templateNovel: "小説",
    templateReference: "資料",
    templateCustom: "カスタム",
    editCustomTemplate: "カスタムテンプレートを編集",
    customTemplateTitle: "カスタムテンプレート",
    addTemplateItem: "追加",
    autoContinueLists: "箇条書きを自動継続",
    templateSaved: "テンプレートを保存しました",
    recentClosed: "最近閉じたタブ",
    backupHistory: "バックアップ履歴",
    restoreBackup: "バックアップから復元",
    restoreAsNewTab: "新規タブとして復元",
    noBackups: "バックアップはありません",
    restoreConfirm: (title) => `「${title}」を新規タブとして復元しますか？`,
    backupPreview: "プレビュー",
    backupUnreadable: "読み込めないバックアップ",
    restoredTabSuffix: "復元",
    recoveryTitle: "前回の編集状態を復元しますか？",
    recoveryMessage: "前回、アプリが正常に終了しませんでした。前回の編集状態を復元しますか？",
    recoverPreviousSession: "復元する",
    skipRecovery: "復元せず起動",
    deleteConfirm: (title) => `「${title}」を完全削除しますか？ 最終バックアップを作成してから JSON ファイルを削除します。`,
    globalSearch: "検索",
    closeSearch: "検索を閉じる",
    searchPlaceholder: "全タブを検索",
    searchReady: "タイトルと本文を検索できます。",
    searchRunning: "検索中...",
    noSearchResults: "結果はありません",
    searchResults: (count) => `${count} 件`,
    titleMatch: "タイトル",
    searchFailed: "検索に失敗しました",
    exportWorkspaceFailed: "Workspace のエクスポートに失敗しました",
    importWorkspaceFailed: "Workspace のインポートに失敗しました",
    workspaceExported: "Workspace をエクスポートしました",
    workspaceImported: "Workspace をインポートしました",
    restartRequired: "インポートが完了しました。反映するにはアプリを再起動してください。",
    restartNow: "今すぐ再起動",
    restartFailed: "再起動に失敗しました",
    currentWorkspaceBackup: "現在のWorkspaceバックアップ",
    splitRight: "右に分割",
    closeSplit: "分割を閉じる",
    focusLeft: "左エディタへフォーカス",
    focusRight: "右エディタへフォーカス",
    saving: "保存中",
    saved: "保存済み",
    unsaved: "未保存",
    autosaveFailed: "自動保存に失敗しました",
    backupFailed: "バックアップに失敗しました",
    backupListFailed: "バックアップ一覧の取得に失敗しました",
    noActiveTab: "アクティブなタブがありません",
    backupRestored: "バックアップを復元しました",
    renamed: "名前を変更しました",
    newTabCreated: "新規タブを作成しました",
    newTabFailed: "新規タブの作成に失敗しました",
    tabDuplicated: "タブを複製しました",
    tabPinned: "タブをピン留めしました",
    tabUnpinned: "ピン留めを解除しました",
    txtImported: "TXT を読み込みました",
    importTxtFailed: "TXT 読み込みに失敗しました",
    tabOrderSaved: "タブ順を保存しました",
    exported: "出力しました",
    exportAllFailed: "全タブ出力に失敗しました",
    copied: "コピーしました",
    copyFailed: "コピーに失敗しました",
    characters: "文字",
    selectedCharacters: (count) => `選択 ${count}文字`,
    lineColumn: (line, column) => `Ln ${line}, Col ${column}`,
    actionFailed: "操作に失敗しました",
    startupFailed: "起動に失敗しました",
    languageChanged: "言語を切り替えました"
  }
};

function text(): UiText {
  return uiText[workspace.locale ?? "en"];
}

function setSaveState(message: string, mode: "idle" | "dirty" | "error" = "idle"): void {
  saveState.textContent = message;
  saveState.dataset.mode = mode;
  statusBar.dataset.mode = mode;
  updateStatusLine();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowIso(): string {
  return new Date().toISOString();
}

function nextTabId(): string {
  const knownIds = new Set([
    ...tabIndex.tabs.map((tab) => tab.id),
    ...workspace.openedTabIds,
    ...workspace.recentTabIds,
    ...contentCache.keys()
  ]);
  const max = [...knownIds].reduce((highest, id) => {
    const match = /^tab-(\d+)$/.exec(id);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  const next = `tab-${String(max + 1).padStart(3, "0")}`;
  return knownIds.has(next) ? `tab-${Date.now()}` : next;
}

function nextUntitledTitle(): string {
  const base = text().untitled;
  const count = tabIndex.tabs.reduce((total, tab) => (tab.title.startsWith(base) ? total + 1 : total), 0);
  return count === 0 ? base : `${base} ${count + 1}`;
}

function ensureTabsIndex(index = tabIndex): TabsIndex {
  return normalizeTabsIndex(index);
}

function tabMeta(id: string): TabMeta | undefined {
  return tabIndex.tabs.find((tab) => tab.id === id);
}

function isTabPinned(id: string): boolean {
  return Boolean(tabMeta(id)?.pinned);
}

function orderTabIdsByPinned(tabIds: string[]): string[] {
  const pinned: string[] = [];
  const normal: string[] = [];
  tabIds.forEach((id) => (isTabPinned(id) ? pinned : normal).push(id));
  return [...pinned, ...normal];
}

function normalizePinnedOrderInIndex(index: TabsIndex): TabsIndex {
  const pinnedById = new Map(index.tabs.map((tab) => [tab.id, Boolean(tab.pinned)]));
  const orderIds = (tabIds: string[]): string[] => {
    const pinned: string[] = [];
    const normal: string[] = [];
    tabIds.forEach((id) => (pinnedById.get(id) ? pinned : normal).push(id));
    return [...pinned, ...normal];
  };
  return normalizeTabsIndex({
    ...index,
    groups: index.groups?.map((group) => ({
      ...group,
      tabIds: orderIds(group.tabIds)
    })),
    ungroupedTabIds: orderIds(index.ungroupedTabIds ?? [])
  });
}

function groupForTab(tabId: string): TabGroup | null {
  return tabIndex.groups?.find((group) => group.tabIds.includes(tabId)) ?? null;
}

function tabGroupId(tabId: string): string | null {
  return groupForTab(tabId)?.id ?? null;
}

function localGroupTitleForTab(tabId: string): string {
  return groupTitleForTab(tabIndex, tabId, text().ungrouped);
}

function nextGroupId(): string {
  const ids = new Set((tabIndex.groups ?? []).map((group) => group.id));
  const max = [...ids].reduce((highest, id) => {
    const match = /^group-(\d+)$/.exec(id);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  const next = `group-${String(max + 1).padStart(3, "0")}`;
  return ids.has(next) ? `group-${Date.now()}` : next;
}

function flattenedOpenedTabIds(): string[] {
  const opened = new Set(workspace.openedTabIds);
  const ordered = [
    ...(tabIndex.groups ?? []).flatMap((group) => orderTabIdsByPinned(group.tabIds)),
    ...orderTabIdsByPinned(tabIndex.ungroupedTabIds ?? [])
  ].filter((id) => opened.has(id));
  const seen = new Set(ordered);
  return [...ordered, ...workspace.openedTabIds.filter((id) => !seen.has(id) && tabMeta(id))];
}

function removeTabFromIndexGroups(index: TabsIndex, tabId: string): TabsIndex {
  return normalizeTabsIndex({
    ...index,
    groups: index.groups?.map((group) => ({
      ...group,
      tabIds: group.tabIds.filter((id) => id !== tabId)
    })),
    ungroupedTabIds: index.ungroupedTabIds?.filter((id) => id !== tabId)
  });
}

function insertTabIntoIndexGroup(index: TabsIndex, tabId: string, groupId: string | null, targetId?: string, placement: "before" | "after" | "end" = "end"): TabsIndex {
  const cleaned = removeTabFromIndexGroups(index, tabId);
  const insert = (ids: string[]): string[] => {
    const next = ids.filter((id) => id !== tabId);
    if (targetId && placement !== "end") {
      const targetIndex = next.indexOf(targetId);
      if (targetIndex !== -1) {
        next.splice(placement === "before" ? targetIndex : targetIndex + 1, 0, tabId);
        return next;
      }
    }
    next.push(tabId);
    return next;
  };

  if (groupId) {
    return normalizeTabsIndex({
      ...cleaned,
      groups: cleaned.groups?.map((group) =>
        group.id === groupId
          ? {
              ...group,
              tabIds: insert(group.tabIds),
              updatedAt: nowIso()
            }
          : group
      )
    });
  }

  return normalizeTabsIndex({
    ...cleaned,
    ungroupedTabIds: insert(cleaned.ungroupedTabIds ?? [])
  });
}

function selectedTargetGroupId(): string | null {
  return selectedGroupId && tabIndex.groups?.some((group) => group.id === selectedGroupId) ? selectedGroupId : null;
}

function expandTargetGroup(groupId: string | null): void {
  if (groupId) {
    tabIndex = normalizeTabsIndex({
      ...tabIndex,
      groups: tabIndex.groups?.map((group) => (group.id === groupId ? { ...group, collapsed: false, updatedAt: nowIso() } : group))
    });
  } else {
    workspace.expandedIds = workspace.expandedIds.filter((entry) => entry !== UNGROUPED_COLLAPSED_ID);
  }
}

async function saveTabsIndex(): Promise<void> {
  tabIndex = normalizePinnedOrderInIndex(await window.textEditor.saveTabsIndex(normalizePinnedOrderInIndex(tabIndex)));
}

function localizedMainChildTitle(): string {
  return text().mainChildTab;
}

function normalizeTemplateTitles(titles: string[] | undefined): string[] {
  const seen = new Set<string>();
  const names = (titles ?? [MAIN_CHILD_TAB_TITLE])
    .map((title) => title.trim())
    .filter((title) => title.length > 0 && title !== MAIN_CHILD_TAB_TITLE && title !== localizedMainChildTitle())
    .filter((title) => {
      if (seen.has(title)) {
        return false;
      }
      seen.add(title);
      return true;
    });
  return [localizedMainChildTitle(), ...names];
}

function templateTitles(templateId: NewTabTemplateId = workspace.newTabTemplate): string[] {
  if (templateId === "novel") {
    return [localizedMainChildTitle(), text().memoChildTab, text().plotChildTab];
  }
  if (templateId === "reference") {
    return [localizedMainChildTitle(), text().settingChildTab];
  }
  if (templateId === "custom") {
    return normalizeTemplateTitles(workspace.templates?.custom);
  }
  return [localizedMainChildTitle()];
}

function childIdFromTitle(title: string, usedIds: Set<string>): string {
  const known: Record<string, string> = {
    [text().memoChildTab]: "memo",
    [text().plotChildTab]: "plot",
    [text().settingChildTab]: "setting",
    メモ: "memo",
    プロット: "plot",
    設定: "setting",
    Memo: "memo",
    Plot: "plot",
    Setting: "setting"
  };
  const knownId = known[title];
  const base = (knownId || title.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "child").slice(0, 36);
  let id = base;
  let index = 2;
  while (usedIds.has(id) || id === MAIN_CHILD_TAB_ID) {
    id = `${base}-${index}`;
    index += 1;
  }
  usedIds.add(id);
  return id;
}

function childTabsFromTemplate(mainContent: string, updatedAt: string): ChildTabDocument[] {
  const titles = templateTitles();
  const usedIds = new Set<string>([MAIN_CHILD_TAB_ID]);
  return titles.map((title, index) =>
    index === 0
      ? {
          id: MAIN_CHILD_TAB_ID,
          title: localizedMainChildTitle(),
          content: mainContent,
          updatedAt
        }
      : {
          id: childIdFromTitle(title, usedIds),
          title,
          content: "",
          updatedAt
        }
  );
}

function ensureTab(tab: TabDocument): TabDocument {
  const normalized = normalizeTabDocument(tab);
  const children = getChildTabs(normalized);
  const mainChild = children.find((child) => child.id === MAIN_CHILD_TAB_ID);
  if (mainChild && mainChild.title === MAIN_CHILD_TAB_TITLE) {
    mainChild.title = localizedMainChildTitle();
  }
  return {
    ...normalized,
    content: mainChild?.content ?? normalized.content,
    childTabs: children
  };
}

function childTabForPane(tab: TabDocument, pane: EditorPaneState): ChildTabDocument {
  const normalized = ensureTab(tab);
  return getActiveChildTab(normalized, pane.activeChildTabId);
}

function activeChildContent(pane = activePane()): string {
  const tab = pane.activeTabId ? contentCache.get(pane.activeTabId) : null;
  return tab ? childTabForPane(tab, pane).content : "";
}

function nextChildTabId(tab: TabDocument, title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const prefix = base || "child";
  const ids = new Set(getChildTabs(tab).map((child) => child.id));
  if (!ids.has(prefix) && prefix !== MAIN_CHILD_TAB_ID) {
    return prefix;
  }
  let index = 2;
  while (ids.has(`${prefix}-${index}`)) {
    index += 1;
  }
  return `${prefix}-${index}`;
}

function setChildContent(tab: TabDocument, childTabId: string, content: string): TabDocument {
  const normalized = ensureTab(tab);
  const updatedAt = nowIso();
  const children = getChildTabs(normalized).map((child) =>
    child.id === childTabId
      ? {
          ...child,
          content,
          updatedAt
        }
      : child
  );
  const mainChild = children.find((child) => child.id === MAIN_CHILD_TAB_ID);
  return {
    ...normalized,
    content: mainChild?.content ?? normalized.content,
    activeChildTabId: childTabId,
    childTabs: children,
    updatedAt
  };
}

function activePane(): EditorPaneState {
  return panes[activePaneId] ?? panes.left;
}

function paneForId(id: PaneId): EditorPaneState {
  return panes[id] ?? panes.left;
}

function syncActiveTabId(): void {
  activeTabId = activePane().activeTabId;
  workspace.activeTabId = activeTabId;
  workspace.layout.activePaneId = activePaneId;
  workspace.layout.panes = [
    { id: "left", activeTabId: panes.left.activeTabId, activeChildTabId: panes.left.activeChildTabId },
    { id: "right", activeTabId: panes.right.activeTabId, activeChildTabId: panes.right.activeChildTabId }
  ];
}

function activeDocument(): TabDocument | null {
  const id = activePane().activeTabId;
  return id ? contentCache.get(id) ?? null : null;
}

function isRemoteInboxTabId(id: string | null | undefined): boolean {
  const title = id ? tabMeta(id)?.title ?? contentCache.get(id)?.title : "";
  if (!title) return false;
  return new Set([workspace.remoteInbox.targetTabName, ...workspace.remoteInbox.targetTabNames]).has(title);
}

function editorReadOnlyExtensions(pane: EditorPaneState) {
  const readOnly = !bootstrapReadyForClose || workspaceImportedNeedsRestart || workspaceImportInProgress || isRemoteInboxTabId(pane.activeTabId);
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

function updateMetaFromDocument(tab: TabDocument): void {
  const normalized = ensureTab(tab);
  const meta: TabMeta = {
    id: normalized.id,
    title: normalized.title,
    updatedAt: normalized.updatedAt,
    wordCount: countWords(getMainChildTab(normalized).content),
    pinned: tabIndex.tabs.find((entry) => entry.id === normalized.id)?.pinned ?? false
  };
  tabIndex = normalizeTabsIndex({
    ...tabIndex,
    tabs: tabIndex.tabs.some((entry) => entry.id === normalized.id)
      ? tabIndex.tabs.map((entry) => (entry.id === normalized.id ? meta : entry))
      : [...tabIndex.tabs, meta]
  });
}

async function saveWorkspace(): Promise<void> {
  const serializedSnapshot = JSON.stringify(workspace);
  const snapshot = JSON.parse(serializedSnapshot) as WorkspaceState;
  const normalized = await window.textEditor.saveWorkspace(snapshot);
  if (JSON.stringify(workspace) === serializedSnapshot) {
    workspace = normalized;
  }
}

function clearSaveRetry(): void {
  if (saveRetryTimer !== null) {
    window.clearTimeout(saveRetryTimer);
    saveRetryTimer = null;
  }
}

function scheduleSaveRetry(): void {
  if (saveRetryTimer !== null || dirtyTabIds.size === 0 || saveRetryAttempt >= 3) {
    return;
  }
  const delay = 750 * 2 ** saveRetryAttempt;
  saveRetryAttempt += 1;
  saveRetryTimer = window.setTimeout(() => {
    saveRetryTimer = null;
    void saveCurrentTabNow();
  }, delay);
}

async function saveCurrentTabNow(options: { retry?: boolean } = {}): Promise<boolean> {
  const targetIds = [...dirtyTabIds];
  if (targetIds.length === 0) {
    clearSaveRetry();
    saveRetryAttempt = 0;
    return true;
  }

  try {
    setSaveState(text().saving, "dirty");
    for (const id of targetIds) {
      const tab = contentCache.get(id);
      if (!tab) {
        continue;
      }
      const savedVersion = tab.updatedAt;
      const saved = ensureTab(await window.textEditor.saveTab(tab));
      const latest = contentCache.get(id);
      if (latest && latest.updatedAt !== savedVersion) {
        updateMetaFromDocument(latest);
        continue;
      }
      contentCache.set(saved.id, saved);
      updateMetaFromDocument(saved);
      dirtyTabIds.delete(saved.id);
    }
    if (dirtyTabIds.size > 0) {
      setSaveState(text().unsaved, "dirty");
      if (saveTimer === null) {
        saveTimer = window.setTimeout(() => {
          saveTimer = null;
          void saveCurrentTabNow();
        }, 250);
      }
    } else {
      clearSaveRetry();
      saveRetryAttempt = 0;
      setSaveState(text().saved);
    }
    renderSidebar();
    updateStatus();
    return dirtyTabIds.size === 0;
  } catch (error) {
    setSaveState(text().autosaveFailed, "error");
    console.error(error);
    if (options.retry !== false) {
      scheduleSaveRetry();
    }
    return false;
  }
}

function scheduleSave(tabId = activePane().activeTabId): void {
  if (tabId) {
    dirtyTabIds.add(tabId);
  }
  clearSaveRetry();
  saveRetryAttempt = 0;
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
  }
  setSaveState(text().unsaved, "dirty");
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void saveCurrentTabNow();
  }, 700);
}

async function flushSave(options: { retry?: boolean } = {}): Promise<boolean> {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
  clearSaveRetry();
  return saveCurrentTabNow(options);
}

async function backupCurrentTab(): Promise<void> {
  const tab = activeDocument();
  if (!tab) {
    return;
  }

  try {
    await window.textEditor.createBackup(tab);
  } catch (error) {
    setSaveState(`${text().backupFailed}: ${errorMessage(error)}`, "error");
    console.error(error);
  }
}

function startBackupTimer(): void {
  if (backupTimer !== null) {
    window.clearInterval(backupTimer);
  }
  backupTimer = window.setInterval(() => {
    void backupCurrentTab();
  }, 60_000);
}

function editorTheme(): ReturnType<typeof EditorView.theme> {
  return EditorView.theme({
    "&": {
      height: "100%",
      color: workspace.theme === "dark" ? "#d4d4d4" : "#202124",
      backgroundColor: workspace.theme === "dark" ? "#1e1e1e" : "#ffffff",
      fontSize: `${workspace.fontSize}px`
    },
    ".cm-scroller": {
      fontFamily: "'Yu Gothic UI', 'Meiryo', Consolas, monospace",
      lineHeight: "1.75"
    },
    ".cm-gutters": {
      backgroundColor: workspace.theme === "dark" ? "#252526" : "#f5f5f5",
      color: workspace.theme === "dark" ? "#858585" : "#6b7280",
      borderRight: `1px solid ${workspace.theme === "dark" ? "#3a3a3a" : "#d8d8d8"}`
    },
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "3.6em",
      padding: "0 0.75em 0 0.5em",
      textAlign: "right"
    },
    ".cm-lineNumbers .cm-gutterElement::after": {
      content: "'.'",
      paddingLeft: "1px"
    },
    ".cm-activeLine": {
      backgroundColor: workspace.theme === "dark" ? "#2a2d2e" : "#f1f5f9"
    },
    ".cm-activeLineGutter": {
      backgroundColor: workspace.theme === "dark" ? "#2a2d2e" : "#e8eef7"
    },
    ".cm-content": {
      caretColor: workspace.theme === "dark" ? "#ffffff" : "#111827",
      padding: "18px 0"
    },
    ".cm-line": {
      padding: "0 18px"
    }
  });
}

function paneDocumentKey(pane: EditorPaneState): string | null {
  return pane.activeTabId ? `${pane.activeTabId}:${pane.activeChildTabId}` : null;
}

function cachePaneEditorState(pane: EditorPaneState): void {
  const key = paneDocumentKey(pane);
  if (key && pane.view) {
    pane.stateCache.set(key, pane.view.state);
  }
}

function syncEditorTransaction(sourcePane: EditorPaneState, transaction: Transaction): void {
  const sourceKey = paneDocumentKey(sourcePane);
  if (!sourceKey || !sourcePane.view) {
    return;
  }

  (Object.values(panes) as EditorPaneState[]).forEach((targetPane) => {
    if (targetPane.id === sourcePane.id || paneDocumentKey(targetPane) !== sourceKey || !targetPane.view) {
      return;
    }
    if (targetPane.view.state.doc.toString() !== transaction.startState.doc.toString()) {
      setPaneEditorContent(targetPane, sourcePane.view!.state.doc.toString());
      return;
    }
    targetPane.programmaticChange = true;
    targetPane.view.dispatch({
      changes: transaction.changes,
      annotations: Transaction.addToHistory.of(false)
    });
    targetPane.programmaticChange = false;
    cachePaneEditorState(targetPane);
  });
}

function continueListOnEnter(view: EditorView): boolean {
  const range = view.state.selection.main;
  if (!range.empty) {
    return false;
  }
  const line = view.state.doc.lineAt(range.head);
  if (range.head !== line.to) {
    return false;
  }
  const textBeforeCursor = line.text;
  const bulletMatch = /^(\s*)([-*+])\s+(.*)$/.exec(textBeforeCursor);
  const numberedMatch = /^(\s*)(\d+)\.\s+(.*)$/.exec(textBeforeCursor);
  const match = bulletMatch ?? numberedMatch;
  if (!match) {
    return false;
  }

  const [, indent, marker, body] = match;
  if (!workspace.autoContinueLists) {
    view.dispatch({
      changes: { from: range.head, insert: "\n" },
      selection: { anchor: range.head + 1 },
      userEvent: "input"
    });
    return true;
  }

  if (body.trim().length === 0) {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: "" },
      selection: { anchor: line.from },
      userEvent: "input"
    });
    return true;
  }

  const nextMarker = numberedMatch ? `${Number(marker) + 1}.` : marker;
  view.dispatch({
    changes: { from: range.head, insert: `\n${indent}${nextMarker} ` },
    selection: { anchor: range.head + indent.length + nextMarker.length + 2 },
    userEvent: "input"
  });
  return true;
}

function createEditorState(pane: EditorPaneState, content: string): EditorState {
  return EditorState.create({
    doc: content,
    extensions: [
      lineNumbers(),
      history(),
      markdown(),
      search({ top: true }),
      highlightActiveLine(),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        const key = paneDocumentKey(pane);
        if (key) {
          pane.stateCache.set(key, update.state);
        }
        if (!update.docChanged || pane.programmaticChange || !pane.activeTabId) {
          if (update.selectionSet && pane.id === activePaneId) {
            updateStatusLine();
          }
          return;
        }
        setActivePane(pane.id);
        const current = contentCache.get(pane.activeTabId);
        if (!current) {
          return;
        }
        const updated = setChildContent(current, pane.activeChildTabId, update.state.doc.toString());
        contentCache.set(pane.activeTabId, updated);
        updateMetaFromDocument(updated);
        update.transactions.forEach((transaction) => syncEditorTransaction(pane, transaction));
        scheduleMinimapUpdate();
        updateStatusLine(updated);
        scheduleSave(updated.id);
      }),
      Prec.highest(
        keymap.of([
          { key: "Enter", run: continueListOnEnter }
        ])
      ),
      keymap.of([
        { key: "Mod-h", run: openSearchPanel },
        indentWithTab,
        ...searchKeymap,
        ...defaultKeymap,
        ...historyKeymap
      ]),
      pane.fontSizeCompartment.of([]),
      pane.themeCompartment.of(editorTheme()),
      pane.readOnlyCompartment.of(editorReadOnlyExtensions(pane))
    ]
  });
}

function createEditor(pane: EditorPaneState): void {
  pane.view = new EditorView({
    parent: pane.host,
    state: createEditorState(pane, "")
  });
  pane.host.tabIndex = -1;
  pane.host.addEventListener("focus", () => pane.view?.focus());
  pane.host.addEventListener("focusin", () => setActivePane(pane.id));
  pane.element.addEventListener("pointerdown", (event) => {
    if ((event.target as HTMLElement).closest(".child-tab-bar")) {
      return;
    }
    setActivePane(pane.id);
  });
}

function setPaneEditorContent(pane: EditorPaneState, content: string): void {
  if (!pane.view) {
    return;
  }
  const key = paneDocumentKey(pane);
  const cached = key ? pane.stateCache.get(key) : null;
  const state = cached?.doc.toString() === content ? cached : createEditorState(pane, content);
  pane.programmaticChange = true;
  try {
    pane.view.setState(state);
    pane.view.dispatch({ effects: pane.readOnlyCompartment.reconfigure(editorReadOnlyExtensions(pane)) });
    if (key) {
      pane.stateCache.set(key, pane.view.state);
    }
  } finally {
    pane.programmaticChange = false;
  }
  updateMinimap();
}

function setPaneEditorEnabled(pane: EditorPaneState, enabled: boolean): void {
  pane.host.classList.toggle("is-empty", !enabled);
}

function setEditorEnabled(enabled: boolean): void {
  setPaneEditorEnabled(activePane(), enabled);
}

function syncPaneViewsForTab(tabId: string, sourcePaneId?: PaneId, childTabId?: string): void {
  const tab = contentCache.get(tabId);
  if (!tab) {
    return;
  }
  (Object.values(panes) as EditorPaneState[]).forEach((pane) => {
    if (pane.id !== sourcePaneId && pane.activeTabId === tabId && (!childTabId || pane.activeChildTabId === childTabId)) {
      setPaneEditorContent(pane, childTabForPane(tab, pane).content);
    }
  });
}

function updateMinimap(): void {
  const content = activeChildContent();
  if (!activeDocument()) {
    minimap.textContent = "";
    return;
  }
  minimap.textContent = content
    .split(/\r?\n/)
    .slice(0, 900)
    .map((line) => line.replace(/\s+/g, " ").slice(0, 46))
    .join("\n");
}

function scheduleMinimapUpdate(): void {
  if (minimapTimer !== null) {
    window.clearTimeout(minimapTimer);
  }
  minimapTimer = window.setTimeout(() => {
    minimapTimer = null;
    updateMinimap();
  }, 120);
}

function countDisplayCharacters(content: string): number {
  const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(workspace.locale === "jp" ? "ja" : "en", { granularity: "grapheme" }) : null;
  return segmenter ? [...segmenter.segment(content)].length : Array.from(content).length;
}

function cachedCharacterCount(content: string): number {
  if (content !== statusContentCache) {
    statusContentCache = content;
    statusCharacterCountCache = countDisplayCharacters(content);
  }
  return statusCharacterCountCache;
}

function selectionCharacterCount(view: EditorView | null): number {
  if (!view) {
    return 0;
  }
  let total = 0;
  view.state.selection.ranges.forEach((range) => {
    if (!range.empty) {
      total += countDisplayCharacters(view.state.sliceDoc(range.from, range.to));
    }
  });
  return total;
}

function cursorLineColumn(view: EditorView | null): { line: number; column: number } {
  if (!view) {
    return { line: 1, column: 1 };
  }
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return {
    line: line.number,
    column: head - line.from + 1
  };
}

function updateStatusLine(tab: TabDocument | null = activeDocument()): void {
  const label = text();
  if (!tab) {
    statusLeft.textContent = saveState.textContent || label.saved;
    statusRight.textContent = "";
    return;
  }

  const child = childTabForPane(tab, activePane());
  const characterCount = cachedCharacterCount(child.content);
  const selectedCount = selectionCharacterCount(activePane().view);
  const position = cursorLineColumn(activePane().view);
  statusLeft.textContent = [
    saveState.textContent || label.saved,
    `${characterCount.toLocaleString()} ${label.characters}`,
    selectedCount > 0 ? label.selectedCharacters(selectedCount) : "",
    label.lineColumn(position.line, position.column)
  ]
    .filter(Boolean)
    .join("    ");
  statusRight.textContent = `${workspace.fontSize}px`;
}

function updateStatus(): void {
  const tab = activeDocument();
  const label = text();
  updatePaneTitles();
  renderChildTabBars();
  if (!tab) {
    activeTitleInput.value = label.noOpenTab;
    activeTitleInput.disabled = true;
    activeMeta.textContent = "";
    delete activeMeta.dataset.tabId;
    delete activeTitleInput.dataset.tabId;
    updateStatusLine(null);
    return;
  }

  const child = childTabForPane(tab, activePane());
  const lineCount = child.content.length === 0 ? 1 : child.content.split(/\r?\n/).length;
  if (document.activeElement !== activeTitleInput) {
    activeTitleInput.value = tab.title;
  }
    activeTitleInput.disabled = !bootstrapReadyForClose || workspaceImportedNeedsRestart || workspaceImportInProgress || isRemoteInboxTabId(tab.id);
  activeTitleInput.dataset.tabId = tab.id;
  activeMeta.dataset.tabId = tab.id;
  activeMeta.textContent = `${child.title} / ${lineCount} ${label.lines} / ${countWords(child.content)} ${label.words}`;
  updateStatusLine(tab);
}

function isExpanded(id: string): boolean {
  if (id === UNGROUPED_GROUP_ID && !workspace.expandedIds.includes(id)) {
    return true;
  }
  return workspace.expandedIds.includes(id);
}

function isUngroupedCollapsed(): boolean {
  return workspace.expandedIds.includes(UNGROUPED_COLLAPSED_ID);
}

async function setUngroupedCollapsed(collapsed: boolean): Promise<void> {
  workspace.expandedIds = collapsed
    ? Array.from(new Set([...workspace.expandedIds, UNGROUPED_COLLAPSED_ID]))
    : workspace.expandedIds.filter((entry) => entry !== UNGROUPED_COLLAPSED_ID);
  await saveWorkspace();
}

function setExpanded(id: string, expanded: boolean): void {
  workspace.expandedIds = expanded
    ? Array.from(new Set([...workspace.expandedIds, id]))
    : workspace.expandedIds.filter((entry) => entry !== id);
  void saveWorkspace();
  renderSidebar();
}

function updatePaneTitles(): void {
  (Object.values(panes) as EditorPaneState[]).forEach((pane) => {
    const tab = pane.activeTabId ? contentCache.get(pane.activeTabId) ?? tabIndex.tabs.find((entry) => entry.id === pane.activeTabId) : null;
    if (!tab) {
      if (document.activeElement !== pane.titleElement) {
        pane.titleElement.value = text().noOpenTab;
      }
      pane.titleElement.disabled = true;
      delete pane.titleElement.dataset.tabId;
      return;
    }
    if (document.activeElement !== pane.titleElement) {
      pane.titleElement.value = tab.title;
    }
    pane.titleElement.disabled = !bootstrapReadyForClose || workspaceImportedNeedsRestart || workspaceImportInProgress || isRemoteInboxTabId(tab.id);
    pane.titleElement.dataset.tabId = tab.id;
  });
}

function childTabBarMarkup(pane: EditorPaneState): string {
  const tab = pane.activeTabId ? contentCache.get(pane.activeTabId) : null;
  if (!tab) {
    return "";
  }
  const normalized = ensureTab(tab);
  const children = getChildTabs(normalized);
  if (!children.some((child) => child.id === pane.activeChildTabId)) {
    pane.activeChildTabId = normalized.activeChildTabId ?? MAIN_CHILD_TAB_ID;
  }
  return `
    ${children
      .map(
        (child) => `
          <button type="button" class="child-tab-button ${child.id === pane.activeChildTabId ? "is-active" : ""}" data-action="activate-child-tab" data-pane-id="${pane.id}" data-id="${normalized.id}" data-child-id="${child.id}">
            ${escapeHtml(child.title)}
          </button>
        `
      )
      .join("")}
    ${isRemoteInboxTabId(normalized.id) ? "" : `<button type="button" class="child-tab-add" data-action="new-child-tab" data-pane-id="${pane.id}" data-id="${normalized.id}" title="${escapeHtml(text().newChildTab)}" aria-label="${escapeHtml(text().newChildTab)}">+</button>`}
  `;
}

function renderChildTabBars(): void {
  (Object.values(panes) as EditorPaneState[]).forEach((pane) => {
    pane.childBar.innerHTML = childTabBarMarkup(pane);
  });
  singleChildTabBar.innerHTML = childTabBarMarkup(activePane());
}

function setActivePane(id: PaneId): void {
  activePaneId = id;
  syncActiveTabId();
  (Object.values(panes) as EditorPaneState[]).forEach((pane) => {
    const active = pane.id === activePaneId;
    pane.element.classList.toggle("is-active", active);
    pane.host.dataset.testid = active ? "active-editor-host" : `editor-host-${pane.id}`;
  });
  updateStatus();
}

function novelViewerText() {
  return workspace.locale === "jp"
    ? {
        back: "戻る",
        forward: "進む",
        reload: "再読み込み",
        stop: "停止",
        external: "外部ブラウザで開く",
        close: "Novel Viewerを閉じる",
        address: "Novel Viewer URL",
        empty: "カクヨムまたは小説家になろうの公開作品URLを入力してください。",
        loading: "ページを読み込んでいます…",
        restoreWarning: "保存したスクロール位置を復元できませんでした。"
      }
    : {
        back: "Back",
        forward: "Forward",
        reload: "Reload",
        stop: "Stop",
        external: "Open in external browser",
        close: "Close Novel Viewer",
        address: "Novel Viewer URL",
        empty: "Enter a public Kakuyomu or Shōsetsuka ni Narō URL.",
        loading: "Loading page…",
        restoreWarning: "The saved reading position could not be restored."
      };
}

function applyNovelViewerLabels(): void {
  const label = novelViewerText();
  const controls: Array<[HTMLElement, string]> = [
    [novelViewerBack, label.back],
    [novelViewerForward, label.forward],
    [novelViewerReload, novelViewerStatus.loading ? label.stop : label.reload],
    [novelViewerExternal, label.external],
    [novelViewerClose, label.close]
  ];
  controls.forEach(([control, value]) => {
    control.setAttribute("aria-label", value);
    control.setAttribute("title", value);
  });
  novelViewerAddress.setAttribute("aria-label", label.address);
}

function renderNovelViewerStatus(status = novelViewerStatus): void {
  novelViewerStatus = status;
  novelViewerBack.disabled = !status.canGoBack || status.loading;
  novelViewerForward.disabled = !status.canGoForward || status.loading;
  novelViewerExternal.disabled = !status.committedUrl;
  novelViewerReload.disabled = !status.loading && !status.committedUrl && !status.lastReadableUrl;
  novelViewerReload.textContent = status.loading ? "×" : "↻";
  novelViewerPane.dataset.lifecycle = status.lifecycle;
  novelViewerPane.title = status.title ?? "Novel Viewer";
  if (!novelViewerAddressDirty) {
    // The address bar shows the authoritative committed location. A pending URL
    // is only a fallback before the first main-frame commit; drafts stay separate.
    novelViewerAddress.value = status.committedUrl ?? status.pendingUrl ?? status.lastReadableUrl ?? "";
  }
  novelViewerLocalState.classList.toggle("is-error", Boolean(status.error));
  novelViewerLocalState.textContent = status.error?.message
    ?? (status.loading && !status.committedUrl ? novelViewerText().loading : !status.committedUrl ? novelViewerText().empty : "");
  applyNovelViewerLabels();
  scheduleNovelViewerBounds();
  reportUnexpectedPlaceholderIfNeeded();
}

function scheduleNovelViewerBounds(): void {
  if (novelViewerBoundsFrame !== null) return;
  novelViewerBoundsFrame = window.requestAnimationFrame(() => {
    novelViewerBoundsFrame = null;
    const rect = novelViewerSlot.getBoundingClientRect();
    novelViewerLayoutRevision += 1;
    const visible = Boolean(
      novelViewerOpen &&
      rect.width > 0 &&
      rect.height > 0
    );
    void window.textEditor.updateNovelViewerBounds({
      layoutRevision: novelViewerLayoutRevision,
      x: Math.max(0, rect.x),
      y: Math.max(0, rect.y),
      width: Math.max(0, rect.width),
      height: Math.max(0, rect.height),
      visible
    }).catch((error: unknown) => console.error("Failed to update Novel Viewer bounds:", error));
  });
}

function isRenderedOccluder(element: Element | null): boolean {
  if (!(element instanceof HTMLElement) || element.hidden || element.getClientRects().length === 0) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function currentNovelViewerOcclusionReasons(): Set<NovelViewerOcclusionReason> {
  const reasons = new Set<NovelViewerOcclusionReason>();
  const overlays = Array.from(document.querySelectorAll(".dialog-overlay")).filter(isRenderedOccluder);
  if (overlays.some((overlay) => overlay.matches(".command-palette, .command-palette-overlay"))) {
    reasons.add("command-palette");
  }
  if (overlays.some((overlay) => !overlay.matches(".command-palette, .command-palette-overlay"))) {
    reasons.add("dialog");
  }
  if (Array.from(document.querySelectorAll(".context-menu")).some(isRenderedOccluder)) reasons.add("context-menu");
  if (Array.from(document.querySelectorAll(".cm-panel.cm-search")).some(isRenderedOccluder)) reasons.add("editor-search");
  if (!searchPanel.hidden && isRenderedOccluder(searchPanel)) reasons.add("global-search");
  if (workspaceImportInProgress || workspaceImportedNeedsRestart) reasons.add("workspace-import");
  return reasons;
}

function sameOcclusionReasons(
  left: ReadonlySet<NovelViewerOcclusionReason>,
  right: ReadonlySet<NovelViewerOcclusionReason>
): boolean {
  return left.size === right.size && [...left].every((reason) => right.has(reason));
}

function syncNovelViewerOcclusion(force = false): void {
  const reasons = currentNovelViewerOcclusionReasons();
  if (!force && sameOcclusionReasons(reasons, novelViewerOcclusionReasons)) return;
  novelViewerOcclusionReasons = reasons;
  novelViewerOcclusionRevision += 1;
  void window.textEditor.setNovelViewerOcclusion({
    revision: novelViewerOcclusionRevision,
    reasons: [...reasons]
  }).catch((error: unknown) =>
    console.error("Failed to update Novel Viewer occlusion:", error)
  );
  scheduleNovelViewerBounds();
}

function rendererElementDiagnostic(element: HTMLElement): NovelViewerRendererDiagnosticSnapshot["pane"] {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return {
    isConnected: element.isConnected,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    offsetWidth: element.offsetWidth,
    offsetHeight: element.offsetHeight,
    display: style.display,
    visibility: style.visibility
  };
}

function captureNovelViewerRendererDiagnostic(): NovelViewerRendererDiagnosticSnapshot {
  const placeholderText = (novelViewerLocalState.textContent ?? "").trim().slice(0, 500);
  const occlusionReasons = [...currentNovelViewerOcclusionReasons()];
  const nativeViewExpected = Boolean(
    novelViewerOpen &&
    novelViewerStatus.committedUrl &&
    !novelViewerStatus.error &&
    occlusionReasons.length === 0
  );
  return {
    pane: rendererElementDiagnostic(novelViewerPane),
    slot: rendererElementDiagnostic(novelViewerSlot),
    open: novelViewerOpen,
    narrowFallback: novelViewerSinglePane,
    splitMode: workspace.layout.splitMode,
    occlusionReasons,
    layoutRevision: novelViewerLayoutRevision,
    nativeViewExpected,
    placeholderVisible: Boolean(placeholderText && isRenderedOccluder(novelViewerLocalState)),
    placeholderText,
    title: (novelViewerStatus.title ?? "").slice(0, 300),
    url: (novelViewerStatus.committedUrl ?? novelViewerStatus.pendingUrl ?? novelViewerStatus.lastReadableUrl ?? "").slice(0, 4096),
    lifecycle: novelViewerStatus.lifecycle
  };
}

function submitNovelViewerRendererDiagnostic(reason: string): void {
  void window.textEditor.submitNovelViewerDiagnosticSnapshot(
    reason.slice(0, 120),
    captureNovelViewerRendererDiagnostic()
  ).catch((error: unknown) => console.error("Failed to submit Novel Viewer renderer diagnostics:", error));
}

function reportUnexpectedPlaceholderIfNeeded(): void {
  const snapshot = captureNovelViewerRendererDiagnostic();
  if (!snapshot.nativeViewExpected || !snapshot.placeholderVisible) {
    lastPlaceholderDiagnosticSignature = "";
    return;
  }
  const signature = `${snapshot.url}|${snapshot.title}|${snapshot.layoutRevision}|${snapshot.placeholderText}`;
  if (signature === lastPlaceholderDiagnosticSignature) return;
  lastPlaceholderDiagnosticSignature = signature;
  void window.textEditor.submitNovelViewerDiagnosticSnapshot("placeholder-visible-while-native-expected", snapshot)
    .catch((error: unknown) => console.error("Failed to submit Novel Viewer placeholder diagnostics:", error));
}

function applyNovelViewerLayout(): void {
  if (!novelViewerOpen) return;
  const availableWidth = editorSplit.getBoundingClientRect().width;
  novelViewerSinglePane = availableWidth < SPLIT_PANE_MIN_WIDTH * 2 + SPLIT_RESIZER_WIDTH;
  editorArea.classList.add("is-split", "has-novel-viewer");
  editorArea.classList.toggle("is-novel-viewer-single", novelViewerSinglePane);
  novelViewerPane.hidden = false;
  rightPaneElement.hidden = true;
  leftPaneElement.hidden = novelViewerSinglePane;
  splitResizer.hidden = novelViewerSinglePane;
  applySplitColumns(!novelViewerSinglePane);
  scheduleNovelViewerBounds();
}

async function openNovelViewer(): Promise<void> {
  if (novelViewerOpen) {
    novelViewerAddress.focus();
    novelViewerAddress.select();
    return;
  }
  novelViewerOpen = true;
  applyEditorLayout();
  syncNovelViewerOcclusion(true);
  renderNovelViewerStatus(await window.textEditor.openNovelViewer());
}

async function closeNovelViewer(): Promise<void> {
  if (!novelViewerOpen) return;
  novelViewerOpen = false;
  novelViewerAddressDirty = false;
  applyEditorLayout();
  activePane().view?.focus();
  renderNovelViewerStatus(await window.textEditor.closeNovelViewer());
}

async function toggleNovelViewer(): Promise<void> {
  if (novelViewerOpen) await closeNovelViewer();
  else await openNovelViewer();
}

function focusNovelViewerAddress(): void {
  if (!novelViewerOpen) {
    void openNovelViewer().then(() => {
      novelViewerAddress.focus();
      novelViewerAddress.select();
    });
    return;
  }
  novelViewerAddress.focus();
  novelViewerAddress.select();
}

function setupNovelViewerLayoutObservers(): void {
  const resizeObserver = new ResizeObserver(() => {
    if (novelViewerOpen) {
      applyNovelViewerLayout();
      applySidebarWidth();
    }
  });
  resizeObserver.observe(editorSplit);
  resizeObserver.observe(novelViewerSlot);
  const mutationObserver = new MutationObserver(() => syncNovelViewerOcclusion());
  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "class", "style", "aria-hidden"]
  });
}

function normalizedSplitRatio(): number {
  const savedRatio = Number.isFinite(workspace.layout.splitRatio) ? workspace.layout.splitRatio : 0.5;
  return Math.min(0.8, Math.max(0.2, savedRatio));
}

function clampSplitRatioForWidth(ratio: number, totalWidth: number): number {
  const usableWidth = Math.max(1, totalWidth - SPLIT_RESIZER_WIDTH);
  const effectiveMinimumWidth = Math.min(SPLIT_PANE_MIN_WIDTH, usableWidth / 2);
  const minimumRatio = effectiveMinimumWidth / usableWidth;
  return Math.min(1 - minimumRatio, Math.max(minimumRatio, ratio));
}

function applySplitColumns(split = novelViewerOpen ? !novelViewerSinglePane : workspace.layout.splitMode === "vertical"): void {
  if (!split) {
    editorSplit.style.gridTemplateColumns = "minmax(0, 1fr) 0 0";
    return;
  }
  const displayedRatio = clampSplitRatioForWidth(normalizedSplitRatio(), editorSplit.getBoundingClientRect().width);
  editorSplit.style.gridTemplateColumns = `minmax(0, ${displayedRatio}fr) ${SPLIT_RESIZER_WIDTH}px minmax(0, ${1 - displayedRatio}fr)`;
}

function applyEditorLayout(): void {
  const split = workspace.layout.splitMode === "vertical";
  editorArea.classList.toggle("is-split", split || novelViewerOpen);
  editorArea.classList.toggle("has-novel-viewer", novelViewerOpen);
  editorArea.classList.remove("is-novel-viewer-single");
  novelViewerPane.hidden = !novelViewerOpen;
  leftPaneElement.hidden = false;
  rightPaneElement.hidden = novelViewerOpen || !split;
  splitResizer.hidden = novelViewerOpen || !split;
  applySidebarWidth();
  if (novelViewerOpen) {
    applyNovelViewerLayout();
    updatePaneTitles();
    return;
  }
  if (!split && activePaneId === "right") {
    setActivePane("left");
  } else {
    setActivePane(workspace.layout.activePaneId === "right" && split ? "right" : "left");
  }
  updatePaneTitles();
}

function recentClosedTabs(): TabMeta[] {
  const opened = new Set(workspace.openedTabIds);
  const byId = new Map(tabIndex.tabs.map((tab) => [tab.id, tab]));
  const ordered = workspace.recentTabIds
    .map((id) => byId.get(id))
    .filter((tab): tab is TabMeta => tab !== undefined)
    .filter((tab) => !opened.has(tab.id));
  const orderedIds = new Set(ordered.map((tab) => tab.id));
  return [...ordered, ...tabIndex.tabs.filter((tab) => !opened.has(tab.id) && !orderedIds.has(tab.id))];
}

function renderSidebar(): void {
  const label = text();
  tabIndex = ensureTabsIndex();
  const hasOpenTabs = workspace.openedTabIds.some((id) => tabIndex.tabs.some((tab) => tab.id === id));
  const hasClosedTabs = recentClosedTabs().length > 0;

  sidebar.innerHTML = `
    <div class="sidebar-top">
      <div class="pane-title">${label.tabs}</div>
      <div class="sidebar-actions">
        <button type="button" class="icon-button" data-action="global-search" title="${escapeHtml(label.globalSearch)}" aria-label="${escapeHtml(label.globalSearch)}">⌕</button>
        <button type="button" class="icon-button" data-action="new-tab" title="${escapeHtml(label.newTab)}" aria-label="${escapeHtml(label.newTab)}">＋</button>
      </div>
    </div>
    ${
      hasOpenTabs
        ? ""
        : `<div class="sidebar-empty-state">
            <p>${escapeHtml(label.noOpenTab)}</p>
            <button type="button" class="secondary-button" data-action="new-tab">${escapeHtml(label.newTab)}</button>
            <button type="button" class="secondary-button" data-action="open-recent" ${hasClosedTabs ? "" : "disabled"}>${escapeHtml(label.recentClosed)}</button>
          </div>`
    }
    ${(tabIndex.groups ?? []).map((group) => renderGroupSection(group)).join("")}
    ${renderUngroupedSection()}
  `;
}

function renderTabRows(tabIds: string[], groupId: string | null): string {
  const opened = new Set(workspace.openedTabIds);
  return orderTabIdsByPinned(tabIds)
    .filter((id) => opened.has(id))
    .map((id) => tabMeta(id))
    .filter((tab): tab is TabMeta => Boolean(tab))
    .map(
      (tab) => `
        <div class="tab-row ${tab.id === activeTabId ? "is-active" : ""}" data-id="${tab.id}" data-group-id="${groupId ?? UNGROUPED_GROUP_ID}" draggable="${isRemoteInboxTabId(tab.id) ? "false" : "true"}">
          <button type="button" class="tab-title" data-action="activate-tab" data-id="${tab.id}">
            <span class="tab-name">${tab.pinned ? `<span class="pin-mark" aria-hidden="true">●</span>` : ""}${escapeHtml(tab.title)}</span>
            <small>${tab.wordCount} ${text().words}</small>
          </button>
        </div>
      `
    )
    .join("");
}

function renderGroupSection(group: TabGroup): string {
  const rows = group.collapsed ? "" : renderTabRows(group.tabIds, group.id);
  const selected = selectedGroupId === group.id ? "is-selected" : "";
  const opened = new Set(workspace.openedTabIds);
  const openCount = group.tabIds.filter((id) => opened.has(id)).length;

  return `
    <section class="tab-section group-section ${selected}" data-group-id="${group.id}">
      <button type="button" class="section-header group-header" data-action="toggle-group" data-id="${group.id}" data-group-id="${group.id}" draggable="true">
        <span class="group-toggle-icon">${group.collapsed ? "▶" : "▽"}</span>
        <span class="group-name">${escapeHtml(group.title)}</span>
        <span class="group-count">${openCount} / ${group.tabIds.length}</span>
      </button>
      <div class="tab-list" data-group-id="${group.id}">${rows || (!group.collapsed ? `<div class="empty-list">${text().empty}</div>` : "")}</div>
    </section>
  `;
}

function renderUngroupedSection(): string {
  const collapsed = isUngroupedCollapsed();
  const tabIds = tabIndex.ungroupedTabIds ?? [];
  const rows = collapsed ? "" : renderTabRows(tabIds, null);
  const opened = new Set(workspace.openedTabIds);
  const openCount = tabIds.filter((id) => opened.has(id)).length;
  return `
    <section class="tab-section group-section ${selectedGroupId === null ? "is-selected" : ""}" data-group-id="${UNGROUPED_GROUP_ID}">
      <button type="button" class="section-header group-header" data-action="toggle-group" data-id="${UNGROUPED_GROUP_ID}" data-group-id="${UNGROUPED_GROUP_ID}">
        <span class="group-toggle-icon">${collapsed ? "▶" : "▽"}</span>
        <span class="group-name">${escapeHtml(text().ungrouped)}</span>
        <span class="group-count">${openCount} / ${tabIds.length}</span>
      </button>
      <div class="tab-list" data-group-id="${UNGROUPED_GROUP_ID}">${rows || (!collapsed ? `<div class="empty-list">${text().empty}</div>` : "")}</div>
    </section>
  `;
}

function updateGlobalSearchLabels(): void {
  const label = text();
  globalSearchLabel.textContent = `${label.globalSearch}:`;
  globalSearchInput.placeholder = label.searchPlaceholder;
  searchPanel.querySelector<HTMLButtonElement>('[data-action="close-global-search"]')!.title = label.closeSearch;
  if (!globalSearchInput.value.trim()) {
    globalSearchSummary.textContent = label.searchReady;
  }
}

function openGlobalSearchPane(): void {
  searchPanel.hidden = false;
  applySidebarWidth();
  updateGlobalSearchLabels();
  globalSearchInput.focus();
  globalSearchInput.select();
  if (globalSearchInput.value.trim()) {
    void runGlobalSearch();
  }
}

function closeGlobalSearchPane(): void {
  searchPanel.hidden = true;
  applySidebarWidth();
}

function highlightedPreview(result: GlobalSearchResult): string {
  const start = Math.max(0, Math.min(result.preview.length, result.matchStart));
  const end = Math.max(start, Math.min(result.preview.length, result.matchEnd));
  return `${escapeHtml(result.preview.slice(0, start))}<mark>${escapeHtml(result.preview.slice(start, end))}</mark>${escapeHtml(result.preview.slice(end))}`;
}

function renderGlobalSearchResults(results: GlobalSearchResult[]): void {
  globalSearchCache = results;
  if (results.length === 0) {
    globalSearchResults.innerHTML = `<div class="empty-list">${text().noSearchResults}</div>`;
    globalSearchSummary.textContent = text().noSearchResults;
    return;
  }

  const groups = new Map<string, GlobalSearchResult[]>();
  for (const result of results) {
    const key = `${result.tabId}:${result.childTabId ?? MAIN_CHILD_TAB_ID}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }

  let index = 0;
  const html = [...groups.entries()]
    .map(([, items]) => {
      const first = items[0];
      const rows = items
        .map((item) => {
          const rowIndex = index;
          index += 1;
          const lineLabel = item.field === "title" ? text().titleMatch : `${item.lineNumber} ${text().lines}`;
          return `
            <button type="button" class="search-result-row" data-action="open-search-result" data-result-index="${rowIndex}">
              <span class="search-result-line">${escapeHtml(lineLabel)}</span>
              <span class="search-result-preview">${highlightedPreview(item)}</span>
            </button>
          `;
        })
        .join("");
      return `
        <section class="search-result-group">
          <div class="search-result-title">${escapeHtml(`${localGroupTitleForTab(first.tabId)} > ${first.title}${first.childTitle ? ` > ${first.childTitle}` : ""}`)}</div>
          ${rows}
        </section>
      `;
    })
    .join("");

  globalSearchResults.innerHTML = html;
  globalSearchSummary.textContent = text().searchResults(results.length);
}

async function runGlobalSearch(): Promise<void> {
  const query = globalSearchInput.value.trim();
  globalSearchSequence += 1;
  const sequence = globalSearchSequence;
  if (!query) {
    globalSearchCache = [];
    globalSearchResults.innerHTML = "";
    globalSearchSummary.textContent = text().searchReady;
    return;
  }

  try {
    if (!(await flushSave({ retry: false }))) {
      globalSearchSummary.textContent = text().autosaveFailed;
      return;
    }
    globalSearchSummary.textContent = text().searchRunning;
    const results = await window.textEditor.searchAllTabs(query);
    if (sequence !== globalSearchSequence) {
      return;
    }
    renderGlobalSearchResults(results);
  } catch (error) {
    globalSearchSummary.textContent = `${text().searchFailed}: ${errorMessage(error)}`;
    setSaveState(`${text().searchFailed}: ${errorMessage(error)}`, "error");
  }
}

function scheduleGlobalSearch(): void {
  if (globalSearchTimer !== null) {
    window.clearTimeout(globalSearchTimer);
  }
  globalSearchTimer = window.setTimeout(() => {
    globalSearchTimer = null;
    void runGlobalSearch();
  }, 250);
}

async function openSearchResult(index: number): Promise<void> {
  const result = globalSearchCache[index];
  if (!result) {
    return;
  }
  const group = groupForTab(result.tabId);
  if (group?.collapsed) {
    tabIndex = normalizeTabsIndex({
      ...tabIndex,
      groups: tabIndex.groups?.map((entry) => (entry.id === group.id ? { ...entry, collapsed: false, updatedAt: nowIso() } : entry))
    });
    await saveTabsIndex();
  }
  await activateTab(result.tabId, { childTabId: result.childTabId ?? MAIN_CHILD_TAB_ID });
  if (result.field === "title") {
    if (result.preview === result.title) {
      activeTitleInput.focus();
      activeTitleInput.setSelectionRange(result.matchStart, result.matchEnd);
    } else {
      activePane().view?.focus();
    }
    return;
  }

  const view = activePane().view;
  if (!view || result.lineNumber === null) {
    return;
  }
  const line = view.state.doc.line(result.lineNumber);
  const from = Math.min(line.to, line.from + result.matchStart);
  const to = Math.min(line.to, line.from + result.matchEnd);
  view.dispatch({
    selection: { anchor: from, head: to },
    effects: EditorView.scrollIntoView(from, { y: "center" })
  });
  view.focus();
}

function clearDragMarkers(): void {
  document.querySelectorAll(".tab-row.is-drag-over-before, .tab-row.is-drag-over-after, .group-section.is-drag-over-before, .group-section.is-drag-over-after, .group-section.is-drop-into").forEach((row) => {
    row.classList.remove("is-drag-over-before", "is-drag-over-after", "is-drop-into");
  });
}

function dropPlacement(row: HTMLElement, clientY: number): "before" | "after" {
  const rect = row.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

async function moveOpenedTab(dragId: string, targetId: string, placement: "before" | "after"): Promise<void> {
  if (dragId === targetId) {
    return;
  }

  const targetGroupId = tabGroupId(targetId);
  tabIndex = insertTabIntoIndexGroup(tabIndex, dragId, targetGroupId, targetId, placement);
  workspace.openedTabIds = flattenedOpenedTabIds();
  selectedGroupId = targetGroupId;
  await saveTabsIndex();
  await saveWorkspace();
  renderSidebar();
  setSaveState(text().tabOrderSaved);
}

async function moveTabToGroup(tabId: string, groupId: string | null): Promise<void> {
  tabIndex = insertTabIntoIndexGroup(tabIndex, tabId, groupId);
  workspace.openedTabIds = flattenedOpenedTabIds();
  selectedGroupId = groupId;
  await saveTabsIndex();
  await saveWorkspace();
  renderSidebar();
  setSaveState(text().tabOrderSaved);
}

async function moveGroup(dragId: string, targetId: string, placement: "before" | "after"): Promise<void> {
  if (dragId === targetId) {
    return;
  }
  const groups = [...(tabIndex.groups ?? [])];
  const drag = groups.find((group) => group.id === dragId);
  if (!drag) {
    return;
  }
  const withoutDrag = groups.filter((group) => group.id !== dragId);
  const targetIndex = withoutDrag.findIndex((group) => group.id === targetId);
  if (targetIndex === -1) {
    return;
  }
  withoutDrag.splice(placement === "before" ? targetIndex : targetIndex + 1, 0, {
    ...drag,
    collapsed: true,
    updatedAt: nowIso()
  });
  tabIndex = normalizeTabsIndex({
    ...tabIndex,
    groups: withoutDrag
  });
  workspace.openedTabIds = flattenedOpenedTabIds();
  selectedGroupId = dragId;
  await saveTabsIndex();
  await saveWorkspace();
  renderSidebar();
  setSaveState(text().tabOrderSaved);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[char];
  });
}

function requestTextDialog(title: string, initialValue: string): Promise<string | null> {
  return new Promise((resolve) => {
    const label = text();
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML = `
      <form class="app-dialog" role="dialog" aria-modal="true">
        <div class="dialog-title">${escapeHtml(title)}</div>
        <input class="dialog-input" name="value" value="${escapeHtml(initialValue)}" autocomplete="off" />
        <div class="dialog-actions">
          <button type="button" data-dialog-action="cancel">${label.cancel}</button>
          <button type="submit" data-dialog-action="ok">${label.ok}</button>
        </div>
      </form>
    `;

    const form = overlay.querySelector<HTMLFormElement>("form")!;
    const input = overlay.querySelector<HTMLInputElement>("input")!;

    const close = (value: string | null): void => {
      overlay.remove();
      resolve(value);
    };

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        close(null);
      }
    });
    overlay.querySelector<HTMLButtonElement>('[data-dialog-action="cancel"]')!.addEventListener("click", () => close(null));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      close(input.value);
    });

    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

function confirmDialog(message: string, confirmLabel = text().ok): Promise<boolean> {
  return new Promise((resolve) => {
    const label = text();
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML = `
      <form class="app-dialog" role="dialog" aria-modal="true">
        <div class="dialog-title">${escapeHtml(message)}</div>
        <div class="dialog-actions">
          <button type="button" data-dialog-action="cancel">${label.cancel}</button>
          <button type="submit" data-dialog-action="ok">${escapeHtml(confirmLabel)}</button>
        </div>
      </form>
    `;

    const close = (value: boolean): void => {
      overlay.remove();
      resolve(value);
    };

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        close(false);
      }
    });
    overlay.querySelector<HTMLButtonElement>('[data-dialog-action="cancel"]')!.addEventListener("click", () => close(false));
    overlay.querySelector<HTMLFormElement>("form")!.addEventListener("submit", (event) => {
      event.preventDefault();
      close(true);
    });

    document.body.appendChild(overlay);
    overlay.querySelector<HTMLButtonElement>('[data-dialog-action="cancel"]')!.focus();
  });
}

function recoveryDialog(): Promise<"restore" | "skip" | "cancel"> {
  return new Promise((resolve) => {
    const label = text();
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML = `
      <form class="app-dialog" role="dialog" aria-modal="true">
        <div class="dialog-title">${escapeHtml(label.recoveryTitle)}</div>
        <p class="dialog-note">${escapeHtml(label.recoveryMessage)}</p>
        <div class="dialog-actions">
          <button type="button" data-recovery-action="cancel">${label.cancel}</button>
          <button type="button" data-recovery-action="skip">${escapeHtml(label.skipRecovery)}</button>
          <button type="submit" data-recovery-action="restore">${escapeHtml(label.recoverPreviousSession)}</button>
        </div>
      </form>
    `;

    overlay.querySelector<HTMLButtonElement>('[data-recovery-action="cancel"]')!.addEventListener("click", () => {
      overlay.remove();
      resolve("cancel");
    });
    overlay.querySelector<HTMLButtonElement>('[data-recovery-action="skip"]')!.addEventListener("click", () => {
      overlay.remove();
      resolve("skip");
    });
    overlay.querySelector<HTMLFormElement>("form")!.addEventListener("submit", (event) => {
      event.preventDefault();
      overlay.remove();
      resolve("restore");
    });

    document.body.appendChild(overlay);
    overlay.querySelector<HTMLButtonElement>('[data-recovery-action="restore"]')!.focus();
  });
}

function closeContextMenu(): void {
  document.querySelector(".context-menu")?.remove();
}

function positionContextMenu(menu: HTMLElement, x: number, y: number): void {
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function showContextMenu(tabId: string, x: number, y: number): void {
  closeContextMenu();
  const label = text();
  const inGroup = Boolean(groupForTab(tabId));
  const pinned = isTabPinned(tabId);
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.innerHTML = isRemoteInboxTabId(tabId) ? `
    <button type="button" data-action="open-tab-main" data-id="${tabId}">${label.openInMain}</button>
    <button type="button" data-action="open-tab-sub" data-id="${tabId}">${label.openInSub}</button>
    <button type="button" data-action="close-tab" data-id="${tabId}">${label.close}</button>
    <button type="button" data-action="clear-remote-inbox" data-id="${tabId}">${workspace.locale === "jp" ? "Remote Inboxをクリア" : "Clear Remote Inbox"}</button>
  ` : `
    <button type="button" data-action="open-tab-main" data-id="${tabId}">${label.openInMain}</button>
    <button type="button" data-action="open-tab-sub" data-id="${tabId}">${label.openInSub}</button>
    <button type="button" data-action="toggle-pin-tab" data-id="${tabId}">${pinned ? label.unpinTab : label.pinTab}</button>
    <button type="button" data-action="rename-tab" data-id="${tabId}">${label.rename}</button>
    <button type="button" data-action="duplicate-tab" data-id="${tabId}">${label.duplicate}</button>
    <button type="button" data-action="close-tab" data-id="${tabId}">${label.close}</button>
    <button type="button" class="danger-menu-item" data-action="delete-tab" data-id="${tabId}">${label.delete}</button>
    ${inGroup ? `<button type="button" data-action="ungroup-tab" data-id="${tabId}">${label.removeFromGroup}</button>` : ""}
  `;
  positionContextMenu(menu, x, y);
}

function showGroupContextMenu(groupId: string, x: number, y: number): void {
  const group = groupId === UNGROUPED_GROUP_ID ? null : tabIndex.groups?.find((entry) => entry.id === groupId);
  if (groupId !== UNGROUPED_GROUP_ID && !group) {
    return;
  }
  closeContextMenu();
  const label = text();
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.innerHTML = `
    <button type="button" data-action="new-tab-in-group" data-id="${groupId}">${label.newTabInGroup}</button>
    ${
      groupId === UNGROUPED_GROUP_ID
        ? ""
        : `
          <button type="button" data-action="rename-group" data-id="${groupId}">${label.rename}</button>
          <button type="button" class="danger-menu-item" data-action="delete-group" data-id="${groupId}">${label.deleteGroup}</button>
        `
    }
  `;
  positionContextMenu(menu, x, y);
}

function showSidebarBlankContextMenu(x: number, y: number): void {
  closeContextMenu();
  const label = text();
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.innerHTML = `
    <button type="button" data-action="new-tab-in-group" data-id="${UNGROUPED_GROUP_ID}">${label.newTab}</button>
    <button type="button" data-action="new-group">${label.newGroup}</button>
  `;
  positionContextMenu(menu, x, y);
}

function showChildContextMenu(tabId: string, childTabId: string, x: number, y: number): void {
  if (isRemoteInboxTabId(tabId)) return;
  closeContextMenu();
  const label = text();
  const isMain = childTabId === MAIN_CHILD_TAB_ID;
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.innerHTML = `
    <button type="button" data-action="open-child-main" data-id="${tabId}" data-child-id="${childTabId}">${label.openInMain}</button>
    <button type="button" data-action="open-child-sub" data-id="${tabId}" data-child-id="${childTabId}">${label.openInSub}</button>
    <button type="button" data-action="rename-child-tab" data-id="${tabId}" data-child-id="${childTabId}">${label.rename}</button>
    ${isMain ? "" : `<button type="button" class="danger-menu-item" data-action="delete-child-tab" data-id="${tabId}" data-child-id="${childTabId}">${label.delete}</button>`}
  `;
  positionContextMenu(menu, x, y);
}

function modalBase(title: string, body: string): HTMLDivElement {
  const label = text();
  const overlay = document.createElement("div");
  overlay.className = "dialog-overlay";
  overlay.innerHTML = `
    <div class="app-dialog large-dialog" role="dialog" aria-modal="true">
      <div class="dialog-title">${escapeHtml(title)}</div>
      ${body}
      <div class="dialog-actions">
        <button type="button" data-dialog-action="cancel">${label.close}</button>
      </div>
    </div>
  `;
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      overlay.remove();
    }
  });
  overlay.querySelector<HTMLButtonElement>('[data-dialog-action="cancel"]')!.addEventListener("click", () => overlay.remove());
  document.body.appendChild(overlay);
  return overlay;
}

function lockImportedWorkspace(): void {
  workspaceImportInProgress = false;
  workspaceImportedNeedsRestart = true;
  document.body.classList.add("workspace-import-locked");
  document.body.classList.remove("workspace-importing");
  activeTitleInput.disabled = true;
  (Object.values(panes) as EditorPaneState[]).forEach((pane) => {
    pane.titleElement.disabled = true;
    pane.view?.dispatch({ effects: pane.readOnlyCompartment.reconfigure(editorReadOnlyExtensions(pane)) });
  });
}

function setWorkspaceImportInProgress(value: boolean): void {
  workspaceImportInProgress = value;
  document.body.classList.toggle("workspace-importing", value);
  (Object.values(panes) as EditorPaneState[]).forEach((pane) => {
    pane.view?.dispatch({ effects: pane.readOnlyCompartment.reconfigure(editorReadOnlyExtensions(pane)) });
  });
  updateStatus();
}

function showImportProgressDialog(): HTMLElement {
  document.querySelector(".dialog-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "dialog-overlay import-progress-overlay";
  overlay.innerHTML = `
    <div class="app-dialog import-progress-dialog" role="alertdialog" aria-modal="true" aria-labelledby="import-progress-title">
      <div class="dialog-title" id="import-progress-title">${workspace.locale === "jp" ? "Workspaceをインポート中…" : "Importing workspace…"}</div>
      <p class="dialog-note">${workspace.locale === "jp" ? "完了するまで編集をロックしています。" : "Editing is locked until the import finishes."}</p>
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function showImportRestartDialog(backupPathValue?: string): void {
  document.querySelector(".dialog-overlay")?.remove();
  const label = text();
  const overlay = document.createElement("div");
  overlay.className = "dialog-overlay";
  overlay.innerHTML = `
    <div class="app-dialog large-dialog import-restart-dialog" role="dialog" aria-modal="true" aria-labelledby="import-restart-title">
      <div class="dialog-title" id="import-restart-title">${escapeHtml(label.workspaceImported)}</div>
      <p class="dialog-note">${escapeHtml(label.restartRequired)}</p>
      ${backupPathValue ? `<p class="dialog-note">${escapeHtml(label.currentWorkspaceBackup)}: ${escapeHtml(backupPathValue)}</p>` : ""}
      <p class="dialog-note import-restart-error" aria-live="polite"></p>
      <div class="dialog-actions">
        <button type="button" data-import-action="restart">${escapeHtml(label.restartNow)}</button>
      </div>
    </div>
  `;
  const restartButton = overlay.querySelector<HTMLButtonElement>('[data-import-action="restart"]')!;
  restartButton.addEventListener("click", () => {
    restartButton.disabled = true;
    void window.textEditor.restartApp().then(
      (started) => {
        if (started) {
          return;
        }
        restartButton.disabled = false;
        const errorElement = overlay.querySelector<HTMLElement>(".import-restart-error");
        if (errorElement) {
          errorElement.textContent = label.restartFailed;
        }
        setSaveState(label.restartFailed, "error");
      },
      (error: unknown) => {
        restartButton.disabled = false;
        const message = `${label.restartFailed}: ${errorMessage(error)}`;
        const errorElement = overlay.querySelector<HTMLElement>(".import-restart-error");
        if (errorElement) {
          errorElement.textContent = message;
        }
        setSaveState(message, "error");
      }
    );
  });
  document.body.appendChild(overlay);
  restartButton.focus();
}

function openSettingsDialog(): void {
  closeContextMenu();
  document.querySelector(".dialog-overlay")?.remove();
  const label = text();
  const selected = workspace.newTabTemplate ?? "simple";
  const templateOptions: Array<{ id: NewTabTemplateId; label: string; note: string }> = [
    { id: "simple", label: label.templateSimple, note: templateTitles("simple").join(" / ") },
    { id: "novel", label: label.templateNovel, note: templateTitles("novel").join(" / ") },
    { id: "reference", label: label.templateReference, note: templateTitles("reference").join(" / ") },
    { id: "custom", label: label.templateCustom, note: normalizeTemplateTitles(workspace.templates?.custom).join(" / ") }
  ];
  const overlay = document.createElement("div");
  overlay.className = "dialog-overlay";
  overlay.innerHTML = `
    <form class="app-dialog large-dialog settings-dialog">
      <div class="dialog-title">${escapeHtml(label.settings)}</div>
      <div class="settings-section-title">${escapeHtml(label.newTabTemplate)}</div>
      <div class="template-options">
        ${templateOptions
          .map(
            (option) => `
              <label class="template-option">
                <input type="radio" name="new-tab-template" value="${option.id}" ${option.id === selected ? "checked" : ""} />
                <span>
                  <strong>${escapeHtml(option.label)}</strong>
                  <small>${escapeHtml(option.note)}</small>
                </span>
              </label>
            `
          )
          .join("")}
      </div>
      <button type="button" class="secondary-button" data-settings-action="edit-custom" ${selected === "custom" ? "" : "hidden"}>${escapeHtml(label.editCustomTemplate)}</button>
      <label class="settings-check">
        <input type="checkbox" name="auto-continue-lists" ${workspace.autoContinueLists ? "checked" : ""} />
        <span>${escapeHtml(label.autoContinueLists)}</span>
      </label>
      <div class="settings-section-title">${workspace.locale === "jp" ? "遠隔書き込み" : "Remote writing"}</div>
      <label class="settings-check"><input type="checkbox" name="remote-enabled" ${workspace.remoteInbox.enabled ? "checked" : ""} /><span>${workspace.locale === "jp" ? "遠隔書き込みを有効にする" : "Enable remote writing"}</span></label>
      <label class="settings-field">${workspace.locale === "jp" ? "ローカル待受ポート" : "Local listening port"}<input name="remote-port" type="number" min="1024" max="65535" value="${workspace.remoteInbox.port}" /></label>
      <label class="settings-field">${workspace.locale === "jp" ? "受信先タブ名" : "Target tab name"}<input name="remote-tab" value="${escapeHtml(workspace.remoteInbox.targetTabName)}" /></label>
      <label class="settings-field">${workspace.locale === "jp" ? "受信先候補（1行に1件）" : "Target choices (one per line)"}<textarea name="remote-targets" rows="4">${escapeHtml(workspace.remoteInbox.targetTabNames.join("\n"))}</textarea></label>
      <fieldset class="settings-field"><legend>${workspace.locale === "jp" ? "リモート閲覧を許可する通常タブ" : "Normal tabs allowed for remote viewing"}</legend>${tabIndex.tabs.filter((tab) => !workspace.remoteInbox.targetTabNames.includes(tab.title)).map((tab) => `<label class="settings-check"><input type="checkbox" name="remote-readable-tab" value="${escapeHtml(tab.id)}" ${workspace.remoteInbox.remoteReadableTabIds.includes(tab.id) ? "checked" : ""} /><span>${escapeHtml(tab.title)}</span></label>`).join("") || `<span class="dialog-note">${workspace.locale === "jp" ? "通常タブがありません" : "No normal tabs"}</span>`}</fieldset>
      <label class="settings-check"><input type="checkbox" name="remote-timestamp" ${workspace.remoteInbox.includeTimestamp ? "checked" : ""} /><span>${workspace.locale === "jp" ? "受信日時を付ける" : "Include received timestamp"}</span></label>
      <label class="settings-check"><input type="checkbox" name="remote-notify" ${workspace.remoteInbox.notifyOnReceive ? "checked" : ""} /><span>${workspace.locale === "jp" ? "受信時にデスクトップ通知する" : "Show desktop notification"}</span></label>
      <label class="settings-field">Cloudflare Access Team Domain<input name="remote-domain" type="url" placeholder="https://example.cloudflareaccess.com" value="${escapeHtml(workspace.remoteInbox.accessTeamDomain)}" /></label>
      <label class="settings-field">Cloudflare Access Application AUD<input name="remote-audience" value="${escapeHtml(workspace.remoteInbox.accessAudience)}" /></label>
      <label class="settings-field">${workspace.locale === "jp" ? "許可メールアドレス" : "Allowed email address"}<input name="remote-email" type="email" value="${escapeHtml(workspace.remoteInbox.allowedEmail)}" /></label>
      <p class="dialog-note" id="remote-status"></p>
      <div class="dialog-actions">
        <button type="button" data-dialog-action="cancel">${label.cancel}</button>
        <button type="submit" data-dialog-action="ok">${label.ok}</button>
      </div>
    </form>
  `;

  const customButton = overlay.querySelector<HTMLButtonElement>('[data-settings-action="edit-custom"]')!;
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      overlay.remove();
    }
  });
  overlay.querySelectorAll<HTMLInputElement>('input[name="new-tab-template"]').forEach((input) => {
    input.addEventListener("change", () => {
      customButton.hidden = input.value !== "custom";
    });
  });
  customButton.addEventListener("click", () => {
    overlay.remove();
    openCustomTemplateEditor();
  });
  void window.textEditor.remoteInboxStatus().then((status) => {
    const statusElement = overlay.querySelector("#remote-status");
    if (statusElement) statusElement.textContent = status.state === "running" ? `${workspace.locale === "jp" ? "起動中" : "Running"}: ${status.url}` : status.state === "error" ? `${workspace.locale === "jp" ? "エラー" : "Error"}: ${status.message}` : (workspace.locale === "jp" ? "停止中" : "Stopped");
  });
  overlay.querySelector<HTMLButtonElement>('[data-dialog-action="cancel"]')!.addEventListener("click", () => overlay.remove());
  overlay.querySelector<HTMLFormElement>("form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const value = new FormData(form).get("new-tab-template");
    const newTabTemplate = value === "novel" || value === "reference" || value === "custom" ? value : "simple";
    const autoContinueLists = Boolean(form.querySelector<HTMLInputElement>('input[name="auto-continue-lists"]')?.checked);
    const port = Number(form.querySelector<HTMLInputElement>('input[name="remote-port"]')?.value);
    const targetTabName = form.querySelector<HTMLInputElement>('input[name="remote-tab"]')?.value.trim() ?? "";
    const configuredTargetNames = (form.querySelector<HTMLTextAreaElement>('textarea[name="remote-targets"]')?.value ?? "").split(/\r?\n/).map((name) => name.trim()).filter((name, index, names) => Boolean(name) && name.length <= 120 && !/[\u0000-\u001F\u007F]/.test(name) && names.indexOf(name) === index);
    const targetTabNames = [targetTabName, ...configuredTargetNames.filter((name) => name !== targetTabName)].filter(Boolean).slice(0, 30);
    const accessTeamDomain = form.querySelector<HTMLInputElement>('input[name="remote-domain"]')?.value.trim() ?? "";
    const accessAudience = form.querySelector<HTMLInputElement>('input[name="remote-audience"]')?.value.trim() ?? "";
    const allowedEmail = form.querySelector<HTMLInputElement>('input[name="remote-email"]')?.value.trim() ?? "";
    const remoteEnabled = Boolean(form.querySelector<HTMLInputElement>('input[name="remote-enabled"]')?.checked);
    const includeTimestamp = Boolean(form.querySelector<HTMLInputElement>('input[name="remote-timestamp"]')?.checked);
    const notifyOnReceive = Boolean(form.querySelector<HTMLInputElement>('input[name="remote-notify"]')?.checked);
    const remoteReadableTabIds = [...form.querySelectorAll<HTMLInputElement>('input[name="remote-readable-tab"]:checked')].map((input) => input.value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || !targetTabName || targetTabName.length > 120 || /[\u0000-\u001F\u007F]/.test(targetTabName) || !targetTabNames.length) { setSaveState(workspace.locale === "jp" ? "遠隔書き込みの設定が不正です" : "Remote writing settings are invalid", "error"); return; }
    const formControls = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>("input, textarea, select, button")];
    const setFormDisabled = (disabled: boolean): void => formControls.forEach((control) => { control.disabled = disabled; });
    setFormDisabled(true);
    void (async () => {
      if (!(await flushSave({ retry: false }))) {
        setFormDisabled(false);
        return;
      }
      const duplicateRemoteTarget = targetTabNames.find((name) => tabIndex.tabs.filter((tab) => tab.title === name).length > 1);
      if (duplicateRemoteTarget) {
        setSaveState(
          workspace.locale === "jp"
            ? `受信先「${duplicateRemoteTarget}」と同名のタブが複数あります`
            : `Multiple tabs use the Remote Inbox target name "${duplicateRemoteTarget}"`,
          "error"
        );
        setFormDisabled(false);
        return;
      }
      workspace.newTabTemplate = newTabTemplate;
      workspace.autoContinueLists = autoContinueLists;
      workspace.remoteInbox = { enabled: remoteEnabled, port, targetTabName, targetTabNames, remoteReadableTabIds, includeTimestamp, notifyOnReceive, accessTeamDomain, accessAudience, allowedEmail };
      workspace.templates = {
        ...workspace.templates,
        custom: [MAIN_CHILD_TAB_TITLE, ...normalizeTemplateTitles(workspace.templates?.custom).slice(1)]
      };
      try {
        await saveWorkspace();
        (Object.values(panes) as EditorPaneState[]).forEach((pane) => pane.view?.dispatch({ effects: pane.readOnlyCompartment.reconfigure(editorReadOnlyExtensions(pane)) }));
        updateStatus();
        setSaveState(label.templateSaved);
        overlay.remove();
      } catch (error) {
        setFormDisabled(false);
        setSaveState(`${text().actionFailed}: ${errorMessage(error)}`, "error");
      }
    })();
  });
  document.body.appendChild(overlay);
}

function openCustomTemplateEditor(): void {
  const label = text();
  let items = normalizeTemplateTitles(workspace.templates?.custom);
  let dragIndex: number | null = null;
  const overlay = document.createElement("div");
  overlay.className = "dialog-overlay";

  const render = (): void => {
    overlay.innerHTML = `
      <form class="app-dialog large-dialog settings-dialog">
        <div class="dialog-title">${escapeHtml(label.customTemplateTitle)}</div>
        <div class="template-editor-list">
          ${items
            .map(
              (item, index) => `
                <div class="template-editor-row" data-index="${index}" draggable="${index > 0 ? "true" : "false"}">
                  <span class="template-drag-handle">${index > 0 ? "::" : ""}</span>
                  <input class="dialog-input template-name-input" data-index="${index}" value="${escapeHtml(index === 0 ? localizedMainChildTitle() : item)}" ${index === 0 ? "disabled" : ""} />
                  ${index === 0 ? "" : `<button type="button" class="mini-button danger-button" data-template-action="delete" data-index="${index}">x</button>`}
                </div>
              `
            )
            .join("")}
        </div>
        <button type="button" class="secondary-button" data-template-action="add">${escapeHtml(label.addTemplateItem)}</button>
        <div class="dialog-actions">
          <button type="button" data-dialog-action="cancel">${label.cancel}</button>
          <button type="submit" data-dialog-action="ok">${label.ok}</button>
        </div>
      </form>
    `;

    overlay.querySelector<HTMLButtonElement>('[data-dialog-action="cancel"]')!.addEventListener("click", () => overlay.remove());
    overlay.querySelector<HTMLButtonElement>('[data-template-action="add"]')!.addEventListener("click", async () => {
      const title = (await requestTextDialog(label.childTabTitle, label.memoChildTab))?.trim();
      if (!title || title === MAIN_CHILD_TAB_TITLE || title === localizedMainChildTitle()) {
        return;
      }
      items = normalizeTemplateTitles([...items, title]);
      render();
    });
    overlay.querySelectorAll<HTMLInputElement>(".template-name-input:not(:disabled)").forEach((input) => {
      input.addEventListener("input", () => {
        const index = Number(input.dataset.index);
        if (index > 0) {
          items[index] = input.value;
        }
      });
    });
    overlay.querySelectorAll<HTMLButtonElement>('[data-template-action="delete"]').forEach((button) => {
      button.addEventListener("click", () => {
        const index = Number(button.dataset.index);
        if (index > 0) {
          items.splice(index, 1);
          items = normalizeTemplateTitles(items);
          render();
        }
      });
    });
    overlay.querySelectorAll<HTMLElement>(".template-editor-row[draggable='true']").forEach((row) => {
      row.addEventListener("dragstart", (event) => {
        event.stopPropagation();
        dragIndex = Number(row.dataset.index);
        event.dataTransfer?.setData("text/plain", String(dragIndex));
      });
      row.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const targetIndex = Number(row.dataset.index);
        if (dragIndex === null || targetIndex <= 0 || dragIndex === targetIndex) {
          return;
        }
        const [moved] = items.splice(dragIndex, 1);
        items.splice(targetIndex, 0, moved);
        dragIndex = null;
        render();
      });
    });
    overlay.querySelector<HTMLFormElement>("form")!.addEventListener("submit", (event) => {
      event.preventDefault();
      items = normalizeTemplateTitles(items);
      workspace.newTabTemplate = "custom";
      workspace.templates = {
        ...workspace.templates,
        custom: [MAIN_CHILD_TAB_TITLE, ...items.slice(1)]
      };
      void saveWorkspace().then(() => setSaveState(label.templateSaved));
      overlay.remove();
    });
  };

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      overlay.remove();
    }
  });
  render();
  document.body.appendChild(overlay);
}

function showRecentDialog(): void {
  const tabs = recentClosedTabs();
  const label = text();
  const rows = tabs.length
    ? tabs
        .map(
          (tab) => `
            <button type="button" class="list-row" data-action="reopen-tab" data-id="${tab.id}">
              <span>${escapeHtml(tab.title)}</span>
              <small>${tab.wordCount} ${label.words}</small>
            </button>
          `
        )
        .join("")
    : `<div class="empty-list">${label.empty}</div>`;

  modalBase(label.recentClosed, `<div class="modal-list">${rows}</div>`);
}

async function showBackupsDialog(): Promise<void> {
  const label = text();

  let backups: BackupMeta[] = [];
  try {
    backups = await window.textEditor.listBackupHistory();
  } catch (error) {
    setSaveState(`${label.backupListFailed}: ${errorMessage(error)}`, "error");
    return;
  }

  const rows = backups.length
    ? backups
        .map(
          (backup) => `
            <div class="list-row backup-history-row">
              <span>${escapeHtml(formatBackupLabel(backup))} / ${escapeHtml(backup.title)}</span>
              <small>${backup.wordCount} ${label.words} / ${formatBytes(backup.size ?? 0)}${backup.tabId ? ` / ${escapeHtml(backup.tabId)}` : ""}</small>
              <small>${backup.readable === false ? escapeHtml(backup.error || label.backupUnreadable) : `${escapeHtml(label.backupPreview)}: ${escapeHtml(backup.preview || label.empty)}`}</small>
              ${
                backup.readable === false || !backup.tabId
                  ? ""
                  : `<button type="button" class="secondary-button" data-action="restore-backup-as-tab" data-id="${backup.tabId}" data-file="${backup.fileName}">${escapeHtml(label.restoreAsNewTab)}</button>`
              }
            </div>
          `
        )
        .join("")
    : `<div class="empty-list">${label.noBackups}</div>`;

  modalBase(label.backupHistory, `<div class="modal-list">${rows}</div>`);
}

function formatBackupLabel(backup: BackupMeta): string {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(backup.fileName);
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}` : backup.fileName;
}

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function restoreBackup(tabId: string, fileName: string): Promise<void> {
  const current = activeDocument();
  if (!current || current.id !== tabId) {
    await activateTab(tabId);
  }

  if (!(await confirmDialog(text().restoreConfirm(current?.title ?? tabId), text().restore))) {
    return;
  }

  const backup = await window.textEditor.loadBackup(tabId, fileName);
  const restored: TabDocument = ensureTab({
    ...backup,
    id: tabId,
    title: backup.title.trim() || "Untitled",
    updatedAt: nowIso()
  });
  contentCache.set(tabId, restored);
  activePane().activeTabId = tabId;
  activePane().activeChildTabId = restored.activeChildTabId ?? MAIN_CHILD_TAB_ID;
  syncActiveTabId();
  setPaneEditorContent(activePane(), childTabForPane(restored, activePane()).content);
  const saved = ensureTab(await window.textEditor.saveTab(restored));
  contentCache.set(tabId, saved);
  updateMetaFromDocument(saved);
  syncPaneViewsForTab(tabId);
  renderSidebar();
  updateStatus();
  setSaveState(text().backupRestored);
}

async function restoreBackupAsNewTab(tabId: string, fileName: string): Promise<void> {
  const backup = await window.textEditor.loadBackup(tabId, fileName);
  const restoredTitle = uniqueRestoredTitle(backup.title.trim() || text().untitled);
  if (!(await confirmDialog(text().restoreConfirm(restoredTitle), text().restoreAsNewTab))) {
    return;
  }

  const newId = nextTabId();
  const updatedAt = nowIso();
  const sourceGroupId = tabGroupId(tabId);
  const restored = ensureTab({
    ...backup,
    id: newId,
    title: restoredTitle,
    activeChildTabId: backup.activeChildTabId ?? MAIN_CHILD_TAB_ID,
    childTabs: getChildTabs(backup).map((child) => ({
      ...child,
      updatedAt
    })),
    content: getMainChildTab(backup).content,
    updatedAt
  });

  contentCache.set(newId, restored);
  updateMetaFromDocument(restored);
  tabIndex = normalizeTabsIndex({
    ...tabIndex,
    tabs: tabIndex.tabs.map((tab) => (tab.id === newId ? { ...tab, pinned: false } : tab))
  });
  expandTargetGroup(sourceGroupId);
  tabIndex = insertTabIntoIndexGroup(tabIndex, newId, sourceGroupId, tabMeta(tabId) ? tabId : undefined, tabMeta(tabId) ? "after" : "end");
  selectedGroupId = sourceGroupId;
  workspace.openedTabIds = Array.from(new Set([...workspace.openedTabIds, newId]));
  workspace.openedTabIds = flattenedOpenedTabIds();
  workspace.recentTabIds = [newId, ...workspace.recentTabIds.filter((entry) => entry !== newId)].slice(0, 20);
  cachePaneEditorState(activePane());
  activePane().activeTabId = newId;
  activePane().activeChildTabId = restored.activeChildTabId ?? MAIN_CHILD_TAB_ID;
  syncActiveTabId();
  setPaneEditorContent(activePane(), childTabForPane(restored, activePane()).content);
  setPaneEditorEnabled(activePane(), true);

  const saved = ensureTab(await window.textEditor.saveTab(restored));
  contentCache.set(newId, saved);
  updateMetaFromDocument(saved);
  tabIndex = normalizeTabsIndex({
    ...tabIndex,
    tabs: tabIndex.tabs.map((tab) => (tab.id === newId ? { ...tab, pinned: false } : tab))
  });
  tabIndex = insertTabIntoIndexGroup(tabIndex, newId, sourceGroupId, tabMeta(tabId) ? tabId : undefined, tabMeta(tabId) ? "after" : "end");
  workspace.openedTabIds = flattenedOpenedTabIds();
  await saveTabsIndex();
  await saveWorkspace();
  document.querySelector(".dialog-overlay")?.remove();
  renderSidebar();
  updateStatus();
  setSaveState(text().backupRestored);
}

async function applyTabTitle(id: string, title: string): Promise<void> {
  const nextTitle = title.trim();
  if (!nextTitle) {
    updateStatus();
    return;
  }
  const remoteTargetNames = new Set([workspace.remoteInbox.targetTabName, ...workspace.remoteInbox.targetTabNames]);
  if (remoteTargetNames.has(nextTitle) && tabIndex.tabs.some((entry) => entry.id !== id && entry.title === nextTitle)) {
    setSaveState(
      workspace.locale === "jp"
        ? "Remote Inbox の受信先と同名のタブが既にあります"
        : "A tab with this Remote Inbox target name already exists",
      "error"
    );
    updateStatus();
    return;
  }

  // Keep the title mutation synchronous when the active document is already cached.
  // Otherwise a following editor transaction can start a save with the old title
  // while this function is suspended at an already-resolved Promise.
  const tab = contentCache.get(id) ?? await loadTabToCache(id);
  tab.title = nextTitle;
  tab.updatedAt = nowIso();
  contentCache.set(id, tab);
  updateMetaFromDocument(tab);
  scheduleSave(id);
  if (!(await flushSave())) {
    renderSidebar();
    updatePaneTitles();
    updateStatus();
    return;
  }
  renderSidebar();
  updatePaneTitles();
  updateStatus();
  setSaveState(text().renamed);
}

async function commitActiveTitle(): Promise<void> {
  const tab = activeDocument();
  if (!tab) {
    return;
  }
  const nextTitle = activeTitleInput.value.trim();
  if (!nextTitle) {
    activeTitleInput.value = titleBeforeEdit || tab.title;
    return;
  }
  if (nextTitle !== tab.title) {
    await applyTabTitle(tab.id, nextTitle);
  }
}

async function commitPaneTitle(input: HTMLInputElement): Promise<void> {
  const id = input.dataset.tabId;
  if (!id) {
    return;
  }
  const tab = await loadTabToCache(id);
  const nextTitle = input.value.trim();
  if (!nextTitle) {
    input.value = input.dataset.titleBeforeEdit || tab.title;
    return;
  }
  if (nextTitle !== tab.title) {
    await applyTabTitle(id, nextTitle);
  }
}

function focusTitleForPane(paneId: PaneId, select = false): void {
  const input = workspace.layout.splitMode === "vertical" ? paneForId(paneId).titleElement : activeTitleInput;
  if (input.disabled) {
    paneForId(paneId).view?.focus();
    return;
  }
  window.setTimeout(() => {
    input.focus();
    if (select) {
      input.select();
    }
  }, 0);
}

async function loadTabToCache(id: string): Promise<TabDocument> {
  const cached = contentCache.get(id);
  if (cached) {
    return ensureTab(cached);
  }
  const tab = ensureTab(await window.textEditor.loadTab(id));
  contentCache.set(id, tab);
  return tab;
}

async function activateTab(id: string, options: { flushCurrent?: boolean; childTabId?: string } = {}): Promise<void> {
  const pane = activePane();
  const cachedTab = contentCache.get(id);
  if (pane.activeTabId === id && cachedTab && (!options.childTabId || pane.activeChildTabId === options.childTabId)) {
    const cachedChild = childTabForPane(cachedTab, pane);
    if (pane.view?.state.doc.toString() === cachedChild.content && !pane.host.classList.contains("is-empty")) {
      return;
    }
  }
  if (options.flushCurrent !== false) {
    await flushSave();
  }
  const tab = await loadTabToCache(id);
  const children = getChildTabs(tab);
  const requestedChildId = options.childTabId ?? pane.activeChildTabId ?? tab.activeChildTabId ?? MAIN_CHILD_TAB_ID;
  const child = children.find((entry) => entry.id === requestedChildId) ?? children.find((entry) => entry.id === tab.activeChildTabId) ?? children[0];
  cachePaneEditorState(pane);
  pane.activeTabId = id;
  pane.activeChildTabId = child.id;
  tab.activeChildTabId = child.id;
  contentCache.set(id, tab);
  selectedGroupId = tabGroupId(id);
  syncActiveTabId();
  workspace.openedTabIds = Array.from(new Set([...workspace.openedTabIds, id]));
  workspace.recentTabIds = [id, ...workspace.recentTabIds.filter((entry) => entry !== id)].slice(0, 20);
  await saveWorkspace();
  setPaneEditorContent(pane, child.content);
  setPaneEditorEnabled(pane, true);
  renderSidebar();
  updateStatus();
  pane.view?.focus();
}

async function openTabInPane(id: string, paneId: PaneId, childTabId?: string): Promise<void> {
  if (paneId === "right" && workspace.layout.splitMode !== "vertical") {
    await splitRight();
  }
  setActivePane(paneId);
  await activateTab(id, { childTabId });
  paneForId(paneId).view?.focus();
}

async function createNewTab(targetGroupIdOverride?: string | null): Promise<void> {
  if (creatingTab) {
    return;
  }

  creatingTab = true;
  try {
    await flushSave();
    const id = nextTabId();
    const updatedAt = nowIso();
    const tab: TabDocument = {
      id,
      title: nextUntitledTitle(),
      content: "",
      activeChildTabId: MAIN_CHILD_TAB_ID,
      childTabs: childTabsFromTemplate("", updatedAt),
      updatedAt
    };

    const normalized = ensureTab(tab);
    contentCache.set(id, normalized);
    updateMetaFromDocument(normalized);
    const requestedGroupId = targetGroupIdOverride === undefined ? selectedTargetGroupId() : targetGroupIdOverride;
    const targetGroupId = requestedGroupId && tabIndex.groups?.some((group) => group.id === requestedGroupId) ? requestedGroupId : null;
    selectedGroupId = targetGroupId;
    expandTargetGroup(targetGroupId);
    tabIndex = insertTabIntoIndexGroup(tabIndex, id, targetGroupId);
    cachePaneEditorState(activePane());
    activePane().activeTabId = id;
    activePane().activeChildTabId = MAIN_CHILD_TAB_ID;
    workspace.openedTabIds = Array.from(new Set([...workspace.openedTabIds, id]));
    workspace.recentTabIds = [id, ...workspace.recentTabIds.filter((entry) => entry !== id)].slice(0, 20);
    workspace.expandedIds = Array.from(new Set([...workspace.expandedIds, "opened"]));
    syncActiveTabId();
    setPaneEditorContent(activePane(), "");
    setPaneEditorEnabled(activePane(), true);
    renderSidebar();
    updateStatus();
    const saved = ensureTab(await window.textEditor.saveTab(normalized));
    contentCache.set(id, saved);
    updateMetaFromDocument(saved);
    tabIndex = insertTabIntoIndexGroup(tabIndex, id, targetGroupId);
    await saveTabsIndex();
    await saveWorkspace();
    renderSidebar();
    setSaveState(text().newTabCreated);
    focusTitleForPane(activePaneId, true);
  } catch (error) {
    setSaveState(`${text().newTabFailed}: ${errorMessage(error)}`, "error");
    console.error(error);
  } finally {
    creatingTab = false;
  }
}

async function importTxt(multiple: boolean): Promise<void> {
  await flushSave();
  try {
    const result = await window.textEditor.importTxt(multiple);
    if (result.canceled || result.files.length === 0) {
      return;
    }

    const targetGroupId = selectedTargetGroupId();
    expandTargetGroup(targetGroupId);
    selectedGroupId = targetGroupId;
    const importedIds: string[] = [];

    for (const file of result.files) {
      const id = nextTabId();
      const updatedAt = nowIso();
      const title = file.title.trim() || text().untitled;
      const tab = ensureTab({
        id,
        title,
        content: file.content,
        activeChildTabId: MAIN_CHILD_TAB_ID,
        childTabs: childTabsFromTemplate(file.content, updatedAt),
        updatedAt
      });

      contentCache.set(id, tab);
      updateMetaFromDocument(tab);
      tabIndex = insertTabIntoIndexGroup(tabIndex, id, targetGroupId);
      workspace.openedTabIds = Array.from(new Set([...workspace.openedTabIds, id]));
      workspace.recentTabIds = [id, ...workspace.recentTabIds.filter((entry) => entry !== id)].slice(0, 20);
      const saved = ensureTab(await window.textEditor.saveTab(tab));
      contentCache.set(id, saved);
      updateMetaFromDocument(saved);
      tabIndex = insertTabIntoIndexGroup(tabIndex, id, targetGroupId);
      importedIds.push(id);
    }

    workspace.openedTabIds = flattenedOpenedTabIds();
    await saveTabsIndex();
    await saveWorkspace();
    renderSidebar();
    await openTabInPane(importedIds[0], "left", MAIN_CHILD_TAB_ID);
    setSaveState(`${text().txtImported}: ${result.files.length}`);
  } catch (error) {
    setSaveState(`${text().importTxtFailed}: ${errorMessage(error)}`, "error");
    console.error(error);
  }
}

async function activateChildTab(tabId: string, childTabId: string, paneId?: PaneId): Promise<void> {
  const targetPane = paneId ? paneForId(paneId) : activePane();
  setActivePane(targetPane.id);
  if (targetPane.activeTabId !== tabId) {
    await activateTab(tabId, { childTabId });
    return;
  }
  await flushSave();
  const tab = await loadTabToCache(tabId);
  const child = getChildTabs(tab).find((entry) => entry.id === childTabId);
  if (!child) {
    return;
  }
  cachePaneEditorState(targetPane);
  targetPane.activeChildTabId = child.id;
  tab.activeChildTabId = child.id;
  contentCache.set(tabId, tab);
  syncActiveTabId();
  setPaneEditorContent(targetPane, child.content);
  setPaneEditorEnabled(targetPane, true);
  await saveWorkspace();
  updateStatus();
}

async function createChildTab(tabId: string, paneId?: PaneId): Promise<void> {
  const title = (await requestTextDialog(text().childTabTitle, text().memoChildTab))?.trim();
  if (!title) {
    return;
  }
  const tab = await loadTabToCache(tabId);
  const id = nextChildTabId(tab, title);
  const updatedAt = nowIso();
  const updated = ensureTab({
    ...tab,
    activeChildTabId: id,
    childTabs: [
      ...getChildTabs(tab),
      {
        id,
        title,
        content: "",
        updatedAt
      }
    ],
    updatedAt
  });
  contentCache.set(tabId, updated);
  updateMetaFromDocument(updated);
  scheduleSave(tabId);
  await activateChildTab(tabId, id, paneId);
}

async function renameChildTab(tabId: string, childTabId: string): Promise<void> {
  const tab = await loadTabToCache(tabId);
  const child = getChildTabs(tab).find((entry) => entry.id === childTabId);
  if (!child) {
    return;
  }
  const nextTitle = (await requestTextDialog(text().childTabTitle, child.title))?.trim();
  if (!nextTitle) {
    return;
  }
  const updated = ensureTab({
    ...tab,
    childTabs: getChildTabs(tab).map((entry) => (entry.id === childTabId ? { ...entry, title: nextTitle, updatedAt: nowIso() } : entry)),
    updatedAt: nowIso()
  });
  contentCache.set(tabId, updated);
  updateMetaFromDocument(updated);
  syncPaneViewsForTab(tabId);
  renderChildTabBars();
  updateStatus();
  scheduleSave(tabId);
}

async function deleteChildTab(tabId: string, childTabId: string): Promise<void> {
  if (childTabId === MAIN_CHILD_TAB_ID) {
    return;
  }
  const tab = await loadTabToCache(tabId);
  const child = getChildTabs(tab).find((entry) => entry.id === childTabId);
  if (!child || !(await confirmDialog(text().childTabDeleteConfirm(child.title), text().delete))) {
    return;
  }
  const updated = ensureTab({
    ...tab,
    activeChildTabId: MAIN_CHILD_TAB_ID,
    childTabs: getChildTabs(tab).filter((entry) => entry.id !== childTabId),
    updatedAt: nowIso()
  });
  contentCache.set(tabId, updated);
  updateMetaFromDocument(updated);
  (Object.values(panes) as EditorPaneState[]).forEach((pane) => {
    if (pane.activeTabId === tabId && pane.activeChildTabId === childTabId) {
      cachePaneEditorState(pane);
      pane.activeChildTabId = MAIN_CHILD_TAB_ID;
      setPaneEditorContent(pane, childTabForPane(updated, pane).content);
    }
  });
  syncActiveTabId();
  renderChildTabBars();
  updateStatus();
  scheduleSave(tabId);
  await saveWorkspace();
}

async function createGroup(): Promise<void> {
  tabIndex = ensureTabsIndex();
  const id = nextGroupId();
  const now = nowIso();
  tabIndex = normalizeTabsIndex({
    ...tabIndex,
    groups: [
      ...(tabIndex.groups ?? []),
      {
        id,
        title: text().newGroup,
        tabIds: [],
        collapsed: false,
        updatedAt: now
      }
    ]
  });
  selectedGroupId = id;
  await saveTabsIndex();
  renderSidebar();
}

async function renameGroup(id: string): Promise<void> {
  const group = tabIndex.groups?.find((entry) => entry.id === id);
  if (!group) {
    return;
  }
  const nextTitle = (await requestTextDialog(text().groupTitle, group.title))?.trim();
  if (!nextTitle) {
    return;
  }
  tabIndex = normalizeTabsIndex({
    ...tabIndex,
    groups: tabIndex.groups?.map((entry) =>
      entry.id === id
        ? {
            ...entry,
            title: nextTitle,
            updatedAt: nowIso()
          }
        : entry
    )
  });
  await saveTabsIndex();
  renderSidebar();
}

async function deleteGroup(id: string): Promise<void> {
  const group = tabIndex.groups?.find((entry) => entry.id === id);
  if (!group || !(await confirmDialog(text().deleteGroupConfirm(group.title), text().deleteGroup))) {
    return;
  }
  tabIndex = normalizeTabsIndex({
    ...tabIndex,
    groups: tabIndex.groups?.filter((entry) => entry.id !== id),
    ungroupedTabIds: [...(tabIndex.ungroupedTabIds ?? []), ...group.tabIds]
  });
  if (selectedGroupId === id) {
    selectedGroupId = null;
  }
  await saveTabsIndex();
  renderSidebar();
}

async function toggleGroup(id: string): Promise<void> {
  if (id === UNGROUPED_GROUP_ID) {
    selectedGroupId = null;
    await setUngroupedCollapsed(!isUngroupedCollapsed());
    renderSidebar();
    return;
  }
  selectedGroupId = id;
  tabIndex = normalizeTabsIndex({
    ...tabIndex,
    groups: tabIndex.groups?.map((group) =>
      group.id === id
        ? {
            ...group,
            collapsed: !group.collapsed,
            updatedAt: nowIso()
          }
        : group
    )
  });
  await saveTabsIndex();
  renderSidebar();
}

async function closeTab(id: string): Promise<void> {
  if (!(await flushSave({ retry: false }))) {
    return;
  }
  const affectedPanes = (Object.values(panes) as EditorPaneState[]).filter((pane) => pane.activeTabId === id);
  workspace.openedTabIds = workspace.openedTabIds.filter((entry) => entry !== id);
  workspace.recentTabIds = [id, ...workspace.recentTabIds.filter((entry) => entry !== id)].slice(0, 20);

  if (affectedPanes.length > 0) {
    const nextId = workspace.openedTabIds[0] ?? null;
    affectedPanes.forEach((pane) => {
      pane.activeTabId = null;
      pane.activeChildTabId = MAIN_CHILD_TAB_ID;
      setPaneEditorContent(pane, "");
      setPaneEditorEnabled(pane, Boolean(nextId));
    });
    syncActiveTabId();
    if (nextId) {
      await saveWorkspace();
      for (const pane of affectedPanes) {
        setActivePane(pane.id);
        await activateTab(nextId);
      }
      return;
    }
  }

  syncActiveTabId();
  await saveWorkspace();
  renderSidebar();
  updateStatus();
}

async function renameTab(id: string): Promise<void> {
  const meta = tabIndex.tabs.find((tab) => tab.id === id);
  const nextTitle = (await requestTextDialog(text().newTitle, meta?.title ?? text().untitled))?.trim();
  if (!nextTitle) {
    return;
  }
  await applyTabTitle(id, nextTitle);
}

function uniqueDuplicateTitle(sourceTitle: string): string {
  const suffix = workspace.locale === "jp" ? "コピー" : "Copy";
  const base = `${sourceTitle} - ${suffix}`;
  const titles = new Set(tabIndex.tabs.map((tab) => tab.title));
  if (!titles.has(base)) {
    return base;
  }
  let index = 2;
  while (titles.has(`${base} ${index}`)) {
    index += 1;
  }
  return `${base} ${index}`;
}

function uniqueRestoredTitle(sourceTitle: string): string {
  const base = `${sourceTitle} - ${text().restoredTabSuffix}`;
  const titles = new Set(tabIndex.tabs.map((tab) => tab.title));
  if (!titles.has(base)) {
    return base;
  }
  let index = 2;
  while (titles.has(`${base} ${index}`)) {
    index += 1;
  }
  return `${base} ${index}`;
}

async function togglePinTab(id: string): Promise<void> {
  const current = isTabPinned(id);
  tabIndex = normalizePinnedOrderInIndex({
    ...tabIndex,
    tabs: tabIndex.tabs.map((tab) => (tab.id === id ? { ...tab, pinned: !current } : tab))
  });
  workspace.openedTabIds = flattenedOpenedTabIds();
  await saveTabsIndex();
  await saveWorkspace();
  renderSidebar();
  setSaveState(current ? text().tabUnpinned : text().tabPinned);
}

async function duplicateTab(id: string): Promise<void> {
  if (!(await flushSave({ retry: false }))) {
    return;
  }
  const source = await loadTabToCache(id);
  const newId = nextTabId();
  const updatedAt = nowIso();
  const title = uniqueDuplicateTitle(source.title);
  const childTabs = getChildTabs(source).map((child) => ({
    ...child,
    updatedAt
  }));
  const duplicated = ensureTab({
    ...source,
    id: newId,
    title,
    content: getMainChildTab(source).content,
    activeChildTabId: source.activeChildTabId ?? MAIN_CHILD_TAB_ID,
    childTabs,
    updatedAt
  });
  const sourceGroupId = tabGroupId(id);

  contentCache.set(newId, duplicated);
  updateMetaFromDocument(duplicated);
  tabIndex = normalizeTabsIndex({
    ...tabIndex,
    tabs: tabIndex.tabs.map((tab) => (tab.id === newId ? { ...tab, pinned: false } : tab))
  });
  tabIndex = insertTabIntoIndexGroup(tabIndex, newId, sourceGroupId, id, "after");
  selectedGroupId = sourceGroupId;
  workspace.openedTabIds = Array.from(new Set([...workspace.openedTabIds, newId]));
  workspace.openedTabIds = flattenedOpenedTabIds();
  workspace.recentTabIds = [newId, ...workspace.recentTabIds.filter((entry) => entry !== newId)].slice(0, 20);
  cachePaneEditorState(activePane());
  activePane().activeTabId = newId;
  activePane().activeChildTabId = duplicated.activeChildTabId ?? MAIN_CHILD_TAB_ID;
  syncActiveTabId();
  setPaneEditorContent(activePane(), childTabForPane(duplicated, activePane()).content);
  setPaneEditorEnabled(activePane(), true);

  const saved = ensureTab(await window.textEditor.saveTab(duplicated));
  contentCache.set(newId, saved);
  updateMetaFromDocument(saved);
  tabIndex = normalizeTabsIndex({
    ...tabIndex,
    tabs: tabIndex.tabs.map((tab) => (tab.id === newId ? { ...tab, pinned: false } : tab))
  });
  tabIndex = insertTabIntoIndexGroup(tabIndex, newId, sourceGroupId, id, "after");
  workspace.openedTabIds = flattenedOpenedTabIds();
  await saveTabsIndex();
  await saveWorkspace();
  renderSidebar();
  updateStatus();
  setSaveState(text().tabDuplicated);
}

async function ungroupTab(id: string): Promise<void> {
  if (!groupForTab(id)) {
    return;
  }
  tabIndex = insertTabIntoIndexGroup(tabIndex, id, null);
  selectedGroupId = null;
  workspace.openedTabIds = flattenedOpenedTabIds();
  await saveTabsIndex();
  await saveWorkspace();
  renderSidebar();
  setSaveState(text().tabOrderSaved);
}

async function deleteTab(id: string): Promise<void> {
  const meta = tabIndex.tabs.find((tab) => tab.id === id);
  if (!(await confirmDialog(text().deleteConfirm(meta?.title ?? id), text().delete))) {
    return;
  }
  if (!(await flushSave({ retry: false }))) {
    return;
  }

  tabIndex = normalizeTabsIndex(await window.textEditor.deleteTab(id));
  contentCache.delete(id);
  workspace.openedTabIds = workspace.openedTabIds.filter((entry) => entry !== id);
  workspace.recentTabIds = workspace.recentTabIds.filter((entry) => entry !== id);
  (Object.values(panes) as EditorPaneState[]).forEach((pane) => {
    if (pane.activeTabId === id) {
      pane.activeTabId = null;
      pane.activeChildTabId = MAIN_CHILD_TAB_ID;
      setPaneEditorContent(pane, "");
      setPaneEditorEnabled(pane, false);
    }
  });
  syncActiveTabId();
  await saveWorkspace();
  if (workspace.activeTabId) {
    await activateTab(workspace.activeTabId);
  } else {
    setEditorEnabled(false);
  }
  renderSidebar();
  updateStatus();
}

async function exportCurrentTxt(): Promise<void> {
  if (!(await flushSave({ retry: false }))) {
    return;
  }
  const tab = activeDocument();
  if (!tab) {
    return;
  }
  const pane = activePane();
  const child = childTabForPane(tab, pane);
  const result = await window.textEditor.exportTxt({
    ...tab,
    title: `${tab.title} - ${child.title}`,
    content: child.content,
    activeChildTabId: child.id,
    childTabs: [{ ...child }]
  });
  if (!result.canceled && result.filePath) {
    setSaveState(`${text().exported}: ${result.filePath}`);
  }
}

async function exportAllTxt(): Promise<void> {
  if (!(await flushSave({ retry: false }))) {
    return;
  }
  try {
    const result = await window.textEditor.exportAllTxt();
    if (!result.canceled && result.filePath) {
      const exportedPrefix = `${text().exported}:`;
      const previousMessage = saveState.textContent || text().saved;
      const previousMode = (saveState.dataset.mode as "idle" | "dirty" | "error" | undefined) ?? "idle";
      setSaveState(`${exportedPrefix} ${result.filePath}`);
      window.setTimeout(() => {
        if (saveState.textContent?.startsWith(exportedPrefix)) {
          setSaveState(previousMessage, previousMode);
        }
      }, 1800);
    }
  } catch (error) {
    setSaveState(`${text().exportAllFailed}: ${errorMessage(error)}`, "error");
  }
}

async function exportWorkspace(): Promise<void> {
  if (!(await flushSave({ retry: false }))) {
    return;
  }
  try {
    const result = await window.textEditor.exportWorkspace();
    if (!result.canceled && result.filePath) {
      setSaveState(`${text().workspaceExported}: ${result.filePath}`);
    }
  } catch (error) {
    setSaveState(`${text().exportWorkspaceFailed}: ${errorMessage(error)}`, "error");
  }
}

async function importWorkspace(): Promise<void> {
  if (!(await flushSave({ retry: false }))) {
    return;
  }
  setWorkspaceImportInProgress(true);
  const progressOverlay = showImportProgressDialog();
  try {
    const result = await window.textEditor.importWorkspace();
    progressOverlay.remove();
    if (result.canceled) {
      setWorkspaceImportInProgress(false);
      return;
    }
    lockImportedWorkspace();
    setSaveState(
      result.error ? `${text().importWorkspaceFailed}: ${result.error}` : text().workspaceImported,
      result.error ? "error" : "idle"
    );
    showImportRestartDialog(result.backupPath);
  } catch (error) {
    progressOverlay.remove();
    if (!workspaceImportedNeedsRestart) {
      setWorkspaceImportInProgress(false);
    }
    setSaveState(`${text().importWorkspaceFailed}: ${errorMessage(error)}`, "error");
  }
}

async function copyCurrentContent(): Promise<void> {
  const tab = activeDocument();
  if (!tab) {
    setSaveState(text().noActiveTab, "error");
    return;
  }

  try {
    const copiedMessage = text().copied;
    const previousMessage = saveState.textContent || text().saved;
    const previousMode = (saveState.dataset.mode as "idle" | "dirty" | "error" | undefined) ?? "idle";
    await window.textEditor.writeClipboardText(childTabForPane(tab, activePane()).content);
    setSaveState(copiedMessage);
    window.setTimeout(() => {
      if (saveState.textContent === copiedMessage) {
        setSaveState(previousMessage, previousMode);
      }
    }, 1400);
  } catch (error) {
    setSaveState(`${text().copyFailed}: ${errorMessage(error)}`, "error");
  }
}

function runEditorCommand(action: "undo" | "redo" | "find" | "replace" | "find-next" | "find-previous"): void {
  const view = activePane().view;
  if (!view) {
    return;
  }

  const commands = {
    undo,
    redo,
    find: openSearchPanel,
    replace: openSearchPanel,
    "find-next": findNext,
    "find-previous": findPrevious
  };
  commands[action](view);
}

async function applyThemeAndFont(): Promise<void> {
  shell.dataset.theme = workspace.theme;
  document.body.dataset.theme = workspace.theme;
  (Object.values(panes) as EditorPaneState[]).forEach((pane) => {
    pane.view?.dispatch({
      effects: [pane.themeCompartment.reconfigure(editorTheme()), pane.fontSizeCompartment.reconfigure([])]
    });
  });
  await saveWorkspace();
  updateStatus();
}

function applyLocale(): void {
  document.documentElement.lang = workspace.locale === "jp" ? "ja" : "en";
  document.body.dataset.locale = workspace.locale;
  leftEditorHost.dataset.emptyLabel = text().noOpenTab;
  rightEditorHost.dataset.emptyLabel = text().noOpenTab;
  updateGlobalSearchLabels();
  applyNovelViewerLabels();
}

function clearRestoredWorkspaceViewState(): void {
  workspace = {
    ...workspace,
    activeTabId: null,
    openedTabIds: [],
    layout: {
      ...workspace.layout,
      splitMode: "single",
      activePaneId: "left",
      panes: [
        { id: "left", activeTabId: null, activeChildTabId: MAIN_CHILD_TAB_ID },
        { id: "right", activeTabId: null, activeChildTabId: MAIN_CHILD_TAB_ID }
      ]
    }
  };
  activePaneId = "left";
  panes.left.activeTabId = null;
  panes.left.activeChildTabId = MAIN_CHILD_TAB_ID;
  panes.right.activeTabId = null;
  panes.right.activeChildTabId = MAIN_CHILD_TAB_ID;
  syncActiveTabId();
}

async function toggleLocale(): Promise<void> {
  workspace.locale = workspace.locale === "jp" ? "en" : "jp";
  await saveWorkspace();
  applyLocale();
  renderSidebar();
  updateStatus();
  setSaveState(text().languageChanged);
}

async function splitRight(): Promise<void> {
  workspace.layout.splitMode = "vertical";
  workspace.layout.splitRatio = workspace.layout.splitRatio || 0.5;
  if (!panes.right.activeTabId) {
    cachePaneEditorState(panes.right);
    panes.right.activeTabId = panes.left.activeTabId;
    panes.right.activeChildTabId = panes.left.activeChildTabId;
    if (panes.right.activeTabId) {
      const tab = await loadTabToCache(panes.right.activeTabId);
      setPaneEditorContent(panes.right, childTabForPane(tab, panes.right).content);
      setPaneEditorEnabled(panes.right, true);
    }
  }
  activePaneId = "right";
  syncActiveTabId();
  applyEditorLayout();
  await saveWorkspace();
  panes.right.view?.focus();
}

async function closeSplit(): Promise<void> {
  workspace.layout.splitMode = "single";
  cachePaneEditorState(panes.right);
  panes.right.activeTabId = null;
  panes.right.activeChildTabId = MAIN_CHILD_TAB_ID;
  setPaneEditorContent(panes.right, "");
  setPaneEditorEnabled(panes.right, false);
  activePaneId = "left";
  syncActiveTabId();
  applyEditorLayout();
  await saveWorkspace();
  panes.left.view?.focus();
}

function focusEditorPane(id: PaneId): void {
  if (id === "right" && novelViewerOpen) {
    void window.textEditor.focusNovelViewerRemote();
    return;
  }
  if (id === "right" && workspace.layout.splitMode !== "vertical") {
    return;
  }
  setActivePane(id);
  paneForId(id).view?.focus();
}

function applySidebarWidth(): void {
  const width = Math.min(420, Math.max(160, workspace.sidebarWidth || defaultWorkspace.sidebarWidth));
  workspace.sidebarWidth = width;
  const narrowSearch = !searchPanel.hidden && window.innerWidth < 980;
  const sidebarWidth = narrowSearch ? 0 : width;
  const searchWidth = searchPanel.hidden ? 0 : narrowSearch ? Math.min(320, Math.max(240, Math.floor(window.innerWidth * 0.38))) : 300;
  const splitAllowsMinimap = !novelViewerOpen && (workspace.layout.splitMode !== "vertical" || window.innerWidth >= 1350);
  const minimapVisible = splitAllowsMinimap && window.innerWidth >= 1050 && (searchPanel.hidden || window.innerWidth >= 1350);
  workspaceElement.classList.toggle("is-search-narrow", narrowSearch);
  workspaceElement.classList.toggle("is-minimap-hidden", !minimapVisible);
  workspaceElement.style.gridTemplateColumns = `${sidebarWidth}px ${searchWidth}px 5px minmax(0, 1fr) ${minimapVisible ? 86 : 0}px`;
  applySplitColumns();
}

function setupSplitResize(): void {
  let resizing = false;

  splitResizer.addEventListener("pointerdown", (event) => {
    if (novelViewerOpen || workspace.layout.splitMode !== "vertical") {
      return;
    }
    resizing = true;
    splitResizer.setPointerCapture(event.pointerId);
    document.body.classList.add("is-split-resizing");
  });

  document.addEventListener("pointermove", (event) => {
    if (!resizing) {
      return;
    }
    const rect = editorSplit.getBoundingClientRect();
    const usableWidth = Math.max(1, rect.width - SPLIT_RESIZER_WIDTH);
    const requestedRatio = (event.clientX - rect.left) / usableWidth;
    const normalizedRatio = Math.min(0.8, Math.max(0.2, requestedRatio));
    workspace.layout.splitRatio = clampSplitRatioForWidth(normalizedRatio, rect.width);
    applySplitColumns(true);
  });

  const finish = (event: PointerEvent): void => {
    if (!resizing) {
      return;
    }
    resizing = false;
    if (splitResizer.hasPointerCapture(event.pointerId)) {
      splitResizer.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("is-split-resizing");
    void saveWorkspace();
  };

  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
}

function setupSidebarResize(): void {
  let startX = 0;
  let startWidth = 0;
  let resizing = false;

  sidebarResizer.addEventListener("pointerdown", (event) => {
    startX = event.clientX;
    startWidth = workspace.sidebarWidth;
    resizing = true;
    sidebarResizer.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing");
  });

  document.addEventListener("pointermove", (event) => {
    if (!resizing) {
      return;
    }
    workspace.sidebarWidth = Math.min(420, Math.max(160, startWidth + event.clientX - startX));
    applySidebarWidth();
  });

  const finish = (event: PointerEvent): void => {
    if (!resizing) {
      return;
    }
    resizing = false;
    if (sidebarResizer.hasPointerCapture(event.pointerId)) {
      sidebarResizer.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("is-resizing");
    void saveWorkspace();
  };

  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
}

async function performAction(
  action: string | undefined,
  options: { id?: string; childId?: string; paneId?: PaneId; fileName?: string; source?: HTMLElement } = {}
): Promise<void> {
  const { id, childId, paneId, fileName, source } = options;

  if (!bootstrapReadyForClose && action !== "reload-app") {
    return;
  }
  if ((workspaceImportedNeedsRestart || workspaceImportInProgress) && action !== "reload-app") {
    return;
  }

  if (action === "new-tab") await createNewTab();
  else if (action === "new-group") await createGroup();
  else if (action === "new-tab-in-group") await createNewTab(id === UNGROUPED_GROUP_ID ? null : id ?? null);
  else if (action === "import-txt") await importTxt(false);
  else if (action === "import-txt-files") await importTxt(true);
  else if (action === "open-recent") showRecentDialog();
  else if (action === "open-backups") await showBackupsDialog();
  else if (action === "copy-all") await copyCurrentContent();
  else if (action === "export-txt") await exportCurrentTxt();
  else if (action === "export-all-txt") await exportAllTxt();
  else if (action === "export-workspace") await exportWorkspace();
  else if (action === "import-workspace") await importWorkspace();
  else if (action === "global-search") openGlobalSearchPane();
  else if (action === "close-global-search") closeGlobalSearchPane();
  else if (action === "open-search-result" && options.source?.dataset.resultIndex) await openSearchResult(Number(options.source.dataset.resultIndex));
  else if (action === "split-right") await splitRight();
  else if (action === "close-split") await closeSplit();
  else if (action === "focus-left") focusEditorPane("left");
  else if (action === "focus-right") focusEditorPane("right");
  else if (action === "toggle-novel-viewer") await toggleNovelViewer();
  else if (action === "focus-novel-viewer-address") focusNovelViewerAddress();
  else if (action === "close-novel-viewer") await closeNovelViewer();
  else if (action === "novel-viewer-back") renderNovelViewerStatus(await window.textEditor.goBackNovelViewer());
  else if (action === "novel-viewer-forward") renderNovelViewerStatus(await window.textEditor.goForwardNovelViewer());
  else if (action === "novel-viewer-reload") renderNovelViewerStatus(await window.textEditor.reloadOrStopNovelViewer());
  else if (action === "novel-viewer-external") await window.textEditor.openNovelViewerExternal();
  else if (action === "novel-viewer-close") await closeNovelViewer();
  else if (action === "reload-app") {
    if (novelViewerOpen) renderNovelViewerStatus(await window.textEditor.reloadOrStopNovelViewer());
    else await window.textEditor.reloadApp();
  }
  else if (action === "undo" || action === "redo" || action === "find" || action === "replace" || action === "find-next" || action === "find-previous") {
    runEditorCommand(action);
  } else if (action === "toggle-theme") {
    workspace.theme = workspace.theme === "dark" ? "light" : "dark";
    await applyThemeAndFont();
  } else if (action === "toggle-locale") {
    await toggleLocale();
  } else if (action === "open-settings") {
    openSettingsDialog();
  } else if (action === "font-down") {
    workspace.fontSize = Math.max(12, workspace.fontSize - 1);
    await applyThemeAndFont();
  } else if (action === "font-up") {
    workspace.fontSize = Math.min(26, workspace.fontSize + 1);
    await applyThemeAndFont();
  } else if (action === "open-tab-main" && id) {
    await openTabInPane(id, "left");
  } else if (action === "open-tab-sub" && id) {
    await openTabInPane(id, "right");
  } else if (action === "open-child-main" && id && childId) {
    await openTabInPane(id, "left", childId);
  } else if (action === "open-child-sub" && id && childId) {
    await openTabInPane(id, "right", childId);
  } else if (action === "activate-tab" && id) await activateTab(id);
  else if (action === "toggle-group" && id) await toggleGroup(id);
  else if (action === "rename-group" && id) await renameGroup(id);
  else if (action === "delete-group" && id) await deleteGroup(id);
  else if (action === "activate-child-tab" && id && childId) await activateChildTab(id, childId, paneId);
  else if (action === "new-child-tab" && id) await createChildTab(id, paneId);
  else if (action === "rename-child-tab" && id && childId) await renameChildTab(id, childId);
  else if (action === "delete-child-tab" && id && childId) await deleteChildTab(id, childId);
  else if (action === "reopen-tab" && id) {
    source?.closest(".dialog-overlay")?.remove();
    await activateTab(id);
  } else if (action === "close-tab" && id) await closeTab(id);
  else if (action === "rename-tab" && id) await renameTab(id);
  else if (action === "toggle-pin-tab" && id) await togglePinTab(id);
  else if (action === "duplicate-tab" && id) await duplicateTab(id);
  else if (action === "clear-remote-inbox" && id) await clearRemoteInboxTab(id);
  else if (action === "ungroup-tab" && id) await ungroupTab(id);
  else if (action === "delete-tab" && id) await deleteTab(id);
  else if (action === "restore-backup" && id && fileName) {
    source?.closest(".dialog-overlay")?.remove();
    await restoreBackup(id, fileName);
  } else if (action === "restore-backup-as-tab" && id && fileName) {
    await restoreBackupAsNewTab(id, fileName);
  } else if (action === "toggle-section" && id) setExpanded(id, !isExpanded(id));
}

document.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
  if (!(event.target as HTMLElement).closest(".context-menu")) {
    closeContextMenu();
  }
  if (!button) {
    return;
  }

  const action = button.dataset.action;
  const id = button.dataset.id;
  const childId = button.dataset.childId;
  const paneId = button.dataset.paneId === "right" ? "right" : button.dataset.paneId === "left" ? "left" : undefined;
  const fileName = button.dataset.file;
  const fromContextMenu = Boolean(button.closest(".context-menu"));
  if (fromContextMenu) {
    closeContextMenu();
  }

  void (async () => {
    try {
      await performAction(action, { id, childId, paneId, fileName, source: button });
    } catch (error) {
      setSaveState(`${text().actionFailed}: ${errorMessage(error)}`, "error");
      console.error(error);
    }
  })();
});

globalSearchInput.addEventListener("input", () => {
  scheduleGlobalSearch();
});

globalSearchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void openSearchResult(0);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeGlobalSearchPane();
  }
});

document.addEventListener("contextmenu", (event) => {
  const target = event.target as HTMLElement;
  const childButton = target.closest<HTMLElement>(".child-tab-button[data-id][data-child-id]");
  if (childButton) {
    event.preventDefault();
    const id = childButton.dataset.id;
    const childId = childButton.dataset.childId;
    if (id && childId) {
      showChildContextMenu(id, childId, event.clientX, event.clientY);
    }
    return;
  }

  const groupHeader = target.closest<HTMLElement>(".group-header[data-group-id]");
  if (groupHeader) {
    event.preventDefault();
    const groupId = groupHeader.dataset.groupId;
    if (groupId) {
      showGroupContextMenu(groupId, event.clientX, event.clientY);
    }
    return;
  }

  const row = target.closest<HTMLElement>(".tab-row[data-id]");
  if (row) {
    event.preventDefault();
    const id = row.dataset.id;
    if (id) {
      showContextMenu(id, event.clientX, event.clientY);
    }
    return;
  }

  if (target.closest("#sidebar") && !target.closest(".group-section") && !target.closest(".sidebar-top")) {
    event.preventDefault();
    showSidebarBlankContextMenu(event.clientX, event.clientY);
  }
});

document.addEventListener("dragstart", (event) => {
  const groupHeader = (event.target as HTMLElement).closest<HTMLElement>(".group-header[data-group-id]");
  const groupId = groupHeader?.dataset.groupId;
  if (groupHeader && groupId && groupId !== UNGROUPED_GROUP_ID) {
    draggedItem = { type: "group", id: groupId };
    groupHeader.closest(".group-section")?.classList.add("is-dragging");
    event.dataTransfer?.setData("text/plain", `group:${groupId}`);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
    closeContextMenu();
    return;
  }

  const row = (event.target as HTMLElement).closest<HTMLElement>(".tab-row[data-id]");
  const id = row?.dataset.id;
  if (!row || !id) {
    return;
  }

  draggedItem = { type: "tab", id };
  row.classList.add("is-dragging");
  event.dataTransfer?.setData("text/plain", `tab:${id}`);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
  }
  closeContextMenu();
});

document.addEventListener("dragover", (event) => {
  if (!draggedItem) {
    clearDragMarkers();
    return;
  }

  if (draggedItem.type === "group") {
    const groupSection = (event.target as HTMLElement).closest<HTMLElement>(".group-section[data-group-id]");
    const groupId = groupSection?.dataset.groupId;
    if (!groupSection || !groupId || groupId === UNGROUPED_GROUP_ID || groupId === draggedItem.id) {
      clearDragMarkers();
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    clearDragMarkers();
    groupSection.classList.add(dropPlacement(groupSection, event.clientY) === "before" ? "is-drag-over-before" : "is-drag-over-after");
    return;
  }

  const row = (event.target as HTMLElement).closest<HTMLElement>(".tab-row[data-id]");
  if (row && row.dataset.id !== draggedItem.id) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    clearDragMarkers();
    row.classList.add(dropPlacement(row, event.clientY) === "before" ? "is-drag-over-before" : "is-drag-over-after");
    return;
  }

  const groupSection = (event.target as HTMLElement).closest<HTMLElement>(".group-section[data-group-id]");
  if (groupSection) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    clearDragMarkers();
    groupSection.classList.add("is-drop-into");
    return;
  }

  clearDragMarkers();
});

document.addEventListener("drop", (event) => {
  const rawSource = event.dataTransfer?.getData("text/plain");
  const source = rawSource?.includes(":")
    ? { type: rawSource.split(":")[0] as "tab" | "group", id: rawSource.split(":")[1] }
    : draggedItem;
  clearDragMarkers();
  if (!source) {
    return;
  }

  if (source.type === "group") {
    const groupSection = (event.target as HTMLElement).closest<HTMLElement>(".group-section[data-group-id]");
    const targetGroupId = groupSection?.dataset.groupId;
    if (!groupSection || !targetGroupId || targetGroupId === UNGROUPED_GROUP_ID) {
      return;
    }
    event.preventDefault();
    void moveGroup(source.id, targetGroupId, dropPlacement(groupSection, event.clientY));
    return;
  }

  const row = (event.target as HTMLElement).closest<HTMLElement>(".tab-row[data-id]");
  const targetId = row?.dataset.id;
  if (row && targetId) {
    event.preventDefault();
    void moveOpenedTab(source.id, targetId, dropPlacement(row, event.clientY));
    return;
  }

  const groupSection = (event.target as HTMLElement).closest<HTMLElement>(".group-section[data-group-id]");
  const groupId = groupSection?.dataset.groupId;
  if (groupSection && groupId) {
    event.preventDefault();
    void moveTabToGroup(source.id, groupId === UNGROUPED_GROUP_ID ? null : groupId);
  }
});

document.addEventListener("dragend", () => {
  document.querySelectorAll(".tab-row.is-dragging").forEach((row) => row.classList.remove("is-dragging"));
  document.querySelectorAll(".group-section.is-dragging").forEach((row) => row.classList.remove("is-dragging"));
  clearDragMarkers();
  draggedItem = null;
});

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) {
    return;
  }
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const shortcutActions: Record<string, MenuAction> = {
    "mod+n": "new-tab",
    "mod+s": "export-txt",
    "mod+shift+b": "open-backups",
    "mod+shift+r": "open-recent",
    "mod+shift+c": "copy-all",
    "mod+shift+l": "toggle-locale",
    "mod+shift+f": "global-search",
    "mod+shift+v": "toggle-novel-viewer",
    "mod+shift+w": "close-novel-viewer",
    "mod+l": "focus-novel-viewer-address",
    "mod+\\": "split-right",
    "mod+1": "focus-left",
    "mod+2": "focus-right",
    "mod+f": "find",
    "mod+h": "replace",
    "mod+y": "redo",
    "mod+z": "undo",
    "mod++": "font-up",
    "mod+-": "font-down",
    "f3": "find-next",
    "shift+f3": "find-previous"
  };
  const signature = mod
    ? `mod+${event.shiftKey ? "shift+" : ""}${key}`
    : `${event.shiftKey ? "shift+" : ""}${key}`;
  const action = shortcutActions[signature];

  if (action) {
    event.preventDefault();
    void (async () => {
      try {
        await performAction(action);
      } catch (error) {
        setSaveState(`${text().actionFailed}: ${errorMessage(error)}`, "error");
        console.error(error);
      }
    })();
    return;
  }

  if (event.key === "Escape") {
    closeContextMenu();
    const overlay = document.querySelector<HTMLElement>(".dialog-overlay");
    const cancelButton = overlay?.querySelector<HTMLButtonElement>(
      '[data-dialog-action="cancel"], [data-recovery-action="cancel"]'
    );
    cancelButton?.click();
    if (document.activeElement === activeTitleInput) {
      activeTitleInput.value = titleBeforeEdit;
      activeTitleInput.blur();
    }
    if (novelViewerOpen && !overlay && document.activeElement === novelViewerAddress) {
      if (!novelViewerSinglePane) panes.left.view?.focus();
      else novelViewerAddress.blur();
    }
  }
});

novelViewerAddress.addEventListener("input", () => {
  novelViewerAddressDirty = true;
});

novelViewerAddressForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const requestedUrl = novelViewerAddress.value;
  novelViewerAddressDirty = false;
  void window.textEditor.navigateNovelViewer(requestedUrl).then(renderNovelViewerStatus, (error: unknown) => {
    console.error("Novel Viewer navigation failed:", error);
  });
});

novelViewerSlot.addEventListener("focus", () => {
  if (novelViewerStatus.committedUrl && !novelViewerStatus.error) void window.textEditor.focusNovelViewerRemote();
  else focusNovelViewerAddress();
});

activeTitleInput.addEventListener("focus", () => {
  titleBeforeEdit = activeTitleInput.value;
});

activeTitleInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    activeTitleInput.blur();
    activePane().view?.focus();
  }
});

activeTitleInput.addEventListener("blur", () => {
  void commitActiveTitle();
});

document.querySelectorAll<HTMLInputElement>(".pane-title-input").forEach((input) => {
  input.addEventListener("focus", () => {
    input.dataset.titleBeforeEdit = input.value;
    setActivePane(input.dataset.paneId === "right" ? "right" : "left");
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
      paneForId(input.dataset.paneId === "right" ? "right" : "left").view?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      input.value = input.dataset.titleBeforeEdit || input.value;
      input.blur();
    }
  });
  input.addEventListener("blur", () => {
    void commitPaneTitle(input);
  });
});

window.addEventListener("resize", () => {
  applySidebarWidth();
  if (novelViewerOpen) applyNovelViewerLayout();
});

window.textEditor.onMenuAction((action: MenuAction) => {
  void (async () => {
    try {
      await performAction(action);
    } catch (error) {
      setSaveState(`${text().actionFailed}: ${errorMessage(error)}`, "error");
      console.error(error);
    }
  })();
});

window.textEditor.onNovelViewerState((status) => {
  renderNovelViewerStatus(status);
});

window.textEditor.onNovelViewerFocusAddress(() => focusNovelViewerAddress());
window.textEditor.onNovelViewerRequestClose(() => {
  void closeNovelViewer();
});
window.textEditor.onNovelViewerScrollRestoreWarning(() => {
  setSaveState(novelViewerText().restoreWarning, "error");
});
window.textEditor.onNovelViewerRequestBounds(() => {
  syncNovelViewerOcclusion(true);
  scheduleNovelViewerBounds();
});
window.textEditor.onNovelViewerRequestDiagnosticSnapshot((reason) => {
  submitNovelViewerRendererDiagnostic(reason);
});

window.addEventListener("texteditor:workspace-imported", () => {
  lockImportedWorkspace();
});

window.textEditor.onBeforeClose(async () => {
  if (workspaceImportInProgress) {
    return {
      ok: false,
      error: workspace.locale === "jp" ? "Workspaceのインポート処理中です" : "Workspace import is still in progress"
    };
  }
  if (workspaceImportedNeedsRestart || !appStateLoaded) {
    return { ok: true };
  }
  if (!bootstrapReadyForClose) {
    const saved = await flushSave({ retry: false });
    return saved ? { ok: true } : { ok: false, error: text().autosaveFailed };
  }
  const saved = await flushSave({ retry: false });
  if (!saved) {
    return { ok: false, error: text().autosaveFailed };
  }
  try {
    syncActiveTabId();
    await saveWorkspace();
    return { ok: true };
  } catch (error) {
    const message = errorMessage(error);
    setSaveState(`${text().autosaveFailed}: ${message}`, "error");
    return { ok: false, error: message };
  }
});

window.addEventListener("beforeunload", () => {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
  }
  if (minimapTimer !== null) {
    window.clearTimeout(minimapTimer);
  }
  clearSaveRetry();
});

function remoteTimestamp(): string {
  const date = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const remoteOperationQueues = new Map<string, Promise<void>>();

function remoteTargetMatches(targetTabName: string): TabMeta[] {
  return tabIndex.tabs.filter((entry) => entry.title === targetTabName.trim());
}

function duplicateRemoteTargetError(targetTabName: string): string {
  return workspace.locale === "jp"
    ? `受信先「${targetTabName}」と同名のタブが複数あるため、Remote Inboxの操作を中止しました`
    : `Remote Inbox stopped because multiple tabs use the target name "${targetTabName}"`;
}

function enqueueRemoteOperation<T>(targetTabName: string, operation: () => Promise<T>): Promise<T> {
  const previous = remoteOperationQueues.get(targetTabName) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const completion = result.then(
    () => undefined,
    () => undefined
  );
  remoteOperationQueues.set(targetTabName, completion);
  void completion.finally(() => {
    if (remoteOperationQueues.get(targetTabName) === completion) {
      remoteOperationQueues.delete(targetTabName);
    }
  });
  return result;
}

async function appendRemoteInbox(textValue: string, includeTimestamp: boolean, targetTabName: string): Promise<void> {
  if (!bootstrapReadyForClose || workspaceImportedNeedsRestart || workspaceImportInProgress) {
    throw new Error(bootstrapReadyForClose ? "Workspace restart required" : "Workspace is still loading");
  }
  const title = targetTabName.trim();
  const matches = remoteTargetMatches(title);
  if (matches.length > 1) {
    throw new Error(duplicateRemoteTargetError(title));
  }
  const meta: TabMeta | undefined = matches[0];
  let tab: TabDocument;
  if (meta) {
    tab = await loadTabToCache(meta.id);
  } else {
    const id = nextTabId();
    const updatedAt = nowIso();
    tab = ensureTab({ id, title, content: "", activeChildTabId: MAIN_CHILD_TAB_ID, childTabs: [{ id: MAIN_CHILD_TAB_ID, title: localizedMainChildTitle(), content: "", updatedAt }], updatedAt });
    contentCache.set(id, tab);
    updateMetaFromDocument(tab);
    tabIndex = normalizeTabsIndex({
      ...tabIndex,
      tabs: tabIndex.tabs.map((entry) => (entry.id === id ? { ...entry, pinned: true } : entry))
    });
    tabIndex = insertTabIntoIndexGroup(tabIndex, id, null);
    await saveTabsIndex();
    workspace.openedTabIds = workspace.openedTabIds.includes(id) ? workspace.openedTabIds : [...workspace.openedTabIds, id];
    workspace.recentTabIds = [id, ...workspace.recentTabIds.filter((tabId) => tabId !== id)];
    await saveWorkspace();
  }
  const main = getMainChildTab(tab);
  const entry = includeTimestamp ? `[${remoteTimestamp()}]\n${textValue}` : textValue;
  const content = main.content ? `${main.content}\n\n${entry}` : entry;
  const updated = setChildContent(tab, MAIN_CHILD_TAB_ID, content);
  updated.updatedAt = nowIso();
  updated.revision = (tab.revision ?? 0) + 1;
  const saved = ensureTab(await window.textEditor.saveTab(updated));
  contentCache.set(saved.id, saved);
  updateMetaFromDocument(saved);
  for (const pane of Object.values(panes) as EditorPaneState[]) {
    if (pane.activeTabId !== saved.id || pane.activeChildTabId !== MAIN_CHILD_TAB_ID || !pane.view) continue;
    pane.programmaticChange = true;
    pane.view.dispatch({ changes: { from: pane.view.state.doc.length, insert: `${pane.view.state.doc.length ? "\n\n" : ""}${entry}` }, annotations: Transaction.addToHistory.of(false) });
    pane.programmaticChange = false;
    cachePaneEditorState(pane);
  }
  dirtyTabIds.delete(saved.id);
  renderSidebar();
  updateStatus();
}

async function mutateRemoteInbox(operation: "replace" | "clear", targetTabName: string, contentValue: string, expectedRevision: number): Promise<{ ok: true; tabId: string; content: string; revision: number; updatedAt: string; beforeCharacters: number } | { ok: false; error: string; conflict?: boolean; tabId?: string; revision?: number; updatedAt?: string }> {
  if (!bootstrapReadyForClose || workspaceImportedNeedsRestart || workspaceImportInProgress) {
    return { ok: false, error: bootstrapReadyForClose ? "Workspace restart required" : "Workspace is still loading" };
  }
  const title = targetTabName.trim();
  const matches = remoteTargetMatches(title);
  if (matches.length > 1) {
    return { ok: false, error: duplicateRemoteTargetError(title) };
  }
  const meta: TabMeta | undefined = matches[0];
  let tab: TabDocument;
  if (meta) {
    tab = await loadTabToCache(meta.id);
  } else {
    if (expectedRevision !== 0) return { ok: false, error: "Revision conflict", conflict: true, revision: 0, updatedAt: new Date(0).toISOString() };
    const id = nextTabId();
    const updatedAt = nowIso();
    tab = ensureTab({ id, title, content: "", activeChildTabId: MAIN_CHILD_TAB_ID, childTabs: [{ id: MAIN_CHILD_TAB_ID, title: localizedMainChildTitle(), content: "", updatedAt }], updatedAt, revision: 0 });
    contentCache.set(id, tab);
    updateMetaFromDocument(tab);
    tabIndex = normalizeTabsIndex({ ...tabIndex, tabs: tabIndex.tabs.map((entry) => entry.id === id ? { ...entry, pinned: true } : entry) });
    tabIndex = insertTabIntoIndexGroup(tabIndex, id, null);
    await saveTabsIndex();
    workspace.openedTabIds = workspace.openedTabIds.includes(id) ? workspace.openedTabIds : [...workspace.openedTabIds, id];
    workspace.recentTabIds = [id, ...workspace.recentTabIds.filter((tabId) => tabId !== id)];
    await saveWorkspace();
  }
  const currentRevision = tab.revision ?? 0;
  if (currentRevision !== expectedRevision) return { ok: false, error: "Revision conflict", conflict: true, tabId: tab.id, revision: currentRevision, updatedAt: tab.updatedAt };
  const nextContent = operation === "clear" ? "" : contentValue;
  const beforeCharacters = getMainChildTab(tab).content.length;
  const updated = setChildContent(tab, MAIN_CHILD_TAB_ID, nextContent);
  updated.revision = currentRevision + 1;
  updated.updatedAt = nowIso();
  const saved = ensureTab(await window.textEditor.saveTab(updated));
  contentCache.set(saved.id, saved);
  updateMetaFromDocument(saved);
  dirtyTabIds.delete(saved.id);
  for (const pane of Object.values(panes) as EditorPaneState[]) {
    if (pane.activeTabId === saved.id && pane.activeChildTabId === MAIN_CHILD_TAB_ID) setPaneEditorContent(pane, nextContent);
  }
  renderSidebar();
  updateStatus();
  return { ok: true, tabId: saved.id, content: nextContent, revision: saved.revision ?? updated.revision, updatedAt: saved.updatedAt, beforeCharacters };
}

async function clearRemoteInboxTab(id: string): Promise<void> {
  if (!isRemoteInboxTabId(id)) return;
  const tab = await loadTabToCache(id);
  if (remoteTargetMatches(tab.title).length > 1) {
    throw new Error(duplicateRemoteTargetError(tab.title));
  }
  const confirmed = window.confirm(workspace.locale === "jp" ? "Remote Inboxの内容をすべて削除します。\nこの操作は元に戻せません。" : "Delete all Remote Inbox content.\nThis action cannot be undone.");
  if (!confirmed) return;
  const result = await enqueueRemoteOperation(tab.title, () => mutateRemoteInbox("clear", tab.title, "", tab.revision ?? 0));
  if (!result.ok) throw new Error(result.error);
  await window.textEditor.auditRemoteInboxPcClear({ tabId: result.tabId, targetTabName: tab.title, revision: result.revision, beforeCharacters: result.beforeCharacters });
}

window.textEditor.onRemoteInboxAppend(async (request) =>
  enqueueRemoteOperation(request.targetTabName, () => appendRemoteInbox(request.text, request.includeTimestamp, request.targetTabName))
);
window.textEditor.onRemoteInboxMutate(async (request) =>
  enqueueRemoteOperation(request.targetTabName, () => mutateRemoteInbox(request.operation, request.targetTabName, request.content, request.revision))
);

function hydratePaneFromCache(pane: EditorPaneState): void {
  const tab = pane.activeTabId ? contentCache.get(pane.activeTabId) : null;
  if (!tab) {
    setPaneEditorContent(pane, "");
    setPaneEditorEnabled(pane, false);
    return;
  }
  setPaneEditorContent(pane, childTabForPane(tab, pane).content);
  setPaneEditorEnabled(pane, true);
}

function finishBootstrap(focusNewTitle = false): void {
  bootstrapReadyForClose = true;
  try {
    (Object.values(panes) as EditorPaneState[]).forEach(hydratePaneFromCache);
    updateStatus();
    document.body.dataset.appReady = "true";
  } catch (error) {
    bootstrapReadyForClose = false;
    document.body.dataset.appReady = "error";
    (Object.values(panes) as EditorPaneState[]).forEach((pane) => {
      pane.view?.dispatch({ effects: pane.readOnlyCompartment.reconfigure(editorReadOnlyExtensions(pane)) });
    });
    throw error;
  }
  if (focusNewTitle) {
    focusTitleForPane(activePaneId, true);
  }
}

async function bootstrap(): Promise<void> {
  let completed = false;
  let focusNewTitle = false;
  let restoreNovelViewer = true;
  try {
    createEditor(panes.left);
    createEditor(panes.right);
    setupSidebarResize();
    setupSplitResize();
    setupNovelViewerLayoutObservers();
    const snapshot = await window.textEditor.loadApp();
    workspace = snapshot.workspace;
    tabIndex = normalizeTabsIndex(snapshot.tabIndex);
    appStateLoaded = true;
    shell.dataset.theme = workspace.theme;
    document.body.dataset.theme = workspace.theme;
    applyLocale();

  if (snapshot.recovery?.abnormalShutdown) {
    const choice = await recoveryDialog();
    if (choice === "cancel") {
      await window.textEditor.quitApp();
      return;
    }
    await window.textEditor.acknowledgeRecovery(choice === "restore");
    restoreNovelViewer = choice === "restore";
    if (choice === "skip") {
      clearRestoredWorkspaceViewState();
      await saveWorkspace();
    }
  }

  applySidebarWidth();
  activePaneId = workspace.layout.activePaneId === "right" && workspace.layout.splitMode === "vertical" ? "right" : "left";
  const savedLeftPane = workspace.layout.panes.find((pane) => pane.id === "left");
  const savedRightPane = workspace.layout.panes.find((pane) => pane.id === "right");
  panes.left.activeTabId = savedLeftPane?.activeTabId ?? workspace.activeTabId;
  panes.left.activeChildTabId = savedLeftPane?.activeChildTabId ?? MAIN_CHILD_TAB_ID;
  panes.right.activeTabId = savedRightPane?.activeTabId ?? null;
  panes.right.activeChildTabId = savedRightPane?.activeChildTabId ?? MAIN_CHILD_TAB_ID;
  syncActiveTabId();
  applyEditorLayout();
  const novelViewerStartup = await window.textEditor.initializeNovelViewer(restoreNovelViewer);
  renderNovelViewerStatus(novelViewerStartup.status);
  if (novelViewerStartup.shouldRestore) {
    await openNovelViewer();
  }
  startBackupTimer();
  (Object.values(panes) as EditorPaneState[]).forEach((pane) => {
    pane.view?.dispatch({
      effects: pane.themeCompartment.reconfigure(editorTheme())
    });
  });

    if (tabIndex.tabs.length === 0) {
      await createNewTab();
      focusNewTitle = true;
      completed = true;
      return;
    }

  workspace.openedTabIds = workspace.openedTabIds.filter((id) => tabIndex.tabs.some((tab) => tab.id === id));
  workspace.recentTabIds = workspace.recentTabIds.filter((id) => tabIndex.tabs.some((tab) => tab.id === id));
  const initialLeftTabId =
    panes.left.activeTabId && workspace.openedTabIds.includes(panes.left.activeTabId)
      ? panes.left.activeTabId
      : workspace.openedTabIds[0] ?? null;
  const initialRightTabId =
    workspace.layout.splitMode === "vertical" && panes.right.activeTabId && workspace.openedTabIds.includes(panes.right.activeTabId)
      ? panes.right.activeTabId
      : null;

  renderSidebar();
  if (initialLeftTabId) {
    setActivePane("left");
    await activateTab(initialLeftTabId, { childTabId: panes.left.activeChildTabId });
    if (initialRightTabId) {
      setActivePane("right");
      await activateTab(initialRightTabId, { childTabId: panes.right.activeChildTabId });
    }
    setActivePane(workspace.layout.activePaneId === "right" && workspace.layout.splitMode === "vertical" ? "right" : "left");
  } else {
    setPaneEditorContent(panes.left, "");
    setPaneEditorEnabled(panes.left, false);
    setPaneEditorContent(panes.right, "");
    setPaneEditorEnabled(panes.right, false);
    updateStatus();
  }
    setSaveState(text().saved);
    completed = true;
  } finally {
    if (completed) {
      finishBootstrap(focusNewTitle);
    }
  }
}

void bootstrap().catch((error) => {
  console.error(error);
  document.body.dataset.appReady = "error";
  setSaveState(`${text().startupFailed}: ${errorMessage(error)}`, "error");
});
