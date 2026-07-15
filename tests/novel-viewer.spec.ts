import { expect, test, type TestInfo } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import electronPath from "electron";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ReaderStateStore, defaultReaderState, normalizeReaderState } from "../src/main/readerState";
import {
  isPrivateNetworkAddress,
  isPrivateNetworkHost,
  isSafeReaderNetworkRequest,
  validateNovelViewerUrl
} from "../src/main/novelViewerSecurity";

const appRoot = path.resolve(__dirname, "..");
const testPageA = "novel-reader-test://fixture/page-a";

async function launchNovelViewer(
  testInfo: TestInfo,
  options: { clean?: boolean; userDataDir?: string; allowRecoveryPrompt?: boolean } = {}
) {
  const userDataDir = options.userDataDir ?? path.join(testInfo.outputDir, "user-data");
  if (options.clean !== false) await rm(userDataDir, { recursive: true, force: true });
  await mkdir(userDataDir, { recursive: true });
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [appRoot],
    env: {
      ...process.env,
      TEXTEDITOR_USER_DATA: userDataDir,
      TEXTEDITOR_NOVEL_VIEWER_TEST_MODE: "1"
    }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  if (options.allowRecoveryPrompt) {
    await expect.poll(() => page.evaluate(() =>
      document.body.dataset.appReady === "true" || Boolean(document.querySelector('[data-recovery-action="restore"]'))
    )).toBe(true);
  } else {
    await expect.poll(() => page.evaluate(() => document.body.dataset.appReady)).toBe("true");
  }
  return { app, page, userDataDir };
}

async function closeApp(app: ElectronApplication) {
  await app.close().catch(() => undefined);
}

async function terminateApp(app: ElectronApplication) {
  const processHandle = app.process();
  const exited = new Promise<void>((resolve) => processHandle.once("exit", () => resolve()));
  await app.evaluate(({ app: electronApp }) => electronApp.exit(1)).catch(() => undefined);
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
}

async function readerWebContentsCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ session, webContents }) => {
    const readerSession = session.fromPartition("novel-viewer-reader");
    return webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents.session === readerSession).length;
  });
}

async function evaluateReader<T>(app: ElectronApplication, source: string): Promise<T> {
  return app.evaluate(async ({ session, webContents }, code) => {
    const readerSession = session.fromPartition("novel-viewer-reader");
    const reader = webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && contents.session === readerSession);
    if (!reader) throw new Error("Novel Viewer webContents was not found");
    return reader.executeJavaScript(code) as Promise<T>;
  }, source);
}

async function readerDocumentSnapshot(app: ElectronApplication): Promise<{
  pageId: string;
  locationHref: string;
  title: string;
  bodyText: string;
  blockedTargetExecuted: boolean;
}> {
  return evaluateReader(app, `({
    pageId: document.body?.dataset.pageId || "",
    locationHref: document.location.href,
    title: document.title,
    bodyText: document.body?.textContent || "",
    blockedTargetExecuted: window.__novelViewerBlockedTargetExecuted === true
  })`);
}

async function readerViewSnapshot(app: ElectronApplication): Promise<{
  id: number;
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  url: string;
  scrollY: number;
}> {
  return app.evaluate(async ({ BrowserWindow, session, webContents }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const readerSession = session.fromPartition("novel-viewer-reader");
    const reader = webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && contents.session === readerSession);
    if (!window || !reader) throw new Error("Novel Viewer was not found");
    const view = window.contentView.children.find((candidate) => {
      const possible = candidate as unknown as { webContents?: { id: number } };
      return possible.webContents?.id === reader.id;
    }) as unknown as {
      getVisible(): boolean;
      getBounds(): { x: number; y: number; width: number; height: number };
    } | undefined;
    if (!view) throw new Error("Novel Viewer is not attached to the window");
    return {
      id: reader.id,
      visible: view.getVisible(),
      bounds: view.getBounds(),
      url: reader.getURL(),
      scrollY: await reader.executeJavaScript("window.scrollY") as number
    };
  });
}

async function openViewer(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V");
  await expect(page.getByTestId("novel-viewer-pane")).toBeVisible();
}

async function navigateFixture(page: Page): Promise<void> {
  await page.locator("#novel-viewer-address").fill(testPageA);
  await page.locator("#novel-viewer-address").press("Enter");
  await expect.poll(() => page.locator("#novel-viewer-address").inputValue()).toBe(testPageA);
}

type NovelViewerDiagnosticEntry = Record<string, any> & {
  event: string;
  main?: {
    lifecycle?: string;
    navigationEpoch?: number;
    navigation?: { committedUrl?: string; lastReadableUrl?: string; title?: string };
  };
};

interface RecordedReaderNavigationEvent {
  eventName: string;
  url: string;
  isMainFrame?: boolean;
  frameProcessId?: number | null;
  frameRoutingId?: number | null;
  webContentsUrl: string;
}

async function startReaderNavigationRecorder(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ session, webContents }) => {
    const readerSession = session.fromPartition("novel-viewer-reader");
    const reader = webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && contents.session === readerSession);
    if (!reader) throw new Error("Novel Viewer webContents was not found");
    const state = globalThis as unknown as { __novelViewerNavigationEvents?: RecordedReaderNavigationEvent[] };
    const events: RecordedReaderNavigationEvent[] = [];
    state.__novelViewerNavigationEvents = events;
    const safeUrl = (rawUrl: string): string => {
      try {
        const parsed = new URL(rawUrl);
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        parsed.hash = "";
        return parsed.href;
      } catch {
        return "<invalid-url>";
      }
    };
    const record = (
      eventName: string,
      url: string,
      isMainFrame?: boolean,
      frameProcessId?: number | null,
      frameRoutingId?: number | null
    ): void => {
      events.push({
        eventName,
        url: safeUrl(url),
        isMainFrame,
        frameProcessId,
        frameRoutingId,
        webContentsUrl: safeUrl(reader.getURL())
      });
    };
    reader.on("will-redirect", (event) =>
      record("will-redirect", event.url, event.isMainFrame, event.frame?.processId, event.frame?.routingId));
    reader.on("did-redirect-navigation", (event) =>
      record("did-redirect-navigation", event.url, event.isMainFrame, event.frame?.processId, event.frame?.routingId));
    reader.on("did-start-navigation", (event) =>
      record("did-start-navigation", event.url, event.isMainFrame, event.frame?.processId, event.frame?.routingId));
    reader.on("did-frame-navigate", (_event, url, _status, _statusText, isMainFrame, processId, routingId) =>
      record("did-frame-navigate", url, isMainFrame, processId, routingId));
    reader.on("did-navigate", (_event, url) => record("did-navigate", url, true));
    reader.on("did-fail-load", (_event, _code, _description, url, isMainFrame, processId, routingId) =>
      record("did-fail-load", url, isMainFrame, processId, routingId));
    reader.on("did-stop-loading", () => record("did-stop-loading", reader.getURL()));
  });
}

