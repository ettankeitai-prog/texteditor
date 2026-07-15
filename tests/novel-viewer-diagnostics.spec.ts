import { expect, test, type TestInfo } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import electronPath from "electron";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  NovelViewerDiagnostics,
  sanitizeNovelViewerDiagnosticPayload,
  shouldEnableNovelViewerDiagnostics,
  shouldShowNovelViewerDiagnosticMenu
} from "../src/main/novelViewerDiagnostics";

const appRoot = path.resolve(__dirname, "..");
const fixtureUrl = "novel-reader-test://fixture/page-a";

async function launchDiagnostics(testInfo: TestInfo) {
  const userDataDir = path.join(testInfo.outputDir, "user-data");
  await rm(userDataDir, { recursive: true, force: true });
  await mkdir(userDataDir, { recursive: true });
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [appRoot],
    env: {
      ...process.env,
      TEXTEDITOR_USER_DATA: userDataDir,
      TEXTEDITOR_NOVEL_VIEWER_TEST_MODE: "1",
      TEXTEDITOR_NOVEL_VIEWER_DEBUG: "1"
    }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect.poll(() => page.evaluate(() => document.body.dataset.appReady)).toBe("true");
  return { app, page, userDataDir };
}

async function openFixture(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V");
  await expect(page.getByTestId("novel-viewer-pane")).toBeVisible();
  await page.locator("#novel-viewer-address").fill(fixtureUrl);
  await page.locator("#novel-viewer-address").press("Enter");
  await expect.poll(() => page.locator("#novel-viewer-address").inputValue()).toBe(fixtureUrl);
}

async function closeApp(app: ElectronApplication): Promise<void> {
  await app.close().catch(() => undefined);
}

async function clickDiagnosticMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`Diagnostic menu item was not found: ${itemId}`);
    item.click();
  }, id);
}

async function readDiagnosticLog(userDataDir: string): Promise<Array<Record<string, any>>> {
  const source = await readFile(path.join(userDataDir, "reader", "novel-viewer-debug.log"), "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  return source.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
}

async function nativeReaderState(app: ElectronApplication) {
  return app.evaluate(async ({ BrowserWindow, session, webContents }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const readerSession = session.fromPartition("novel-viewer-reader");
    const reader = webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && contents.session === readerSession);
    if (!window || !reader) throw new Error("Novel Viewer was not found");
    const children = window.contentView.children;
    const index = children.findIndex((candidate) =>
      (candidate as unknown as { webContents?: { id: number } }).webContents?.id === reader.id
    );
    return {
      id: reader.id,
      url: reader.getURL(),
      scrollY: await reader.executeJavaScript("window.scrollY") as number,
      sessionMatches: reader.session === readerSession,
      childCount: children.length,
      childIndex: index,
      included: index >= 0,
      topmost: index >= 0 && index === children.length - 1
    };
  });
}

