import { test, expect, type TestInfo } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import electronPath from "electron";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type TabDocument = {
  id: string;
  title: string;
  content: string;
  activeChildTabId?: string;
  childTabs?: Array<{ id: string; title: string; content: string; updatedAt: string }>;
  updatedAt: string;
};

type TabsIndex = {
  groups?: Array<{ id: string; title: string; tabIds: string[]; collapsed: boolean; updatedAt: string }>;
  ungroupedTabIds?: string[];
  tabs: Array<{ id: string; title: string; updatedAt: string; wordCount: number; pinned?: boolean }>;
};

const appRoot = path.resolve(__dirname, "..");

async function launchTextEditor(
  testInfo: TestInfo,
  options: { clean?: boolean; userDataDir?: string; exportAllPath?: string; workspaceExportPath?: string; workspaceImportPath?: string } = {}
) {
  const userDataDir = options.userDataDir ?? path.join(testInfo.outputDir, "user-data");
  if (options.clean !== false) {
    await rm(userDataDir, { recursive: true, force: true });
  }
  await mkdir(userDataDir, { recursive: true });

  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [appRoot],
    env: {
      ...process.env,
      TEXTEDITOR_USER_DATA: userDataDir,
      ...(options.exportAllPath ? { TEXTEDITOR_EXPORT_ALL_PATH: options.exportAllPath } : {}),
      ...(options.workspaceExportPath ? { TEXTEDITOR_WORKSPACE_EXPORT_PATH: options.workspaceExportPath } : {}),
      ...(options.workspaceImportPath ? { TEXTEDITOR_WORKSPACE_IMPORT_PATH: options.workspaceImportPath } : {})
    }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator("#active-title-input")).toBeVisible();
  await expect(page.locator("#save-state")).not.toContainText("Startup failed");

  return { app, page, userDataDir, dataDir: path.join(userDataDir, "data") };
}

async function closeApp(app: ElectronApplication) {
  await app.close().catch(() => undefined);
}

async function activeTabId(page: Page): Promise<string> {
  const meta = await page.locator("#active-meta").innerText();
  const match = /^tab-[A-Za-z0-9_-]+/.exec(meta);
  if (!match) {
    throw new Error(`Active tab id not found in meta: ${meta}`);
  }
  return match[0];
}

async function readTab(dataDir: string, id: string): Promise<TabDocument> {
  return JSON.parse(await readFile(path.join(dataDir, "tabs", `${id}.json`), "utf8")) as TabDocument;
}

async function readWorkspace(dataDir: string) {
  return JSON.parse(await readFile(path.join(dataDir, "workspace.json"), "utf8")) as Record<string, unknown>;
}

async function readIndex(dataDir: string): Promise<TabsIndex> {
  return JSON.parse(await readFile(path.join(dataDir, "tabs", "index.json"), "utf8")) as TabsIndex;
}

async function focusEditor(page: Page) {
  await page.locator("#left-editor-host .cm-content").click();
}

