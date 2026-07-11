export type ThemeMode = "dark" | "light";
export type Locale = "en" | "jp";
export type PaneId = "left" | "right";
export type SplitMode = "single" | "vertical";
export type NewTabTemplateId = "simple" | "novel" | "reference" | "custom";

export interface WorkspaceTemplates {
  custom: string[];
}

export interface RemoteInboxSettings {
  enabled: boolean;
  port: number;
  targetTabName: string;
  targetTabNames: string[];
  remoteReadableTabIds: string[];
  includeTimestamp: boolean;
  notifyOnReceive: boolean;
  accessTeamDomain: string;
  accessAudience: string;
  allowedEmail: string;
}

export interface WorkspacePaneState {
  id: PaneId;
  activeTabId: string | null;
  activeChildTabId?: string | null;
}

export interface WorkspaceLayout {
  splitMode: SplitMode;
  activePaneId: PaneId;
  panes: WorkspacePaneState[];
  splitRatio: number;
}

export interface WorkspaceState {
  activeTabId: string | null;
  openedTabIds: string[];
  recentTabIds: string[];
  expandedIds: string[];
  theme: ThemeMode;
  locale: Locale;
  fontSize: number;
  sidebarWidth: number;
  autoContinueLists: boolean;
  newTabTemplate: NewTabTemplateId;
  templates: WorkspaceTemplates;
  layout: WorkspaceLayout;
  remoteInbox: RemoteInboxSettings;
}

export interface TabMeta {
  id: string;
  title: string;
  updatedAt: string;
  wordCount: number;
  pinned?: boolean;
}

export interface TabsIndex {
  groups?: TabGroup[];
  ungroupedTabIds?: string[];
  tabs: TabMeta[];
}

export interface TabGroup {
  id: string;
  title: string;
  tabIds: string[];
  collapsed: boolean;
  updatedAt: string;
}

export interface ChildTabDocument {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
}

export interface TabDocument {
  id: string;
  title: string;
  content: string;
  activeChildTabId?: string;
  childTabs?: ChildTabDocument[];
  updatedAt: string;
  revision?: number;
}

export interface AppStateSnapshot {
  workspace: WorkspaceState;
  tabIndex: TabsIndex;
  dataRoot: string;
  recovery: RecoveryState;
}

export interface BackupMeta {
  tabId?: string;
  fileName: string;
  createdAt: string;
  title: string;
  wordCount: number;
  size?: number;
  preview?: string;
  readable?: boolean;
  error?: string;
}

export interface RecoveryState {
  abnormalShutdown: boolean;
  startedAt?: string;
  lastShutdownAt?: string;
}

export interface GlobalSearchResult {
  tabId: string;
  title: string;
  groupTitle?: string;
  childTabId?: string;
  childTitle?: string;
  field: "title" | "content";
  lineNumber: number | null;
  preview: string;
  matchStart: number;
  matchEnd: number;
}

export interface WorkspaceTransferResult {
  canceled: boolean;
  filePath?: string;
  backupPath?: string;
}

export interface ImportedTextFile {
  filePath: string;
  fileName: string;
  title: string;
  content: string;
  encoding: "utf-8" | "shift_jis";
}

export interface ImportTextResult {
  canceled: boolean;
  files: ImportedTextFile[];
}

export interface WorkspaceArchiveVersion {
  appVersion: string;
  workspaceVersion: number;
  createdAt: string;
}

export const MAIN_CHILD_TAB_ID = "main";
export const MAIN_CHILD_TAB_TITLE = "本文";
export const UNGROUPED_GROUP_ID = "ungrouped";

export const defaultWorkspace: WorkspaceState = {
  activeTabId: null,
  openedTabIds: [],
  recentTabIds: [],
  expandedIds: ["opened"],
  theme: "dark",
  locale: "en",
  fontSize: 15,
  sidebarWidth: 248,
  autoContinueLists: true,
  newTabTemplate: "simple",
  templates: {
    custom: [MAIN_CHILD_TAB_TITLE]
  },
  remoteInbox: {
    enabled: false,
    port: 48731,
    targetTabName: "Remote Inbox",
    targetTabNames: ["Remote Inbox"],
    remoteReadableTabIds: [],
    includeTimestamp: true,
    notifyOnReceive: true,
    accessTeamDomain: "",
    accessAudience: "",
    allowedEmail: ""
  },
  layout: {
    splitMode: "single",
    activePaneId: "left",
    panes: [
      {
        id: "left",
        activeTabId: null,
        activeChildTabId: MAIN_CHILD_TAB_ID
      },
      {
        id: "right",
        activeTabId: null,
        activeChildTabId: MAIN_CHILD_TAB_ID
      }
    ],
    splitRatio: 0.5
  }
};

export const emptyTabsIndex: TabsIndex = {
  groups: [],
  ungroupedTabIds: [],
  tabs: []
};

export function countWords(content: string): number {
  const latinWords = content.match(/[A-Za-z0-9_]+/g)?.length ?? 0;
  const japaneseChars = content.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  return latinWords + japaneseChars;
}