async function recordedReaderNavigationEvents(app: ElectronApplication): Promise<RecordedReaderNavigationEvent[]> {
  return app.evaluate(() => {
    const state = globalThis as unknown as { __novelViewerNavigationEvents?: RecordedReaderNavigationEvent[] };
    return state.__novelViewerNavigationEvents ?? [];
  });
}

async function readNovelViewerDiagnostics(userDataDir: string): Promise<NovelViewerDiagnosticEntry[]> {
  const source = await readFile(path.join(userDataDir, "reader", "novel-viewer-debug.log"), "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  return source.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as NovelViewerDiagnosticEntry);
}

async function readAllNovelViewerDiagnosticLogs(userDataDir: string): Promise<string> {
  const readerDir = path.join(userDataDir, "reader");
  const sources = await Promise.all(["novel-viewer-debug.log", "novel-viewer-debug.log.1"].map(async (name) =>
    readFile(path.join(readerDir, name), "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    })
  ));
  return sources.join("\n");
}

async function dumpNovelViewerState(app: ElectronApplication, userDataDir: string): Promise<NovelViewerDiagnosticEntry> {
  const previousCount = (await readNovelViewerDiagnostics(userDataDir)).filter((entry) => entry.event === "diagnostic-dump").length;
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById("novel-viewer-diagnostic-dump");
    if (!item) throw new Error("Novel Viewer diagnostic menu was not found");
    item.click();
  });
  await expect.poll(async () =>
    (await readNovelViewerDiagnostics(userDataDir)).filter((entry) => entry.event === "diagnostic-dump").length
  ).toBeGreaterThan(previousCount);
  const entries = await readNovelViewerDiagnostics(userDataDir);
  return entries.findLast((entry) => entry.event === "diagnostic-dump")!;
}

async function requestNovelViewerUrl(page: Page, url: string): Promise<void> {
  await page.locator("#novel-viewer-address").fill(url);
  await page.locator("#novel-viewer-address").press("Enter");
}

test.describe("Novel Viewer pure security and state", () => {
  test("accepts only the explicit production origins and rejects dangerous URLs", () => {
    expect(validateNovelViewerUrl("https://kakuyomu.jp/works/123").ok).toBe(true);
    expect(validateNovelViewerUrl("ncode.syosetu.com/n1234ab/").ok).toBe(true);
    for (const candidate of [
      "http://kakuyomu.jp/",
      "https://evil-kakuyomu.jp/",
      "https://kakuyomu.jp.evil.example/",
      "https://localhost/",
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://10.0.0.1/",
      "https://192.168.1.1/",
      "javascript:alert(1)",
      "data:text/html,unsafe",
      "file:///tmp/unsafe",
      "blob:https://kakuyomu.jp/id"
    ]) {
      expect(validateNovelViewerUrl(candidate).ok, candidate).toBe(false);
    }
    expect(isPrivateNetworkHost("anything.localhost")).toBe(true);
    expect(isPrivateNetworkAddress("169.254.1.1")).toBe(true);
    expect(isPrivateNetworkAddress("fc00::1")).toBe(true);
    expect(isPrivateNetworkAddress("fe80::1")).toBe(true);
    expect(isPrivateNetworkAddress("8.8.8.8")).toBe(false);
  });

  test("validates Reader schema without changing document schemas", () => {
    expect(normalizeReaderState(defaultReaderState)).toEqual(defaultReaderState);
    expect(() => normalizeReaderState({ ...defaultReaderState, schemaVersion: 2 })).toThrow(/schema version/i);
    expect(() => normalizeReaderState({ ...defaultReaderState, progress: { scroll: { url: testPageA, scrollY: -1 } } })).toThrow();
  });

  test("keeps a corrupt Reader JSON byte-for-byte and makes the store read-only", async ({}, testInfo) => {
    const filePath = path.join(testInfo.outputDir, "reader", "state.json");
    const original = "{ damaged reader json\n";
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, original, "utf8");
    const store = new ReaderStateStore(filePath);
    const loaded = await store.load();
    expect(loaded.ok).toBe(false);
    await expect(store.save(defaultReaderState)).rejects.toThrow(/read-only/i);
    expect(await readFile(filePath, "utf8")).toBe(original);
  });
});