async function replaceEditorText(page: Page, text: string) {
  await focusEditor(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.insertText(text);
}

async function waitForSavedTab(dataDir: string, id: string, expectedContent: string) {
  await expect.poll(async () => (await readTab(dataDir, id)).content).toBe(expectedContent);
}

async function pressShortcut(page: Page, shortcut: string) {
  await page.keyboard.press(process.platform === "darwin" ? shortcut.replace("Control", "Meta") : shortcut);
}

async function editorText(page: Page, pane: "left" | "right" = "left") {
  return page.locator(`#${pane}-editor-host .cm-content`).textContent();
}

async function createGroupFromSidebarBlank(page: Page) {
  const box = await page.locator("#sidebar").boundingBox();
  if (!box) {
    throw new Error("Sidebar was not rendered");
  }
  await page.mouse.click(box.x + 20, box.y + box.height - 20, { button: "right" });
  await page.getByRole("button", { name: "New Group" }).click();
}

test.describe("Text Editor Electron MVP", () => {
  test.describe("undo and redo history", () => {
    test("undoes and redoes basic input", async ({}, testInfo) => {
      const { app, page } = await launchTextEditor(testInfo);
      try {
        await replaceEditorText(page, "abc");
        await pressShortcut(page, "Control+Z");
        await expect.poll(() => editorText(page)).toBe("");
        await pressShortcut(page, "Control+Y");
        await expect.poll(() => editorText(page)).toBe("abc");
      } finally {
        await closeApp(app);
      }
    });

    test("keeps undo history isolated when switching tabs", async ({}, testInfo) => {
      const { app, page, dataDir } = await launchTextEditor(testInfo);
      try {
        const firstId = await activeTabId(page);
        await page.locator("#active-title-input").fill("Tab A");
        await page.locator("#active-title-input").press("Enter");
        await replaceEditorText(page, "alpha");
        await waitForSavedTab(dataDir, firstId, "alpha");

        await pressShortcut(page, "Control+N");
        await expect(page.locator(".tab-row")).toHaveCount(2);
        await expect(page.locator("#active-title-input")).toHaveValue("Untitled");
        const secondId = await activeTabId(page);
        expect(secondId).not.toBe(firstId);
        await page.locator("#active-title-input").fill("Tab B");
        await page.locator("#active-title-input").press("Enter");
        await replaceEditorText(page, "beta");
        await waitForSavedTab(dataDir, secondId, "beta");

        await page.locator(`.tab-row[data-id="${firstId}"]`).click();
        await expect(page.locator("#active-title-input")).toHaveValue("Tab A");
        await expect(page.locator("#left-editor-host .cm-content")).toBeFocused();
        await pressShortcut(page, "Control+Z");
        await expect.poll(() => editorText(page)).toBe("");
        await expect.poll(async () => (await readTab(dataDir, secondId)).content).toBe("beta");

        await pressShortcut(page, "Control+Y");
        await expect.poll(() => editorText(page)).toBe("alpha");
      } finally {
        await closeApp(app);
      }
    });

    test("keeps undo available after autosave", async ({}, testInfo) => {
      const { app, page, dataDir } = await launchTextEditor(testInfo);
      try {
        const id = await activeTabId(page);
        await replaceEditorText(page, "autosaved text");
        await waitForSavedTab(dataDir, id, "autosaved text");
        await expect(page.locator("#save-state")).toContainText("Saved");
        await pressShortcut(page, "Control+Z");
        await expect.poll(() => editorText(page)).toBe("");
      } finally {
        await closeApp(app);
      }
    });

    test("undoes Japanese input as one edit", async ({}, testInfo) => {
      const { app, page } = await launchTextEditor(testInfo);
      try {
        await replaceEditorText(page, "日本語の文章");
        await pressShortcut(page, "Control+Z");
        await expect.poll(() => editorText(page)).toBe("");
        await pressShortcut(page, "Control+Y");
        await expect.poll(() => editorText(page)).toBe("日本語の文章");
      } finally {
        await closeApp(app);
      }
    });

    test("undoes a multiline paste as one edit", async ({}, testInfo) => {
      const { app, page } = await launchTextEditor(testInfo);
      try {
        await page.evaluate(async () => window.textEditor.writeClipboardText("first\nsecond\nthird"));
        await focusEditor(page);
        await pressShortcut(page, "Control+V");
        await expect(page.locator("#left-editor-host .cm-content")).toContainText("third");
        await pressShortcut(page, "Control+Z");
        await expect.poll(() => editorText(page)).toBe("");
      } finally {
        await closeApp(app);
      }
    });

    test("undoes and redoes replace all", async ({}, testInfo) => {
      const { app, page } = await launchTextEditor(testInfo);
      try {
        await replaceEditorText(page, "cat cat");
        await pressShortcut(page, "Control+H");
        const panel = page.locator(".cm-search");
        await panel.locator('input[name="search"]').fill("cat");
        await panel.locator('input[name="replace"]').fill("dog");
        await panel.getByRole("button", { name: /replace all/i }).click();
        await expect.poll(() => editorText(page)).toBe("dog dog");
        await page.keyboard.press("Escape");
        await pressShortcut(page, "Control+Z");
        await expect.poll(() => editorText(page)).toBe("cat cat");
        await pressShortcut(page, "Control+Y");
        await expect.poll(() => editorText(page)).toBe("dog dog");
      } finally {
        await closeApp(app);
      }
    });

    test("keeps child-tab history isolated", async ({}, testInfo) => {
      const { app, page } = await launchTextEditor(testInfo);
      try {
        await replaceEditorText(page, "main edit");
        await page.locator("#left-child-tab-bar .child-tab-add").click();
        await page.locator(".dialog-input").fill("Memo");
        await page.getByRole("button", { name: "OK" }).click();
        await replaceEditorText(page, "memo edit");

        await page.locator('#left-child-tab-bar [data-child-id="main"]').click();
        await focusEditor(page);
        await pressShortcut(page, "Control+Z");
        await expect.poll(() => editorText(page)).toBe("");

        await page.locator('#left-child-tab-bar [data-child-id="memo"]').click();
        await expect.poll(() => editorText(page)).toBe("memo edit");
      } finally {
        await closeApp(app);
      }
    });

    test("discards redo history after a new edit", async ({}, testInfo) => {
      const { app, page } = await launchTextEditor(testInfo);
      try {
        await replaceEditorText(page, "old");
        await pressShortcut(page, "Control+Z");
        await page.keyboard.insertText("new");
        await pressShortcut(page, "Control+Y");
        await expect.poll(() => editorText(page)).toBe("new");
      } finally {
        await closeApp(app);
      }
    });

    test("synchronizes split views through undo and redo", async ({}, testInfo) => {
      const { app, page } = await launchTextEditor(testInfo);
      try {
        await pressShortcut(page, "Control+\\");
        await expect(page.locator('section[data-pane-id="right"]')).toBeVisible();
        await pressShortcut(page, "Control+1");
        await replaceEditorText(page, "shared text");
        await expect.poll(() => editorText(page, "right")).toBe("shared text");

        await pressShortcut(page, "Control+Z");
        await expect.poll(() => editorText(page, "left")).toBe("");
        await expect.poll(() => editorText(page, "right")).toBe("");

        await pressShortcut(page, "Control+Y");
        await expect.poll(() => editorText(page, "left")).toBe("shared text");
        await expect.poll(() => editorText(page, "right")).toBe("shared text");
      } finally {
        await closeApp(app);
      }
    });

    test("does not expose initial document loading as undo history after restart", async ({}, testInfo) => {
      const first = await launchTextEditor(testInfo);
      try {
        const id = await activeTabId(first.page);
        await replaceEditorText(first.page, "persisted text");
        await waitForSavedTab(first.dataDir, id, "persisted text");
      } finally {
        await closeApp(first.app);
      }

      const relaunched = await launchTextEditor(testInfo, { clean: false, userDataDir: first.userDataDir });
      try {
        await expect.poll(() => editorText(relaunched.page)).toBe("persisted text");
        await pressShortcut(relaunched.page, "Control+Z");
        await expect.poll(() => editorText(relaunched.page)).toBe("persisted text");
      } finally {
        await closeApp(relaunched.app);
      }
    });
  });

  test("autosaves, renames from header, copies plain text, and persists sidebar width", async ({}, testInfo) => {
    const { app, page, userDataDir, dataDir } = await launchTextEditor(testInfo);
    try {
      await expect(page.locator(".tab-row")).toHaveCount(1);
      await expect(page.locator("#active-title-input")).toHaveValue("Untitled");

      const id = await activeTabId(page);
      const content = "第一行\nSecond line 123";
      await replaceEditorText(page, content);
      await waitForSavedTab(dataDir, id, content);

      await pressShortcut(page, "Control+F");
      await expect(page.locator(".cm-search")).toBeVisible();
      await pressShortcut(page, "F3");
      await pressShortcut(page, "Shift+F3");
      await pressShortcut(page, "Control+H");
      await expect(page.locator(".cm-search")).toBeVisible();
      await page.keyboard.press("Escape");

      await page.locator("#active-title-input").fill("第一話");
      await page.locator("#active-title-input").press("Enter");
      await expect(page.locator(".tab-row")).toContainText("第一話");
      await expect.poll(async () => (await readTab(dataDir, id)).title).toBe("第一話");

      await pressShortcut(page, "Control+Shift+C");
      await expect(page.locator("#save-state")).toContainText("Copied");

      const resizer = page.locator("#sidebar-resizer");
      const box = await resizer.boundingBox();
      if (!box) {
        throw new Error("Sidebar resizer was not rendered");
      }
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 72, box.y + box.height / 2);
      await page.mouse.up();

      await expect.poll(async () => Number((await readWorkspace(dataDir)).sidebarWidth)).toBeGreaterThan(248);
      const savedWidth = Number((await readWorkspace(dataDir)).sidebarWidth);

      await closeApp(app);
      const relaunched = await launchTextEditor(testInfo, { clean: false, userDataDir });
      try {
        const gridColumns = await relaunched.page.locator(".workspace").evaluate((element) => getComputedStyle(element).gridTemplateColumns);
        expect(parseFloat(gridColumns)).toBeCloseTo(savedWidth, 0);
        await expect(relaunched.page.locator("#active-title-input")).toHaveValue("第一話");
      } finally {
        await closeApp(relaunched.app);
      }
    } finally {
      await closeApp(app);
    }
  });

  test("opens recent tabs from File menu and uses tab context menu actions", async ({}, testInfo) => {
    const { app, page, dataDir } = await launchTextEditor(testInfo);
    try {
      await expect(page.locator(".tab-row")).toHaveCount(1);
      await pressShortcut(page, "Control+N");
      await expect(page.locator(".tab-row")).toHaveCount(2);
      await page.locator("#active-title-input").fill("Recent Target");
      await page.locator("#active-title-input").press("Enter");
      const id = await activeTabId(page);

      await page.locator(".tab-row", { hasText: "Recent Target" }).click({ button: "right" });
      await page.getByRole("button", { name: "Close" }).click();
      await expect(page.locator(".tab-row", { hasText: "Recent Target" })).toHaveCount(0);

      await pressShortcut(page, "Control+Shift+R");
      await page.locator(".list-row", { hasText: "Recent Target" }).click();
      await expect(page.locator(".tab-row", { hasText: "Recent Target" })).toHaveCount(1);

      await page.locator(".tab-row", { hasText: "Recent Target" }).click({ button: "right" });
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("button", { name: "Delete", exact: true }).click();

      await expect(page.locator(".tab-row", { hasText: "Recent Target" })).toHaveCount(0);
      await expect.poll(async () => {
        const index = JSON.parse(await readFile(path.join(dataDir, "tabs", "index.json"), "utf8")) as { tabs: Array<{ id: string }> };
        return index.tabs.some((tab) => tab.id === id);
      }).toBe(false);

      const backupFiles = await readdir(path.join(dataDir, "backups", id));
      expect(backupFiles.some((file) => file.endsWith(".json"))).toBe(true);
    } finally {
      await closeApp(app);
    }
  });

  test("switches between English and Japanese UI and restores the locale", async ({}, testInfo) => {
    const { app, page, userDataDir, dataDir } = await launchTextEditor(testInfo);
    try {
      await expect(page.locator(".pane-title")).toHaveText("Tabs");

      await pressShortcut(page, "Control+Shift+L");
      await expect(page.locator(".pane-title")).toHaveText("タブ");
      await expect(page.locator("#save-state")).toContainText("言語を切り替えました");

      await page.locator(".tab-row").first().click({ button: "right" });
      await expect(page.getByRole("button", { name: "名前変更" })).toBeVisible();
      await page.keyboard.press("Escape");

      await expect.poll(async () => (await readWorkspace(dataDir)).locale).toBe("jp");

      await closeApp(app);
      const relaunched = await launchTextEditor(testInfo, { clean: false, userDataDir });
      try {
        await expect(relaunched.page.locator(".pane-title")).toHaveText("タブ");
        await expect(relaunched.page.locator("#save-state")).toContainText("保存済み");
      } finally {
        await closeApp(relaunched.app);
      }
    } finally {
      await closeApp(app);
    }
  });

  test("reorders open tabs with drag and drop and restores the order", async ({}, testInfo) => {
    const { app, page, userDataDir, dataDir } = await launchTextEditor(testInfo);
    try {
      await page.locator("#active-title-input").fill("One");
      await page.locator("#active-title-input").press("Enter");

      await pressShortcut(page, "Control+N");
      await expect(page.locator(".tab-row")).toHaveCount(2);
      await page.locator("#active-title-input").fill("Two");
      await page.locator("#active-title-input").press("Enter");

      await pressShortcut(page, "Control+N");
      await expect(page.locator(".tab-row")).toHaveCount(3);
      await page.locator("#active-title-input").fill("Three");
      await page.locator("#active-title-input").press("Enter");

      await expect(page.locator(".tab-row")).toHaveCount(3);

      const source = page.locator(".tab-row", { hasText: "Three" });
      const target = page.locator(".tab-row", { hasText: "One" });
      await source.dragTo(target, {
        targetPosition: { x: 12, y: 4 }
      });

      await expect(page.locator(".tab-row").nth(0)).toContainText("Three");
      await expect(page.locator(".tab-row").nth(1)).toContainText("One");
      await expect(page.locator(".tab-row").nth(2)).toContainText("Two");

      const workspace = await readWorkspace(dataDir);
      const index = JSON.parse(await readFile(path.join(dataDir, "tabs", "index.json"), "utf8")) as {
        tabs: Array<{ id: string; title: string }>;
      };
      const titleById = new Map(index.tabs.map((tab) => [tab.id, tab.title]));
      expect((workspace.openedTabIds as string[]).map((id) => titleById.get(id))).toEqual(["Three", "One", "Two"]);

      await closeApp(app);
      const relaunched = await launchTextEditor(testInfo, { clean: false, userDataDir });
      try {
        await expect(relaunched.page.locator(".tab-row").nth(0)).toContainText("Three");
        await expect(relaunched.page.locator(".tab-row").nth(1)).toContainText("One");
        await expect(relaunched.page.locator(".tab-row").nth(2)).toContainText("Two");
      } finally {
        await closeApp(relaunched.app);
      }
    } finally {
      await closeApp(app);
    }
  });

  test("pins tabs ahead of regular tabs and duplicates as an unpinned copy", async ({}, testInfo) => {
    const { app, page, dataDir } = await launchTextEditor(testInfo);
    try {
      await page.locator("#active-title-input").fill("First");
      await page.locator("#active-title-input").press("Enter");

      await pressShortcut(page, "Control+N");
      await page.locator("#active-title-input").fill("Second");
      await page.locator("#active-title-input").press("Enter");
      const secondId = await activeTabId(page);

      await page.locator(".tab-row", { hasText: "Second" }).click({ button: "right" });
      await page.getByRole("button", { name: "Pin" }).click();
      await expect(page.locator(".tab-row").nth(0)).toContainText("Second");
      await expect.poll(async () => (await readIndex(dataDir)).tabs.find((tab) => tab.id === secondId)?.pinned).toBe(true);

      await page.locator(".tab-row", { hasText: "Second" }).first().click({ button: "right" });
      await page.getByRole("button", { name: "Duplicate" }).click();
      await expect(page.locator(".tab-row", { hasText: "Second - Copy" })).toHaveCount(1);
      await expect(page.locator(".tab-row").nth(0)).toContainText("Second");

      await expect.poll(async () => {
        const copy = (await readIndex(dataDir)).tabs.find((tab) => tab.title === "Second - Copy");
        return copy?.pinned ?? null;
      }).toBe(false);

      await page.locator(".tab-row", { hasText: "Second" }).first().click({ button: "right" });
      await page.getByRole("button", { name: "Unpin" }).click();
      await expect.poll(async () => (await readIndex(dataDir)).tabs.find((tab) => tab.id === secondId)?.pinned).toBe(false);
    } finally {
      await closeApp(app);
    }
  });

  test("shows editor status metrics and can disable list continuation from saved settings", async ({}, testInfo) => {
    const { app, page, userDataDir, dataDir } = await launchTextEditor(testInfo);
    try {
      const id = await activeTabId(page);
      await replaceEditorText(page, "abc\nxy");
      await expect(page.locator("#status-left")).toContainText("6 characters");
      await expect(page.locator("#status-left")).toContainText("Ln 2, Col 3");

      await pressShortcut(page, "Control+A");
      await expect(page.locator("#status-left")).toContainText("Selection 6 characters");

      await replaceEditorText(page, "- item");
      await page.keyboard.press("Enter");
      await waitForSavedTab(dataDir, id, "- item\n- ");

      await replaceEditorText(page, "- ");
      await page.keyboard.press("Enter");
      await waitForSavedTab(dataDir, id, "");

      await closeApp(app);
      const workspace = await readWorkspace(dataDir);
      await writeFile(path.join(dataDir, "workspace.json"), `${JSON.stringify({ ...workspace, autoContinueLists: false }, null, 2)}\n`, "utf8");

      const relaunched = await launchTextEditor(testInfo, { clean: false, userDataDir });
      try {
        const relaunchedId = await activeTabId(relaunched.page);
        await replaceEditorText(relaunched.page, "* item");
        await relaunched.page.keyboard.press("Enter");
        await waitForSavedTab(dataDir, relaunchedId, "* item\n");
      } finally {
        await closeApp(relaunched.app);
      }
    } finally {
      await closeApp(app);
    }
  });

  test("groups tabs, moves tabs and groups with drag and drop, and deletes groups safely", async ({}, testInfo) => {
    const { app, page, dataDir } = await launchTextEditor(testInfo);
    try {
      await page.locator("#active-title-input").fill("Ungrouped Tab");
      await page.locator("#active-title-input").press("Enter");
      const ungroupedId = await activeTabId(page);

      await pressShortcut(page, "Control+N");
      await page.locator("#active-title-input").fill("Grouped Tab");
      await page.locator("#active-title-input").press("Enter");
      const groupedId = await activeTabId(page);

      await createGroupFromSidebarBlank(page);
      await page.locator(".group-header", { hasText: "New Group" }).click({ button: "right" });
      await page.getByRole("button", { name: "Rename" }).click();
      await page.locator(".dialog-input").fill("第一章");
      await page.getByRole("button", { name: "OK" }).click();
      await expect(page.locator(".group-header", { hasText: "第一章" })).toBeVisible();

      await page.locator(`.tab-row[data-id="${groupedId}"]`).dragTo(page.locator(".group-header", { hasText: "第一章" }));
      await expect.poll(async () => {
        const index = await readIndex(dataDir);
        return index.groups?.find((group) => group.title === "第一章")?.tabIds.includes(groupedId);
      }).toBe(true);

      await page.locator(".group-header", { hasText: "第一章" }).click();
      await expect(page.locator(".group-section", { hasText: "第一章" }).locator(".tab-row", { hasText: "Grouped Tab" })).toHaveCount(0);
      await page.locator(".group-header", { hasText: "第一章" }).click();
      await expect(page.locator(".group-section", { hasText: "第一章" }).locator(".tab-row", { hasText: "Grouped Tab" })).toHaveCount(1);

      await createGroupFromSidebarBlank(page);
      await page.locator(".group-header", { hasText: "New Group" }).click({ button: "right" });
      await page.getByRole("button", { name: "Rename" }).click();
      await page.locator(".dialog-input").fill("第二章");
      await page.getByRole("button", { name: "OK" }).click();

      await page.locator(".group-header", { hasText: "第二章" }).dragTo(page.locator(".group-header", { hasText: "第一章" }), {
        targetPosition: { x: 12, y: 4 }
      });
      await expect.poll(async () => {
        const index = await readIndex(dataDir);
        return index.groups?.map((group) => `${group.title}:${group.collapsed ? "closed" : "open"}`).join("|");
      }).toBe("第二章:closed|第一章:open");

      await page.locator(`.tab-row[data-id="${groupedId}"]`).dragTo(page.locator(".group-header", { hasText: "Ungrouped" }));
      await expect.poll(async () => {
        const index = await readIndex(dataDir);
        return index.ungroupedTabIds?.includes(groupedId);
      }).toBe(true);

      await page.locator(".group-header", { hasText: "第一章" }).click({ button: "right" });
      await page.getByRole("button", { name: "Delete Group" }).click();
      await page.getByRole("button", { name: "Delete Group" }).click();
      await expect.poll(async () => {
        const index = await readIndex(dataDir);
        return {
          hasGroup: Boolean(index.groups?.some((group) => group.title === "第一章")),
          ungrouped: index.ungroupedTabIds ?? []
        };
      }).toEqual({ hasGroup: false, ungrouped: expect.arrayContaining([ungroupedId, groupedId]) });
    } finally {
      await closeApp(app);
    }
  });

  test("lists backup history and restores a backup as a new tab", async ({}, testInfo) => {
    const { app, page, dataDir } = await launchTextEditor(testInfo);
    try {
      const id = await activeTabId(page);
      await page.locator("#active-title-input").fill("Backup Target");
      await page.locator("#active-title-input").press("Enter");
      await replaceEditorText(page, "original content");
      await waitForSavedTab(dataDir, id, "original content");

      await page.evaluate(async (tabId) => {
        await window.textEditor.createBackup({
          id: tabId,
          title: "Backup Target",
          content: "original content",
          updatedAt: new Date().toISOString()
        });
      }, id);

      await replaceEditorText(page, "changed content");
      await waitForSavedTab(dataDir, id, "changed content");

      await pressShortcut(page, "Control+Shift+B");
      await expect(page.locator(".backup-history-row", { hasText: "Backup Target" })).toBeVisible();
      await expect(page.locator(".backup-history-row", { hasText: "original content" })).toBeVisible();
      await page.locator(".backup-history-row", { hasText: "Backup Target" }).getByRole("button", { name: "Restore as New Tab" }).click();
      await page.locator("form").getByRole("button", { name: "Restore as New Tab" }).click();

      await expect.poll(async () => (await readTab(dataDir, id)).content).toBe("changed content");
      await expect(page.locator("#active-title-input")).toHaveValue("Backup Target - Restored");
      await expect(page.locator("#left-editor-host .cm-content")).toContainText("original content");
      await expect.poll(async () => (await readIndex(dataDir)).tabs.some((tab) => tab.title === "Backup Target - Restored")).toBe(true);
    } finally {
      await closeApp(app);
    }
  });

  test("asks before restoring after an abnormal shutdown marker", async ({}, testInfo) => {
    const first = await launchTextEditor(testInfo);
    try {
      await first.page.locator("#active-title-input").fill("Crash Tab");
      await first.page.locator("#active-title-input").press("Enter");
      await replaceEditorText(first.page, "draft before crash");
      await waitForSavedTab(first.dataDir, await activeTabId(first.page), "draft before crash");
    } finally {
      await closeApp(first.app);
    }

    await writeFile(
      path.join(first.dataDir, "session.json"),
      `${JSON.stringify({ abnormalShutdown: true, startedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8"
    );

    const restored = await launchTextEditor(testInfo, { clean: false, userDataDir: first.userDataDir });
    try {
      await expect(restored.page.getByText("The app did not shut down normally last time.")).toBeVisible();
      await restored.page.getByRole("button", { name: "Restore" }).click();
      await expect(restored.page.locator("#active-title-input")).toHaveValue("Crash Tab");
      await expect(restored.page.locator("#left-editor-host .cm-content")).toContainText("draft before crash");
    } finally {
      await closeApp(restored.app);
    }

    await writeFile(
      path.join(first.dataDir, "session.json"),
      `${JSON.stringify({ abnormalShutdown: true, startedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8"
    );

    const skipped = await launchTextEditor(testInfo, { clean: false, userDataDir: first.userDataDir });
    try {
      await skipped.page.getByRole("button", { name: "Start without restoring" }).click();
      await expect(skipped.page.locator("#active-title-input")).toHaveValue("No open tab");
      await expect.poll(async () => (await readTab(first.dataDir, (await readIndex(first.dataDir)).tabs[0].id)).content).toBe("draft before crash");
    } finally {
      await closeApp(skipped.app);
    }
  });

  test("exports all tabs to one txt file in tab index order", async ({}, testInfo) => {
    const outputPath = path.join(testInfo.outputDir, "all-tabs.txt");
    const { app, page, dataDir } = await launchTextEditor(testInfo, { exportAllPath: outputPath });
    try {
      await page.locator("#active-title-input").fill("One");
      await page.locator("#active-title-input").press("Enter");
      await replaceEditorText(page, "alpha");

      await pressShortcut(page, "Control+N");
      await page.locator("#active-title-input").fill("Two");
      await page.locator("#active-title-input").press("Enter");
      const secondId = await activeTabId(page);
      await replaceEditorText(page, "beta");
      await waitForSavedTab(dataDir, secondId, "beta");

      await page.evaluate(async () => {
        await window.textEditor.exportAllTxt();
      });
      await expect.poll(async () => await readFile(outputPath, "utf8")).toBe("# One\n\nalpha\n\n# Two\n\nbeta");
    } finally {
      await closeApp(app);
    }
  });

  test("creates, edits, renames, deletes child tabs, and preserves main content", async ({}, testInfo) => {
    const { app, page, dataDir } = await launchTextEditor(testInfo);
    try {
      const id = await activeTabId(page);
      await expect(page.locator("#left-child-tab-bar .child-tab-button")).toContainText(["Text"]);

      await page.locator("#left-child-tab-bar .child-tab-add").click();
      await page.locator(".dialog-input").fill("Memo");
      await page.getByRole("button", { name: "OK" }).click();
      await page.locator("#left-child-tab-bar .child-tab-add").click();
      await page.locator(".dialog-input").fill("Plot");
      await page.getByRole("button", { name: "OK" }).click();
      await expect(page.locator("#left-child-tab-bar .child-tab-button")).toContainText(["Text", "Memo", "Plot"]);

      await page.locator('#left-child-tab-bar [data-child-id="main"]').click();
      await replaceEditorText(page, "main body");
      await waitForSavedTab(dataDir, id, "main body");

      await page.locator('#left-child-tab-bar [data-child-id="memo"]').click();
      await replaceEditorText(page, "memo body");
      await expect.poll(async () => (await readTab(dataDir, id)).childTabs?.find((child) => child.id === "memo")?.content).toBe("memo body");
      await expect.poll(async () => (await readTab(dataDir, id)).content).toBe("main body");

      await page.locator('#left-child-tab-bar [data-child-id="memo"]').click({ button: "right" });
      await page.getByRole("button", { name: "Rename" }).click();
      await page.locator(".dialog-input").fill("Notes");
      await page.getByRole("button", { name: "OK" }).click();
      await expect(page.getByRole("button", { name: "Notes" })).toBeVisible();
      await expect.poll(async () => (await readTab(dataDir, id)).childTabs?.some((child) => child.title === "Notes")).toBe(true);

      await page.locator('#left-child-tab-bar [data-child-id="main"]').click();
      await expect(page.locator("#left-editor-host .cm-content")).toContainText("main body");

      await page.locator('#left-child-tab-bar [data-child-id="plot"]').click({ button: "right" });
      await page.getByRole("button", { name: "Delete" }).click();
      await page.getByRole("button", { name: "Delete" }).click();
      await expect(page.getByRole("button", { name: "Plot" })).toHaveCount(0);
      await expect.poll(async () => (await readTab(dataDir, id)).childTabs?.some((child) => child.id === "plot")).toBe(false);
    } finally {
      await closeApp(app);
    }
  });

  test("searches across all tabs and jumps to a result", async ({}, testInfo) => {
    const { app, page, dataDir } = await launchTextEditor(testInfo);
    try {
      await page.locator("#active-title-input").fill("第一話");
      await page.locator("#active-title-input").press("Enter");
      await replaceEditorText(page, "静かな村\n魔王が現れた\n続き");

      await pressShortcut(page, "Control+N");
      await page.locator("#active-title-input").fill("設定");
      await page.locator("#active-title-input").press("Enter");
      const secondId = await activeTabId(page);
      await replaceEditorText(page, "魔王城\n城下町");
      await waitForSavedTab(dataDir, secondId, "魔王城\n城下町");

      await pressShortcut(page, "Control+Shift+F");
      await page.locator("#global-search-input").fill("魔王");
      await expect(page.locator(".search-result-row")).toHaveCount(2);

      await page.locator(".search-result-group", { hasText: "第一話" }).locator(".search-result-row").first().click();
      await expect(page.locator("#active-title-input")).toHaveValue("第一話");
      await expect(page.locator("#left-editor-host .cm-content")).toContainText("魔王が現れた");
    } finally {
      await closeApp(app);
    }
  });

  test("splits editors, opens different tabs, resizes, and restores layout", async ({}, testInfo) => {
    const { app, page, userDataDir, dataDir } = await launchTextEditor(testInfo);
    try {
      await page.locator("#active-title-input").fill("Left Story");
      await page.locator("#active-title-input").press("Enter");
      await replaceEditorText(page, "left text");

      await pressShortcut(page, "Control+N");
      await page.locator("#active-title-input").fill("Right Notes");
      await page.locator("#active-title-input").press("Enter");
      const rightId = await activeTabId(page);
      await replaceEditorText(page, "right text");
      await waitForSavedTab(dataDir, rightId, "right text");

      await pressShortcut(page, "Control+\\");
      await expect(page.locator('section[data-pane-id="right"]')).toBeVisible();
      await expect(page.locator("#right-pane-title")).toHaveText("Right Notes > Text");

      await pressShortcut(page, "Control+1");
      await page.locator(".tab-row", { hasText: "Left Story" }).click();
      await expect(page.locator("#left-pane-title")).toHaveText("Left Story > Text");
      await expect(page.locator("#right-pane-title")).toHaveText("Right Notes > Text");

      const resizer = page.locator("#split-resizer");
      const box = await resizer.boundingBox();
      if (!box) {
        throw new Error("Split resizer was not rendered");
      }
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 90, box.y + box.height / 2);
      await page.mouse.up();

      await expect.poll(async () => {
        const workspace = await readWorkspace(dataDir);
        return (workspace.layout as { splitMode?: string; splitRatio?: number }).splitMode;
      }).toBe("vertical");
      const savedRatio = Number(((await readWorkspace(dataDir)).layout as { splitRatio?: number }).splitRatio);
      expect(savedRatio).toBeGreaterThan(0.5);

      await closeApp(app);
      const relaunched = await launchTextEditor(testInfo, { clean: false, userDataDir });
      try {
        await expect(relaunched.page.locator('section[data-pane-id="right"]')).toBeVisible();
        await expect(relaunched.page.locator("#left-pane-title")).toHaveText("Left Story > Text");
        await expect(relaunched.page.locator("#right-pane-title")).toHaveText("Right Notes > Text");
      } finally {
        await closeApp(relaunched.app);
      }
    } finally {
      await closeApp(app);
    }
  });

  test("exports and imports the workspace zip", async ({}, testInfo) => {
    const zipPath = path.join(testInfo.outputDir, "workspace.zip");
    const source = await launchTextEditor(testInfo, { workspaceExportPath: zipPath });
    try {
      await source.page.locator("#active-title-input").fill("移行テスト");
      await source.page.locator("#active-title-input").press("Enter");
      const id = await activeTabId(source.page);
      await replaceEditorText(source.page, "移行データ");
      await waitForSavedTab(source.dataDir, id, "移行データ");

      await source.page.evaluate(async () => {
        await window.textEditor.exportWorkspace();
      });
      await expect.poll(async () => (await readFile(zipPath)).byteLength).toBeGreaterThan(0);
    } finally {
      await closeApp(source.app);
    }

    const importedUserData = path.join(testInfo.outputDir, "imported-user-data");
    const imported = await launchTextEditor(testInfo, { userDataDir: importedUserData, workspaceImportPath: zipPath });
    try {
      await imported.page.evaluate(async () => {
        await window.textEditor.importWorkspace();
      });
    } finally {
      await closeApp(imported.app);
    }

    const relaunched = await launchTextEditor(testInfo, { clean: false, userDataDir: importedUserData });
    try {
      await expect(relaunched.page.locator("#active-title-input")).toHaveValue("移行テスト");
      await expect(relaunched.page.locator("#left-editor-host .cm-content")).toContainText("移行データ");
    } finally {
      await closeApp(relaunched.app);
    }
  });

  test("persists Remote Inbox settings with safe defaults", async ({}, testInfo) => {
    const { app, page, dataDir } = await launchTextEditor(testInfo);
    try {
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send("menu:action", "open-settings");
      });
      await expect(page.locator('input[name="remote-enabled"]')).not.toBeChecked();
      await expect(page.locator('input[name="remote-port"]')).toHaveValue("48731");
      await expect(page.locator('input[name="remote-tab"]')).toHaveValue("Remote Inbox");
      await page.locator('input[name="remote-tab"]').fill("Phone Inbox");
      await page.locator('input[name="remote-domain"]').fill("https://team.cloudflareaccess.com");
      await page.locator('input[name="remote-audience"]').fill("audience-tag");
      await page.locator('input[name="remote-email"]').fill("me@example.com");
      await page.locator(".settings-dialog").getByRole("button", { name: "OK" }).click();
      await expect.poll(async () => (await readWorkspace(dataDir)).remoteInbox).toMatchObject({
        enabled: false,
        port: 48731,
        targetTabName: "Phone Inbox",
        accessTeamDomain: "https://team.cloudflareaccess.com",
        accessAudience: "audience-tag",
        allowedEmail: "me@example.com"
      });
    } finally {
      await closeApp(app);
    }
  });
});