test.describe("Novel Viewer diagnostics", () => {
  test("sanitizes nested diagnostic payloads at the output boundary", async ({}, testInfo) => {
    const logPath = path.join(testInfo.outputDir, "reader", "novel-viewer-debug.log");
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(`${logPath}.1`, "stale secret=must-not-be-logged", "utf8");

    const original = {
      url: "https://user:pass@example.com/a?secret=1#x",
      readerView: { url: "novel-reader-test://blocked/path?token=2" },
      nested: [{ locationHref: "https://example.com/b?q=3#y" }],
      lifecycle: "error",
      navigationEpoch: 7,
      webContentsId: 42,
      bounds: { x: 1, y: 2, width: 300, height: 400 },
      parent: { readerIndex: 0, readerIsTopmost: true }
    };
    const sanitized = sanitizeNovelViewerDiagnosticPayload(original) as typeof original;
    expect(sanitized).toMatchObject({
      url: "https://example.com/a",
      readerView: { url: "novel-reader-test://blocked/path" },
      nested: [{ locationHref: "https://example.com/b" }],
      lifecycle: "error",
      navigationEpoch: 7,
      webContentsId: 42,
      bounds: original.bounds,
      parent: original.parent
    });
    expect(original.url).toBe("https://user:pass@example.com/a?secret=1#x");
    expect(original.readerView.url).toBe("novel-reader-test://blocked/path?token=2");
    expect(original.nested[0].locationHref).toBe("https://example.com/b?q=3#y");
    expect(sanitizeNovelViewerDiagnosticPayload({
      url: "not a URL",
      webContentsUrl: "chrome-error://chromewebdata/?secret=5#internal"
    })).toEqual({
      url: "[invalid-url]",
      webContentsUrl: "chrome-error://chromewebdata/"
    });

    const circular: Record<string, unknown> = { redirectUrl: "https://example.com/c?code=4#z" };
    circular.self = circular;
    const diagnostics = new NovelViewerDiagnostics(logPath, true);
    for (const event of [
      "set-bounds-after",
      "periodic-20s-after",
      "diagnostic-dump",
      "renderer-snapshot",
      "diagnostic-bring-to-front-before",
      "diagnostic-bring-to-front-after",
      "webcontents-did-start-navigation"
    ]) {
      diagnostics.record(event, { snapshot: original, circular });
    }
    await diagnostics.flush();

    const currentLog = await readFile(logPath, "utf8");
    const staleLog = await readFile(`${logPath}.1`, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    const combinedLogs = `${currentLog}\n${staleLog}`;
    for (const forbidden of ["secret=1", "token=2", "q=3", "code=4", "user:pass", "must-not-be-logged"]) {
      expect(combinedLogs).not.toContain(forbidden);
    }
    expect(staleLog).toBe("");
    expect(currentLog).toContain("https://example.com/a");
    expect(currentLog).toContain("novel-reader-test://blocked/path");
    expect(currentLog).toContain("https://example.com/b");
    expect(currentLog).toContain("[circular]");
    expect(currentLog).toContain('"lifecycle":"error"');
    expect(currentLog).toContain('"navigationEpoch":7');
    expect(currentLog).toContain('"webContentsId":42');
    expect(currentLog).toContain('"readerIsTopmost":true');
  });

  test("keeps diagnostic menu out of packaged builds", () => {
    expect(shouldEnableNovelViewerDiagnostics(false, undefined)).toBe(true);
    expect(shouldEnableNovelViewerDiagnostics(true, undefined)).toBe(false);
    expect(shouldEnableNovelViewerDiagnostics(true, "1")).toBe(true);
    expect(shouldShowNovelViewerDiagnosticMenu(false)).toBe(true);
    expect(shouldShowNovelViewerDiagnosticMenu(true)).toBe(false);
  });

  test("detects membership and z-order and brings the same Reader View to front", async ({}, testInfo) => {
    const { app, page, userDataDir } = await launchDiagnostics(testInfo);
    try {
      await openFixture(page);
      await expect.poll(async () => (await nativeReaderState(app)).url).toBe(fixtureUrl);
      await app.evaluate(({ session, webContents }) => {
        const readerSession = session.fromPartition("novel-viewer-reader");
        const reader = webContents.getAllWebContents().find((contents) => contents.session === readerSession)!;
        return reader.executeJavaScript("window.scrollTo(0, 650)");
      });
      await expect.poll(async () => (await nativeReaderState(app)).scrollY).toBeGreaterThan(550);
      const original = await nativeReaderState(app);
      expect(original.included).toBe(true);
      expect(original.topmost).toBe(true);
      expect(original.sessionMatches).toBe(true);

      await clickDiagnosticMenu(app, "novel-viewer-diagnostic-dump");
      await expect.poll(async () => {
        const entries = await readDiagnosticLog(userDataDir);
        return entries.findLast((entry) => entry.event === "diagnostic-dump")?.main?.parent?.readerIndex;
      }).toBeGreaterThanOrEqual(0);
      await expect.poll(async () => {
        const entries = await readDiagnosticLog(userDataDir);
        return entries.findLast((entry) => entry.event === "renderer-snapshot")?.renderer?.slot?.isConnected;
      }).toBe(true);

      await app.evaluate(({ BrowserWindow, Menu, session }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const readerSession = session.fromPartition("novel-viewer-reader");
        const readerView = window.contentView.children.find((candidate) =>
          (candidate as unknown as { webContents?: { session: Electron.Session } }).webContents?.session === readerSession
        );
        if (!readerView) throw new Error("Reader View was not attached");
        window.contentView.removeChildView(readerView);
        Menu.getApplicationMenu()?.getMenuItemById("novel-viewer-diagnostic-dump")?.click();
      });
      await expect.poll(async () => {
        const entries = await readDiagnosticLog(userDataDir);
        return entries.findLast((entry) => entry.event === "diagnostic-dump")?.main?.parent?.readerIncluded;
      }).toBe(false);

      await clickDiagnosticMenu(app, "novel-viewer-diagnostic-bring-to-front");
      await expect.poll(async () => (await nativeReaderState(app)).topmost).toBe(true);
      const afterDetachedBring = await nativeReaderState(app);
      expect(afterDetachedBring.id).toBe(original.id);
      expect(afterDetachedBring.url).toBe(original.url);
      expect(afterDetachedBring.scrollY).toBeGreaterThan(550);
      expect(afterDetachedBring.sessionMatches).toBe(true);

      await app.evaluate(({ BrowserWindow, Menu, View }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const cover = new View();
        cover.setBounds({ x: 0, y: 0, width: 20, height: 20 });
        window.contentView.addChildView(cover);
        Menu.getApplicationMenu()?.getMenuItemById("novel-viewer-diagnostic-dump")?.click();
      });
      await expect.poll(async () => {
        const entries = await readDiagnosticLog(userDataDir);
        return entries.findLast((entry) => entry.event === "diagnostic-dump")?.main?.parent?.readerIsTopmost;
      }).toBe(false);

      await clickDiagnosticMenu(app, "novel-viewer-diagnostic-bring-to-front");
      await expect.poll(async () => (await nativeReaderState(app)).topmost).toBe(true);
      const final = await nativeReaderState(app);
      expect(final.id).toBe(original.id);
      expect(final.url).toBe(original.url);
      expect(final.scrollY).toBeGreaterThan(550);
      expect(final.sessionMatches).toBe(true);
      await expect.poll(async () => {
        const entries = await readDiagnosticLog(userDataDir);
        return entries.findLast((entry) => entry.event === "diagnostic-bring-to-front-after")?.main?.parent;
      }).toMatchObject({ readerIncluded: true, readerIsTopmost: true });
    } finally {
      await closeApp(app);
    }
  });
});