test.describe("Novel Viewer Electron integration", () => {
  test("is lazy, remains a singleton, and leaves no remote webContents after ten close cycles", async ({}, testInfo) => {
    const { app, page, userDataDir } = await launchNovelViewer(testInfo);
    try {
      expect(await readerWebContentsCount(app)).toBe(0);
      await expect(readFile(path.join(userDataDir, "reader", "state.json"), "utf8")).rejects.toThrow();
      for (let index = 0; index < 10; index += 1) {
        await openViewer(page);
        await expect.poll(() => readerWebContentsCount(app)).toBe(1);
        await page.locator("#novel-viewer-close").click();
        await expect(page.getByTestId("novel-viewer-pane")).toBeHidden();
        await expect.poll(() => readerWebContentsCount(app)).toBe(0);
      }
    } finally {
      await closeApp(app);
    }
  });

  test("uses an unprivileged remote renderer and rejects popup, download, permission, and unsafe navigation", async ({}, testInfo) => {
    const { app, page, userDataDir } = await launchNovelViewer(testInfo);
    try {
      await openViewer(page);
      await navigateFixture(page);
      await expect.poll(() => evaluateReader<string>(app, "location.href")).toBe(testPageA);
      const security = await evaluateReader<Record<string, string>>(app, `({
        textEditor: typeof window.textEditor,
        require: typeof globalThis.require,
        process: typeof globalThis.process
      })`);
      expect(security).toEqual({ textEditor: "undefined", require: "undefined", process: "undefined" });

      const preferences = await app.evaluate(({ session, webContents }) => {
        const readerSession = session.fromPartition("novel-viewer-reader");
        const reader = webContents.getAllWebContents().find((contents) => contents.session === readerSession)!;
        const prefs = reader.getLastWebPreferences();
        return {
          nodeIntegration: prefs.nodeIntegration,
          contextIsolation: prefs.contextIsolation,
          sandbox: prefs.sandbox,
          devTools: prefs.devTools,
          devToolsOpened: reader.isDevToolsOpened(),
          preload: prefs.preload,
          storagePath: readerSession.getStoragePath()
        };
      });
      expect(preferences).toEqual({
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: undefined,
        devToolsOpened: false,
        preload: undefined,
        storagePath: null
      });

      expect(await evaluateReader<unknown>(app, "document.querySelector('#popup').click(); window.open('novel-reader-test://fixture/popup')")).toBeNull();
      await expect.poll(() => readerWebContentsCount(app)).toBe(1);
      expect(await evaluateReader<string>(app, `new Promise(resolve => {
        navigator.geolocation.getCurrentPosition(() => resolve("allowed"), () => resolve("denied"), { timeout: 500 });
      })`)).toBe("denied");
      expect(await evaluateReader<boolean>(app, "document.querySelector('#download').click(); true")).toBe(true);
      await expect(page.locator("#novel-viewer-local-state")).toContainText(/downloads are disabled/i);
      await expect.poll(() => readerWebContentsCount(app)).toBe(1);
      await page.locator("#novel-viewer-reload").click();
      await expect.poll(() => evaluateReader<string>(app, "location.href")).toBe(testPageA);
      expect(await evaluateReader<boolean>(app, "document.querySelector('#blocked').click(); true")).toBe(true);
      await expect(page.locator("#novel-viewer-local-state")).toContainText(/blocked|stopped/i);
      await page.locator("#novel-viewer-close").click();
      const saved = JSON.parse(await readFile(path.join(userDataDir, "reader", "state.json"), "utf8")) as {
        progress: { lastReadableUrl?: string };
      };
      expect(saved.progress.lastReadableUrl).toBe(testPageA);
    } finally {
      await closeApp(app);
    }
  });

  test("separates main-frame redirects from subframe redirects and failures", async ({}, testInfo) => {
    const { app, page, userDataDir } = await launchNovelViewer(testInfo);
    const allowedRedirect = "novel-reader-test://fixture/redirect-to-page-b";
    const blockedRedirect = "novel-reader-test://fixture/redirect-to-blocked";
    const pageB = "novel-reader-test://fixture/page-b";
    try {
      expect(isSafeReaderNetworkRequest("http://127.0.0.1/private-frame")).toBe(false);
      expect(isSafeReaderNetworkRequest("https://localhost/private-frame")).toBe(false);
      expect(isSafeReaderNetworkRequest("https://10.0.0.1/private-frame")).toBe(false);
      expect(isSafeReaderNetworkRequest("https://169.254.1.1/private-frame")).toBe(false);
      expect(isSafeReaderNetworkRequest("https://public-subframe.example/frame")).toBe(true);

      await openViewer(page);
      await navigateFixture(page);
      await expect.poll(() => evaluateReader<string>(app, "location.href")).toBe(testPageA);
      await evaluateReader<void>(app, 'document.body.dataset.pageId = "page-a"');
      await expect.poll(async () => (await readerDocumentSnapshot(app)).pageId).toBe("page-a");
      await expect.poll(async () => {
        const state = JSON.parse(await readFile(path.join(userDataDir, "reader", "state.json"), "utf8")) as {
          progress: { lastReadableUrl?: string };
        };
        return state.progress.lastReadableUrl;
      }).toBe(testPageA);

      const before = await readerViewSnapshot(app);
      const beforeDump = await dumpNovelViewerState(app, userDataDir);
      expect(beforeDump.main?.navigation?.committedUrl).toBe(testPageA);

      await evaluateReader<boolean>(app, `(() => {
        const sources = [
          ["redirect", "novel-reader-test://fixture/redirect-to-blocked"],
          ["http-error", "novel-reader-test://fixture/subframe-http-500"],
          ["network-failure", "novel-reader-test://fixture/subframe-network-failure"],
          ["private-request", "http://127.0.0.1/private-subframe"]
        ];
        for (const [kind, src] of sources) {
          const frame = document.createElement("iframe");
          frame.dataset.redirectTest = kind;
          frame.src = src;
          document.body.appendChild(frame);
        }
        return true;
      })()`);

      await expect.poll(async () => {
        const entries = await readNovelViewerDiagnostics(userDataDir);
        return entries.findLast((entry) => entry.event === "subframe-redirect-observed")?.isMainFrame;
      }).toBe(false);
      await expect.poll(() => evaluateReader<boolean>(app, `Boolean(
        document.querySelector('iframe[data-redirect-test="http-error"]')?.contentDocument?.body?.textContent?.includes("Subframe HTTP 500")
      )`)).toBe(true);
      await expect.poll(async () => {
        const entries = await readNovelViewerDiagnostics(userDataDir);
        return entries.some((entry) => entry.event === "webcontents-did-fail-load" && entry.isMainFrame === false);
      }).toBe(true);

      const afterSubframeDump = await dumpNovelViewerState(app, userDataDir);
      const afterSubframe = await readerViewSnapshot(app);
      expect(afterSubframeDump.main?.lifecycle).toBe("visible");
      expect(afterSubframeDump.main?.navigationEpoch).toBe(beforeDump.main?.navigationEpoch);
      expect(afterSubframeDump.main?.navigation?.committedUrl).toBe(testPageA);
      expect(afterSubframeDump.main?.navigation?.lastReadableUrl).toBe(testPageA);
      expect(afterSubframeDump.main?.navigation?.title).toBe(beforeDump.main?.navigation?.title);
      expect(afterSubframe.id).toBe(before.id);
      expect(afterSubframe.visible).toBe(true);
      expect(afterSubframe.bounds.width).toBeGreaterThan(0);
      expect(afterSubframe.bounds.height).toBeGreaterThan(0);
      expect(afterSubframe.url).toBe(testPageA);
      await expect(page.getByTestId("novel-viewer-pane")).toHaveAttribute("data-lifecycle", "visible");
      await expect(page.locator("#novel-viewer-local-state")).toHaveText("");

      const subframeLog = (await readNovelViewerDiagnostics(userDataDir))
        .findLast((entry) => entry.event === "subframe-redirect-observed")!;
      expect(subframeLog).toMatchObject({
        targetUrl: "novel-reader-test://blocked/redirect-target",
        isMainFrame: false,
        validationResult: "refused",
        validationScope: "subframe-request",
        rejected: true,
        promotedToGlobalError: false
      });
      expect(subframeLog).toHaveProperty("frameProcessId");
      expect(subframeLog).toHaveProperty("frameRoutingId");
      expect(subframeLog.navigationEpoch).toBe(beforeDump.main?.navigationEpoch);
      expect(subframeLog.committedUrl).toBe(testPageA);
      expect(JSON.stringify(subframeLog)).not.toContain("must-not-be-logged");

      await requestNovelViewerUrl(page, allowedRedirect);
      await expect.poll(() => evaluateReader<string>(app, "location.href")).toBe(pageB);
      await evaluateReader<void>(app, 'document.body.dataset.pageId = "page-b"');
      await expect.poll(async () => (await readerDocumentSnapshot(app)).pageId).toBe("page-b");
      await expect(page.getByTestId("novel-viewer-pane")).toHaveAttribute("data-lifecycle", "visible");
      await expect.poll(async () => {
        const entries = await readNovelViewerDiagnostics(userDataDir);
        return entries.some((entry) => entry.event === "main-frame-redirect-allowed" && entry.isMainFrame === true);
      }).toBe(true);
      const allowedLog = (await readNovelViewerDiagnostics(userDataDir))
        .findLast((entry) => entry.event === "main-frame-redirect-allowed")!;
      expect(allowedLog).toMatchObject({
        targetUrl: pageB,
        isMainFrame: true,
        validationResult: "allowed",
        validationScope: "top-level-navigation",
        rejected: false,
        promotedToGlobalError: false,
        committedUrl: testPageA
      });
      expect(allowedLog).toHaveProperty("frameProcessId");
      expect(allowedLog).toHaveProperty("frameRoutingId");
      await expect.poll(async () => {
        const state = JSON.parse(await readFile(path.join(userDataDir, "reader", "state.json"), "utf8")) as {
          progress: { lastReadableUrl?: string };
        };
        return state.progress.lastReadableUrl;
      }).toBe(pageB);
      const afterAllowed = await readerViewSnapshot(app);
      expect(afterAllowed.id).toBe(before.id);
      const allowedDump = await dumpNovelViewerState(app, userDataDir);
      expect(allowedDump.main?.navigation?.committedUrl).toBe(pageB);
      expect(allowedDump.main?.navigation?.lastReadableUrl).toBe(pageB);

      await startReaderNavigationRecorder(app);
      const refusedLogStart = (await readNovelViewerDiagnostics(userDataDir)).length;
      await requestNovelViewerUrl(page, blockedRedirect);
      await expect(page.locator("#novel-viewer-local-state")).toContainText("blocked an unsafe redirect");
      await expect(page.getByTestId("novel-viewer-pane")).toHaveAttribute("data-lifecycle", "error");
      await expect.poll(async () => {
        const entries = await readNovelViewerDiagnostics(userDataDir);
        return entries.some((entry) => entry.event === "main-frame-redirect-refused" && entry.promotedToGlobalError === true);
      }).toBe(true);
      const refusedDump = await dumpNovelViewerState(app, userDataDir);
      const afterRefused = await readerViewSnapshot(app);
      const refusedDocument = await readerDocumentSnapshot(app);
      const refusedEntries = (await readNovelViewerDiagnostics(userDataDir)).slice(refusedLogStart);
      const recordedEvents = await recordedReaderNavigationEvents(app);
      expect(refusedDump.main?.navigation?.committedUrl).toBe(pageB);
      expect(refusedDump.main?.navigation?.lastReadableUrl).toBe(pageB);
      expect(afterRefused.id).toBe(before.id);
      expect(afterRefused.visible).toBe(false);
      expect(refusedDocument.pageId).not.toBe("blocked-target");
      expect(refusedDocument.title).not.toBe("Blocked Target Fixture");
      expect(refusedDocument.bodyText).not.toContain("BLOCKED_TARGET_FIXTURE_BODY");
      expect(refusedDocument.blockedTargetExecuted).toBe(false);
      expect(recordedEvents.some((entry) =>
        entry.eventName === "did-frame-navigate" &&
        entry.isMainFrame === true &&
        entry.url === "novel-reader-test://blocked/redirect-target"
      )).toBe(false);
      expect(recordedEvents.some((entry) =>
        entry.eventName === "did-navigate" &&
        entry.url === "novel-reader-test://blocked/redirect-target"
      )).toBe(false);
      expect(recordedEvents.some((entry) =>
        entry.eventName === "did-fail-load" &&
        entry.isMainFrame === true &&
        entry.url === "novel-reader-test://blocked/redirect-target"
      )).toBe(true);
      expect(recordedEvents.some((entry) => entry.eventName === "will-redirect" && entry.isMainFrame === true)).toBe(true);
      expect(recordedEvents.some((entry) => entry.eventName === "did-start-navigation" && entry.isMainFrame === true)).toBe(true);
      expect(recordedEvents.some((entry) => entry.eventName === "did-stop-loading")).toBe(true);
      expect(refusedEntries.some((entry) => entry.event === "webcontents-did-fail-load" && entry.isMainFrame === true)).toBe(true);
      // The address bar reflects the last safe committed URL, not the pending redirect
      // request or its refused target, even while the navigation error is displayed.
      expect(await page.locator("#novel-viewer-address").inputValue()).toBe(pageB);
      expect(await page.locator("#novel-viewer-local-state").textContent()).not.toContain("must-not-be-logged");
      const refusedLog = (await readNovelViewerDiagnostics(userDataDir))
        .findLast((entry) => entry.event === "main-frame-redirect-refused")!;
      expect(refusedLog).toMatchObject({
        targetUrl: "novel-reader-test://blocked/redirect-target",
        isMainFrame: true,
        validationResult: "refused",
        validationScope: "top-level-navigation",
        rejected: true,
        promotedToGlobalError: true
      });
      expect(refusedLog).toHaveProperty("frameProcessId");
      expect(refusedLog).toHaveProperty("frameRoutingId");
      expect(refusedLog.committedUrl).toBe(pageB);
      expect(JSON.stringify(refusedLog)).not.toContain("must-not-be-logged");
      expect(JSON.stringify(refusedEntries)).not.toContain("must-not-be-logged");
      expect(JSON.stringify(refusedDump)).not.toContain("must-not-be-logged");
      expect(JSON.stringify(recordedEvents)).not.toContain("must-not-be-logged");
      const allDiagnosticLogs = await readAllNovelViewerDiagnosticLogs(userDataDir);
      expect(allDiagnosticLogs).not.toContain("secret=must-not-be-logged");
      expect(allDiagnosticLogs).not.toContain("must-not-be-logged");
    } finally {
      await closeApp(app);
    }
  });

  test("checkpoints and restores scroll only for the matching URL", async ({}, testInfo) => {
    const { app, page, userDataDir } = await launchNovelViewer(testInfo);
    try {
      await openViewer(page);
      await navigateFixture(page);
      await expect.poll(() => evaluateReader<string>(app, "location.href")).toBe(testPageA);
      await evaluateReader<void>(app, "window.scrollTo(0, 1800)");
      await expect.poll(() => evaluateReader<number>(app, "window.scrollY")).toBeGreaterThan(1500);
      await page.locator("#novel-viewer-close").click();
      const statePath = path.join(userDataDir, "reader", "state.json");
      await expect.poll(async () => JSON.parse(await readFile(statePath, "utf8")).progress.scroll?.scrollY ?? 0).toBeGreaterThan(1500);
      const closedState = JSON.parse(await readFile(statePath, "utf8")) as { ui: { wasOpen: boolean } };
      expect(closedState.ui.wasOpen).toBe(false);

      await openViewer(page);
      await expect.poll(() => evaluateReader<string>(app, "location.href")).toBe(testPageA);
      await expect.poll(() => evaluateReader<number>(app, "window.scrollY")).toBeGreaterThan(1500);
    } finally {
      await closeApp(app);
    }
  });

  test("does not restore a mismatched scroll and cancels restoration after user input", async ({}, testInfo) => {
    const mismatchUserData = path.join(testInfo.outputDir, "mismatch-user-data");
    const mismatchStatePath = path.join(mismatchUserData, "reader", "state.json");
    await mkdir(path.dirname(mismatchStatePath), { recursive: true });
    await writeFile(mismatchStatePath, JSON.stringify({
      schemaVersion: 1,
      progress: {
        lastReadableUrl: testPageA,
        scroll: {
          url: "novel-reader-test://fixture/page-b",
          scrollY: 1800,
          documentHeight: 4200,
          viewportHeight: 600,
          progressRatio: 0.5
        }
      },
      ui: { wasOpen: true, preferredPane: "right" }
    }), "utf8");
    const mismatch = await launchNovelViewer(testInfo, { clean: false, userDataDir: mismatchUserData });
    try {
      await expect.poll(() => evaluateReader<string>(mismatch.app, "location.href")).toBe(testPageA);
      await expect.poll(() => evaluateReader<number>(mismatch.app, "window.scrollY")).toBe(0);
    } finally {
      await closeApp(mismatch.app);
    }

    const interactionUserData = path.join(testInfo.outputDir, "interaction-user-data");
    const interactionStatePath = path.join(interactionUserData, "reader", "state.json");
    const slowUrl = "novel-reader-test://fixture/slow";
    await mkdir(path.dirname(interactionStatePath), { recursive: true });
    await writeFile(interactionStatePath, JSON.stringify({
      schemaVersion: 1,
      progress: {
        lastReadableUrl: slowUrl,
        scroll: {
          url: slowUrl,
          scrollY: 1800,
          documentHeight: 4200,
          viewportHeight: 600,
          progressRatio: 0.5
        }
      },
      ui: { wasOpen: true, preferredPane: "right" }
    }), "utf8");
    const interaction = await launchNovelViewer(testInfo, { clean: false, userDataDir: interactionUserData });
    try {
      await expect.poll(() => evaluateReader<string>(interaction.app, "location.href")).toBe(slowUrl);
      await interaction.app.evaluate(async ({ session, webContents }) => {
        const readerSession = session.fromPartition("novel-viewer-reader");
        const reader = webContents.getAllWebContents().find((contents) => contents.session === readerSession)!;
        await reader.sendInputEvent({ type: "mouseDown", x: 30, y: 30, button: "left", clickCount: 1 });
        await reader.sendInputEvent({ type: "mouseUp", x: 30, y: 30, button: "left", clickCount: 1 });
        await reader.executeJavaScript("window.scrollTo(0, 400)");
      });
      await expect.poll(() => evaluateReader<number>(interaction.app, "window.scrollY")).toBe(400);
    } finally {
      await closeApp(interaction.app);
    }
  });

  test("preserves the right Editor state and saved ratio, with narrow single-pane fallback", async ({}, testInfo) => {
    const { app, page, userDataDir } = await launchNovelViewer(testInfo);
    try {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+\\" : "Control+\\");
      await expect(page.locator('section[data-pane-id="right"]')).toBeVisible();
      const workspacePath = path.join(userDataDir, "data", "workspace.json");
      await expect.poll(async () => (JSON.parse(await readFile(workspacePath, "utf8")) as { layout: { splitMode: string } }).layout.splitMode).toBe("vertical");
      const before = (JSON.parse(await readFile(workspacePath, "utf8")) as { layout: unknown }).layout;

      await openViewer(page);
      await expect(page.locator('section[data-pane-id="right"]')).toBeHidden();
      await expect(page.locator('section[data-pane-id="left"]')).toBeVisible();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 700));
      await expect(page.locator("#editor-area")).toHaveClass(/is-novel-viewer-single/);
      await expect(page.locator('section[data-pane-id="left"]')).toBeHidden();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1220, 820));
      await expect(page.locator('section[data-pane-id="left"]')).toBeVisible();

      await page.locator("#novel-viewer-close").click();
      await expect(page.locator('section[data-pane-id="right"]')).toBeVisible();
      const after = (JSON.parse(await readFile(workspacePath, "utf8")) as { layout: unknown }).layout;
      expect(after).toEqual(before);
    } finally {
      await closeApp(app);
    }
  });

  test("takes back and forward state from remote history and keeps an address draft separate", async ({}, testInfo) => {
    const { app, page } = await launchNovelViewer(testInfo);
    try {
      await openViewer(page);
      await navigateFixture(page);
      await expect.poll(() => evaluateReader<string>(app, "location.href")).toBe(testPageA);
      expect(await evaluateReader<boolean>(app, "document.querySelector('#next').click(); true")).toBe(true);
      await expect.poll(() => evaluateReader<string>(app, "location.href")).toBe("novel-reader-test://fixture/page-b");
      await expect(page.locator("#novel-viewer-back")).toBeEnabled();

      await page.locator("#novel-viewer-address").fill("draft that is not a URL");
      await page.locator("#novel-viewer-back").click();
      await expect.poll(() => evaluateReader<string>(app, "location.href")).toBe(testPageA);
      await expect(page.locator("#novel-viewer-address")).toHaveValue("draft that is not a URL");
      await expect(page.locator("#novel-viewer-forward")).toBeEnabled();
      await page.locator("#novel-viewer-forward").click();
      await expect.poll(() => evaluateReader<string>(app, "location.href")).toBe("novel-reader-test://fixture/page-b");
    } finally {
      await closeApp(app);
    }
  });

  test("keeps Novel Viewer shortcuts available while remote content has focus", async ({}, testInfo) => {
    const { app, page } = await launchNovelViewer(testInfo);
    try {
      await openViewer(page);
      await navigateFixture(page);
      await expect.poll(() => evaluateReader<string>(app, "location.href")).toBe(testPageA);
      const sendReaderKey = (keyCode: string, modifiers: string[]) => app.evaluate(async ({ session, webContents }, input) => {
        const readerSession = session.fromPartition("novel-viewer-reader");
        const reader = webContents.getAllWebContents().find((contents) => contents.session === readerSession)!;
        reader.focus();
        await reader.sendInputEvent({ type: "keyDown", keyCode: input.keyCode, modifiers: input.modifiers });
        await reader.sendInputEvent({ type: "keyUp", keyCode: input.keyCode, modifiers: input.modifiers });
      }, { keyCode, modifiers });

      await sendReaderKey("L", ["control"]);
      await expect(page.locator("#novel-viewer-address")).toBeFocused();
      await sendReaderKey("S", ["control"]);
      await expect.poll(() => evaluateReader<string>(app, "location.href")).toBe(testPageA);
      await sendReaderKey("Escape", []);
      await expect(page.locator("#novel-viewer-address")).toBeFocused();
      await sendReaderKey("W", ["control", "shift"]);
      await expect(page.getByTestId("novel-viewer-pane")).toBeHidden();
      await expect.poll(() => readerWebContentsCount(app)).toBe(0);
    } finally {
      await closeApp(app);
    }
  });

  test("occludes for trusted dialogs and contains a remote renderer crash", async ({}, testInfo) => {
    const { app, page } = await launchNovelViewer(testInfo);
    try {
      await openViewer(page);
      await navigateFixture(page);
      await expect.poll(() => evaluateReader<string>(app, "document.visibilityState")).toBe("visible");
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("menu:action", "open-settings"));
      await expect(page.locator(".settings-dialog")).toBeVisible();
      await expect(page.getByTestId("novel-viewer-pane")).toHaveAttribute("data-lifecycle", "occluded");
      await page.locator('.settings-dialog [data-dialog-action="cancel"]').click();
      await expect(page.getByTestId("novel-viewer-pane")).toHaveAttribute("data-lifecycle", "visible");
      await expect.poll(() => evaluateReader<string>(app, "location.href")).toBe(testPageA);

      await app.evaluate(({ session, webContents }) => {
        const readerSession = session.fromPartition("novel-viewer-reader");
        webContents.getAllWebContents().find((contents) => contents.session === readerSession)?.forcefullyCrashRenderer();
      });
      await expect(page.locator("#novel-viewer-local-state")).toContainText(/stopped safely/i);
      await page.locator("#left-editor-host .cm-content").click();
      await page.keyboard.insertText("editor remains available");
      await expect(page.locator("#left-editor-host .cm-content")).toContainText("editor remains available");
      await page.locator("#novel-viewer-close").click();
      await expect.poll(() => readerWebContentsCount(app)).toBe(0);
    } finally {
      await closeApp(app);
    }
  });

  test("keeps overlapping trusted occlusion reasons hidden until every reason clears", async ({}, testInfo) => {
    const { app, page } = await launchNovelViewer(testInfo);
    try {
      await openViewer(page);
      await navigateFixture(page);
      await expect.poll(() => evaluateReader<string>(app, "location.href")).toBe(testPageA);
      await evaluateReader<void>(app, "window.scrollTo(0, 900)");
      await expect.poll(() => evaluateReader<number>(app, "window.scrollY")).toBeGreaterThan(800);
      const before = await readerViewSnapshot(app);

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("menu:action", "global-search"));
      await expect(page.locator("#search-panel")).toBeVisible();
      await expect(page.getByTestId("novel-viewer-pane")).toHaveAttribute("data-lifecycle", "occluded");
      await page.evaluate(() => {
        const overlay = document.createElement("div");
        overlay.className = "dialog-overlay command-palette-overlay";
        overlay.dataset.testOccluder = "command-palette";
        overlay.innerHTML = '<div class="app-dialog">Command Palette</div>';
        document.body.appendChild(overlay);
      });
      await page.locator('[data-action="close-global-search"]').evaluate((button) => (button as HTMLButtonElement).click());
      await expect(page.locator("#search-panel")).toBeHidden();
      await expect(page.getByTestId("novel-viewer-pane")).toHaveAttribute("data-lifecycle", "occluded");
      await page.locator('[data-test-occluder="command-palette"]').evaluate((element) => element.remove());
      await expect(page.getByTestId("novel-viewer-pane")).toHaveAttribute("data-lifecycle", "visible");

      for (const action of ["find", "replace"]) {
        await app.evaluate(({ BrowserWindow }, menuAction) => {
          BrowserWindow.getAllWindows()[0].webContents.send("menu:action", menuAction);
        }, action);
        await expect(page.locator(".cm-panel.cm-search")).toBeVisible();
        await expect(page.getByTestId("novel-viewer-pane")).toHaveAttribute("data-lifecycle", "occluded");
        await page.locator('.cm-panel.cm-search button[name="close"]').click();
        await expect(page.locator(".cm-panel.cm-search")).toBeHidden();
        await expect(page.getByTestId("novel-viewer-pane")).toHaveAttribute("data-lifecycle", "visible");
      }

      const after = await readerViewSnapshot(app);
      expect(after.id).toBe(before.id);
      expect(after.visible).toBe(true);
      expect(after.url).toBe(before.url);
      expect(after.scrollY).toBeGreaterThan(800);
      expect(await readerWebContentsCount(app)).toBe(1);
    } finally {
      await closeApp(app);
    }
  });

  test("reapplies the same View after window geometry and transient bounds changes", async ({}, testInfo) => {
    const { app, page } = await launchNovelViewer(testInfo);
    try {
      await openViewer(page);
      await navigateFixture(page);
      await expect.poll(() => evaluateReader<string>(app, "location.href")).toBe(testPageA);
      await evaluateReader<void>(app, "window.scrollTo(0, 700)");
      await expect.poll(() => evaluateReader<number>(app, "window.scrollY")).toBeGreaterThan(600);
      const before = await readerViewSnapshot(app);

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 720));
      await expect.poll(async () => (await readerViewSnapshot(app)).visible).toBe(true);
      await app.evaluate(async ({ BrowserWindow }, maximized) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window.isMaximized() === maximized) return;
        await new Promise<void>((resolve) => {
          window.once(maximized ? "maximize" : "unmaximize", () => resolve());
          if (maximized) window.maximize();
          else window.unmaximize();
        });
      }, true);
      await expect.poll(async () => (await readerViewSnapshot(app)).visible).toBe(true);
      await app.evaluate(async ({ BrowserWindow }, maximized) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window.isMaximized() === maximized) return;
        await new Promise<void>((resolve) => {
          window.once(maximized ? "maximize" : "unmaximize", () => resolve());
          if (maximized) window.maximize();
          else window.unmaximize();
        });
      }, false);
      await expect.poll(async () => (await readerViewSnapshot(app)).visible).toBe(true);

      const hiddenWhileMinimized = await app.evaluate(async ({ BrowserWindow, session, webContents }) => {
        const window = BrowserWindow.getAllWindows()[0];
        await new Promise<void>((resolve) => {
          window.once("minimize", () => resolve());
          window.minimize();
        });
        const readerSession = session.fromPartition("novel-viewer-reader");
        const reader = webContents.getAllWebContents().find((contents) => contents.session === readerSession)!;
        const view = window.contentView.children.find((candidate) =>
          (candidate as unknown as { webContents?: { id: number } }).webContents?.id === reader.id
        ) as unknown as { getVisible(): boolean };
        const hidden = !view.getVisible();
        await new Promise<void>((resolve) => {
          window.once("restore", () => resolve());
          window.restore();
        });
        return hidden;
      });
      expect(hiddenWhileMinimized).toBe(true);
      await expect.poll(async () => (await readerViewSnapshot(app)).visible).toBe(true);

      await app.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        await new Promise<void>((resolve) => {
          window.once("hide", () => resolve());
          window.hide();
        });
        await new Promise<void>((resolve) => {
          window.once("show", () => resolve());
          window.show();
        });
      });
      await expect.poll(async () => (await readerViewSnapshot(app)).visible).toBe(true);

      const rect = await page.locator("#novel-viewer-slot").evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      });
      const forcedRevision = 1_000_000;
      await page.evaluate(async ({ bounds, revision }) => {
        await window.textEditor.updateNovelViewerBounds({
          layoutRevision: revision,
          x: bounds.x,
          y: bounds.y,
          width: 0,
          height: 0,
          visible: true
        });
      }, { bounds: rect, revision: forcedRevision });
      await expect.poll(async () => (await readerViewSnapshot(app)).visible).toBe(false);
      await page.evaluate(async ({ bounds, revision }) => {
        await window.textEditor.updateNovelViewerBounds({
          layoutRevision: revision,
          ...bounds,
          visible: true
        });
      }, { bounds: rect, revision: forcedRevision });
      await expect.poll(async () => (await readerViewSnapshot(app)).visible).toBe(true);
      await page.evaluate(async ({ bounds, revision }) => {
        await window.textEditor.updateNovelViewerBounds({
          layoutRevision: revision - 1,
          x: bounds.x,
          y: bounds.y,
          width: 0,
          height: 0,
          visible: true
        });
      }, { bounds: rect, revision: forcedRevision });

      const after = await readerViewSnapshot(app);
      expect(after.id).toBe(before.id);
      expect(after.visible).toBe(true);
      expect(after.bounds.width).toBeGreaterThan(0);
      expect(after.bounds.height).toBeGreaterThan(0);
      expect(after.url).toBe(before.url);
      expect(after.scrollY).toBeGreaterThan(600);
      expect(await readerWebContentsCount(app)).toBe(1);
    } finally {
      await closeApp(app);
    }
  });

  test("finishes shutdown when the Reader renderer is unresponsive", async ({}, testInfo) => {
    const { app, page } = await launchNovelViewer(testInfo);
    await openViewer(page);
    await navigateFixture(page);
    await expect.poll(() => evaluateReader<string>(app, "location.href")).toBe(testPageA);
    await app.evaluate(({ session, webContents }) => {
      const readerSession = session.fromPartition("novel-viewer-reader");
      const reader = webContents.getAllWebContents().find((contents) => contents.session === readerSession)!;
      void reader.executeJavaScript("while (true) {};");
    });
    const closed = await Promise.race([
      app.close().then(() => true, () => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8_000))
    ]);
    expect(closed).toBe(true);
  });

  test("restores an open Novel Viewer after normal shutdown", async ({}, testInfo) => {
    const first = await launchNovelViewer(testInfo);
    await openViewer(first.page);
    await navigateFixture(first.page);
    await expect.poll(() => evaluateReader<string>(first.app, "location.href")).toBe(testPageA);
    await closeApp(first.app);

    const normal = await launchNovelViewer(testInfo, { clean: false, userDataDir: first.userDataDir });
    try {
      await expect(normal.page.getByTestId("novel-viewer-pane")).toBeVisible();
      await expect.poll(() => evaluateReader<string>(normal.app, "location.href")).toBe(testPageA);
    } finally {
      await closeApp(normal.app);
    }
  });

  test("restores an open Novel Viewer when abnormal recovery is accepted", async ({}, testInfo) => {
    const first = await launchNovelViewer(testInfo);
    await openViewer(first.page);
    await navigateFixture(first.page);
    await expect.poll(() => evaluateReader<string>(first.app, "location.href")).toBe(testPageA);
    await terminateApp(first.app);
    const recovery = await launchNovelViewer(testInfo, {
      clean: false,
      userDataDir: first.userDataDir,
      allowRecoveryPrompt: true
    });
    try {
      await recovery.page.locator('[data-recovery-action="restore"]').click();
      await expect.poll(() => recovery.page.evaluate(() => document.body.dataset.appReady)).toBe("true");
      await expect(recovery.page.getByTestId("novel-viewer-pane")).toBeVisible();
      await expect.poll(() => evaluateReader<string>(recovery.app, "location.href")).toBe(testPageA);
    } finally {
      await closeApp(recovery.app);
    }
  });

  test("keeps progress but starts closed when abnormal recovery is skipped", async ({}, testInfo) => {
    const first = await launchNovelViewer(testInfo);
    await openViewer(first.page);
    await navigateFixture(first.page);
    await expect.poll(() => evaluateReader<string>(first.app, "location.href")).toBe(testPageA);
    await terminateApp(first.app);
    const skipped = await launchNovelViewer(testInfo, {
      clean: false,
      userDataDir: first.userDataDir,
      allowRecoveryPrompt: true
    });
    try {
      await skipped.page.locator('[data-recovery-action="skip"]').click();
      await expect.poll(() => skipped.page.evaluate(() => document.body.dataset.appReady)).toBe("true");
      await expect(skipped.page.getByTestId("novel-viewer-pane")).toBeHidden();
      expect(await readerWebContentsCount(skipped.app)).toBe(0);
      const state = JSON.parse(await readFile(path.join(first.userDataDir, "reader", "state.json"), "utf8")) as {
        progress: { lastReadableUrl?: string };
        ui: { wasOpen: boolean };
      };
      expect(state.progress.lastReadableUrl).toBe(testPageA);
      expect(state.ui.wasOpen).toBe(false);
    } finally {
      await closeApp(skipped.app);
    }
  });

  test("starts the document editor while preserving a corrupt Reader state", async ({}, testInfo) => {
    const userDataDir = path.join(testInfo.outputDir, "corrupt-user-data");
    const statePath = path.join(userDataDir, "reader", "state.json");
    const corrupt = "{ corrupt Reader JSON\n";
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, corrupt, "utf8");
    const { app, page } = await launchNovelViewer(testInfo, { clean: false, userDataDir });
    try {
      await expect(page.locator("#left-editor-host .cm-content")).toBeVisible();
      expect(await readerWebContentsCount(app)).toBe(0);
      await openViewer(page);
      await expect(page.locator("#novel-viewer-local-state")).toContainText(/state is damaged/i);
      expect(await readFile(statePath, "utf8")).toBe(corrupt);
    } finally {
      await closeApp(app);
    }
    expect(await readFile(statePath, "utf8")).toBe(corrupt);
  });
});