export function normalizeTabsIndex(input: Partial<TabsIndex>): TabsIndex {
  const tabs = (Array.isArray(input.tabs) ? input.tabs : [])
    .filter((tab) => tab && typeof tab.id === "string")
    .map((tab, index) => ({
      id: tab.id.trim() || `tab-${String(index + 1).padStart(3, "0")}`,
      title: tab.title?.trim() || "Untitled",
      updatedAt: typeof tab.updatedAt === "string" ? tab.updatedAt : new Date().toISOString(),
      wordCount: typeof tab.wordCount === "number" ? tab.wordCount : 0,
      pinned: Boolean(tab.pinned)
    }));
  const validTabIds = new Set(tabs.map((tab) => tab.id));
  const usedTabIds = new Set<string>();
  const usedGroupIds = new Set<string>();
  const now = new Date().toISOString();

  const groups: TabGroup[] = Array.isArray(input.groups)
    ? input.groups
        .filter((group) => group && typeof group.id === "string")
        .map((group, index) => {
          const trimmedId = group.id.trim() || `group-${String(index + 1).padStart(3, "0")}`;
          const id = usedGroupIds.has(trimmedId) ? `${trimmedId}-${index + 1}` : trimmedId;
          usedGroupIds.add(id);
          const tabIds = (Array.isArray(group.tabIds) ? group.tabIds : []).filter((tabId) => {
            if (!validTabIds.has(tabId) || usedTabIds.has(tabId)) {
              return false;
            }
            usedTabIds.add(tabId);
            return true;
          });
          return {
            id,
            title: group.title?.trim() || "New Group",
            tabIds,
            collapsed: Boolean(group.collapsed),
            updatedAt: typeof group.updatedAt === "string" ? group.updatedAt : now
          };
        })
    : [];

  const ungroupedTabIds: string[] = [];
  const sourceUngrouped = Array.isArray(input.ungroupedTabIds) ? input.ungroupedTabIds : tabs.map((tab) => tab.id);
  sourceUngrouped.forEach((tabId) => {
    if (validTabIds.has(tabId) && !usedTabIds.has(tabId)) {
      usedTabIds.add(tabId);
      ungroupedTabIds.push(tabId);
    }
  });

  tabs.forEach((tab) => {
    if (!usedTabIds.has(tab.id)) {
      usedTabIds.add(tab.id);
      ungroupedTabIds.push(tab.id);
    }
  });

  return {
    groups,
    ungroupedTabIds,
    tabs
  };
}

export function groupTitleForTab(index: TabsIndex, tabId: string, ungroupedTitle = "Ungrouped"): string {
  const normalized = normalizeTabsIndex(index);
  const group = normalized.groups?.find((entry) => entry.tabIds.includes(tabId));
  return group?.title ?? ungroupedTitle;
}

export function normalizeTabDocument(input: TabDocument): TabDocument {
  const updatedAt = typeof input.updatedAt === "string" ? input.updatedAt : new Date().toISOString();
  const legacyContent = typeof input.content === "string" ? input.content : "";
  const seenIds = new Set<string>();
  const rawChildren = Array.isArray(input.childTabs) ? input.childTabs : [];
  const children: ChildTabDocument[] = rawChildren
    .filter((child) => child && typeof child.id === "string")
    .map((child) => {
      const id = child.id.trim() || `child-${seenIds.size + 1}`;
      const uniqueId = seenIds.has(id) ? `${id}-${seenIds.size + 1}` : id;
      seenIds.add(uniqueId);
      return {
        id: uniqueId,
        title: child.title?.trim() || (uniqueId === MAIN_CHILD_TAB_ID ? MAIN_CHILD_TAB_TITLE : "Untitled"),
        content: typeof child.content === "string" ? child.content : "",
        updatedAt: typeof child.updatedAt === "string" ? child.updatedAt : updatedAt
      };
    });

  const mainIndex = children.findIndex((child) => child.id === MAIN_CHILD_TAB_ID);
  if (mainIndex === -1) {
    children.unshift({
      id: MAIN_CHILD_TAB_ID,
      title: MAIN_CHILD_TAB_TITLE,
      content: legacyContent,
      updatedAt
    });
  } else {
    children[mainIndex] = {
      ...children[mainIndex],
      title: children[mainIndex].title.trim() || MAIN_CHILD_TAB_TITLE,
      content: children[mainIndex].content
    };
    if (mainIndex > 0) {
      const [main] = children.splice(mainIndex, 1);
      children.unshift(main);
    }
  }

  const activeChildTabId =
    typeof input.activeChildTabId === "string" && children.some((child) => child.id === input.activeChildTabId)
      ? input.activeChildTabId
      : MAIN_CHILD_TAB_ID;
  const mainChild = children.find((child) => child.id === MAIN_CHILD_TAB_ID) ?? children[0];

  return {
    id: input.id,
    title: input.title?.trim() || "Untitled",
    content: mainChild.content,
    activeChildTabId,
    childTabs: children,
    updatedAt,
    revision: Number.isInteger(input.revision) && (input.revision ?? 0) >= 0 ? input.revision : 0
  };
}

export function getChildTabs(tab: TabDocument): ChildTabDocument[] {
  return normalizeTabDocument(tab).childTabs ?? [];
}

export function getMainChildTab(tab: TabDocument): ChildTabDocument {
  return getChildTabs(tab).find((child) => child.id === MAIN_CHILD_TAB_ID) ?? {
    id: MAIN_CHILD_TAB_ID,
    title: MAIN_CHILD_TAB_TITLE,
    content: tab.content,
    updatedAt: tab.updatedAt
  };
}

export function getActiveChildTab(tab: TabDocument, childTabId?: string | null): ChildTabDocument {
  const normalized = normalizeTabDocument(tab);
  const children = normalized.childTabs ?? [];
  return children.find((child) => child.id === childTabId) ?? children.find((child) => child.id === normalized.activeChildTabId) ?? children[0];
}
