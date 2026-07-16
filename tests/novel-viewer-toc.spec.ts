import { expect, test, type TestInfo } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import electronPath from "electron";
import { mkdir, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  NOVEL_VIEWER_EDITOR_MIN_WIDTH,
  NOVEL_VIEWER_PANE_MIN_WIDTH,
  NOVEL_VIEWER_SPLIT_RATIO_DEFAULT,
  NOVEL_VIEWER_SPLIT_RATIO_MAX,
  NOVEL_VIEWER_SPLIT_RATIO_MIN,
  NOVEL_VIEWER_TOC_WIDTH_DEFAULT,
  NOVEL_VIEWER_TOC_WIDTH_MAX,
  NOVEL_VIEWER_TOC_WIDTH_MIN,
  type NovelViewerFavorite,
  type NovelViewerToc
} from "../src/shared/novelViewer";
import {
  addNovelViewerFavorite,
  normalizeNovelViewerFavorites,
  normalizeNovelViewerWorkUrl,
  removeNovelViewerFavorite
} from "../src/shared/novelViewerFavorites";
import { defaultReaderState, normalizeReaderState, ReaderStateStore } from "../src/main/readerState";
import { createKakuyomuAdapter, createNarouAdapter } from "../src/main/novelViewer/adapters/index";
import {
  NOVEL_VIEWER_TOC_CACHE_MAX_BYTES,
  NOVEL_VIEWER_TOC_CACHE_RENAME_RETRY_DELAYS_MS,
  NOVEL_VIEWER_TOC_CACHE_TTL_MS,
  NovelViewerTocCache
} from "../src/main/novelViewer/novelViewerTocCache";
import { NovelViewerTocService, normalizeNovelViewerTocResult } from "../src/main/novelViewer/novelViewerTocService";

const appRoot = path.resolve(__dirname, "..");
const kakuyomuEpisodeOne = "novel-reader-test://fixture/toc/kakuyomu/works/work-alpha/episodes/episode-1";
const kakuyomuEpisodeTwo = "novel-reader-test://fixture/toc/kakuyomu/works/work-alpha/episodes/episode-2";
const narouEpisodeOne = "novel-reader-test://fixture/toc/narou/n1234ab/1/";

async function launchTocApp(testInfo: TestInfo, setup?: (userDataDir: string) => Promise<void>) {
  const userDataDir = path.join(testInfo.outputDir, "user-data");
  await rm(userDataDir, { recursive: true, force: true });
  await mkdir(userDataDir, { recursive: true });
  await setup?.(userDataDir);
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
  await expect.poll(() => page.evaluate(() => document.body.dataset.appReady)).toBe("true");
  return { app, page, userDataDir };
}

async function closeApp(app: ElectronApplication): Promise<void> {
  await app.close().catch(() => undefined);
}

async function openViewerAt(page: Page, url: string): Promise<void> {
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V");
  await expect(page.getByTestId("novel-viewer-pane")).toBeVisible();
  await page.locator("#novel-viewer-address").fill(url);
  await page.locator("#novel-viewer-address").press("Enter");
  await expect.poll(() => page.locator("#novel-viewer-address").inputValue()).toBe(url);
  await expect(page.locator("#novel-viewer-toc")).toBeEnabled();
}

async function readerViewSnapshot(app: ElectronApplication): Promise<{
  id: number;
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  url: string;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  resizeEvents: number;
  documentWidth: number;
  zoomFactor: number;
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
    if (!view) throw new Error("Novel Viewer View was not attached");
    const viewport = await reader.executeJavaScript(`({
      scrollY: window.scrollY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      resizeEvents: Number(window.__novelViewerResizeEvents || 0),
      documentWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0)
    })`) as {
      scrollY: number;
      viewportWidth: number;
      viewportHeight: number;
      resizeEvents: number;
      documentWidth: number;
    };
    return {
      id: reader.id,
      visible: view.getVisible(),
      bounds: view.getBounds(),
      url: reader.getURL(),
      zoomFactor: reader.getZoomFactor(),
      ...viewport
    };
  });
}

async function observeReaderResizeEvents(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ session, webContents }) => {
    const readerSession = session.fromPartition("novel-viewer-reader");
    const reader = webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && contents.session === readerSession);
    if (!reader) throw new Error("Novel Viewer was not found");
    await reader.executeJavaScript(`
      window.__novelViewerResizeEvents = 0;
      window.addEventListener("resize", () => { window.__novelViewerResizeEvents += 1; });
    `);
  });
}

function viewportFitDiagnostic(snapshot: Awaited<ReturnType<typeof readerViewSnapshot>>): {
  ready: boolean;
  zoomFactor: number;
  documentWidth: number;
  boundsWidth: number;
  viewportWidth: number;
  viewportHeight: number;
  narrow: boolean;
  capturedAt: string;
} {
  return {
    ready: snapshot.zoomFactor < 1 &&
      snapshot.documentWidth * snapshot.zoomFactor <= snapshot.bounds.width + 2,
    zoomFactor: snapshot.zoomFactor,
    documentWidth: snapshot.documentWidth,
    boundsWidth: snapshot.bounds.width,
    viewportWidth: snapshot.viewportWidth,
    viewportHeight: snapshot.viewportHeight,
    narrow: snapshot.zoomFactor < 0.99,
    capturedAt: new Date().toISOString()
  };
}

async function setReaderScroll(app: ElectronApplication, scrollY: number): Promise<void> {
  await app.evaluate(async ({ session, webContents }, target) => {
    const readerSession = session.fromPartition("novel-viewer-reader");
    const reader = webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && contents.session === readerSession);
    if (!reader) throw new Error("Novel Viewer was not found");
    await reader.executeJavaScript(`window.scrollTo(0, ${Number(target)})`);
  }, scrollY);
  await expect.poll(async () => (await readerViewSnapshot(app)).scrollY).toBeGreaterThan(0);
}

async function dragSeparatorBy(page: Page, selector: string, deltaX: number): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`Separator is not visible: ${selector}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y, { steps: 4 });
  await page.mouse.up();
}

function makeToc(workId: string, fetchedAt: string, episodeCount = 2, titleSize = 12): NovelViewerToc {
  return {
    schemaVersion: 1,
    adapterId: "kakuyomu",
    adapterVersion: 1,
    workId,
    workTitle: `Work ${workId}`,
    canonicalWorkUrl: `https://kakuyomu.jp/works/${workId}`,
    fetchedAt,
    sections: [{
      order: 0,
      title: "Section",
      episodes: Array.from({ length: episodeCount }, (_, index) => ({
        episodeId: `episode-${index}`,
        order: index,
        title: "E".repeat(titleSize),
        canonicalUrl: `https://kakuyomu.jp/works/${workId}/episodes/episode-${index}`
      }))
    }]
  };
}

function fileSystemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: fixture filesystem failure`), {
    code,
    syscall: "rename"
  });
}

test.describe("Novel Viewer TOC adapters", () => {
  test("normalizes supported episode URLs to work favorites and manages unique entries", () => {
    expect(normalizeNovelViewerWorkUrl(
      "https://kakuyomu.jp/works/16818792438097458603/episodes/16818792438220454136?from=test#body"
    )).toEqual({
      adapterId: "kakuyomu",
      workId: "16818792438097458603",
      canonicalWorkUrl: "https://kakuyomu.jp/works/16818792438097458603"
    });
    expect(normalizeNovelViewerWorkUrl("https://kakuyomu.jp/works/16818792438097458603")).toMatchObject({
      canonicalWorkUrl: "https://kakuyomu.jp/works/16818792438097458603"
    });
    expect(normalizeNovelViewerWorkUrl("https://kakuyomu.jp/works/16818792438097458603/")).toMatchObject({
      canonicalWorkUrl: "https://kakuyomu.jp/works/16818792438097458603"
    });
    expect(normalizeNovelViewerWorkUrl("https://ncode.syosetu.com/N8919MK/1/?from=test#body")).toEqual({
      adapterId: "narou",
      workId: "n8919mk",
      canonicalWorkUrl: "https://ncode.syosetu.com/n8919mk/"
    });
    expect(normalizeNovelViewerWorkUrl("https://ncode.syosetu.com/n8919mk")).toMatchObject({
      canonicalWorkUrl: "https://ncode.syosetu.com/n8919mk/"
    });
    expect(normalizeNovelViewerWorkUrl("https://ncode.syosetu.com/n8919mk/")).toMatchObject({
      canonicalWorkUrl: "https://ncode.syosetu.com/n8919mk/"
    });
    expect(normalizeNovelViewerWorkUrl("https://example.com/works/123")).toBeNull();
    expect(normalizeNovelViewerWorkUrl("not a url")).toBeNull();

    const favorite: NovelViewerFavorite = {
      adapterId: "kakuyomu",
      workId: "16818792438097458603",
      canonicalWorkUrl: "https://kakuyomu.jp/works/16818792438097458603",
      workTitle: "Fixture Work",
      addedAt: "2026-01-01T00:00:00.000Z"
    };
    const addedTwice = addNovelViewerFavorite(addNovelViewerFavorite([], favorite), {
      ...favorite,
      workTitle: "Updated Work",
      addedAt: "2026-01-02T00:00:00.000Z"
    });
    expect(addedTwice).toHaveLength(1);
    expect(addedTwice[0].workTitle).toBe("Updated Work");
    expect(removeNovelViewerFavorite(addedTwice, favorite.canonicalWorkUrl)).toEqual([]);
    expect(normalizeNovelViewerFavorites([
      { ...favorite, canonicalWorkUrl: `${favorite.canonicalWorkUrl}/` },
      { bad: true },
      favorite
    ])).toEqual([favorite]);
  });

  test("matches canonical work and episode URLs without widening supported origins", () => {
    const kakuyomu = createKakuyomuAdapter();
    const narou = createNarouAdapter();
    expect(kakuyomu.matchUrl(new URL("https://kakuyomu.jp/works/123"))).toMatchObject({ workId: "123" });
    expect(kakuyomu.matchUrl(new URL("https://kakuyomu.jp/works/123/episodes/456"))).toMatchObject({
      workId: "123",
      currentEpisodeId: "456",
      canonicalWorkUrl: "https://kakuyomu.jp/works/123"
    });
    expect(kakuyomu.matchUrl(new URL("https://kakuyomu.jp/rankings"))).toBeNull();
    expect(kakuyomu.matchUrl(new URL("https://evil-kakuyomu.jp/works/123"))).toBeNull();
    expect(narou.matchUrl(new URL("https://ncode.syosetu.com/N1234AB/2/"))).toMatchObject({
      workId: "n1234ab",
      currentEpisodeId: "2",
      canonicalWorkUrl: "https://ncode.syosetu.com/n1234ab/"
    });
    expect(narou.matchUrl(new URL("https://ncode.syosetu.com/search/"))).toBeNull();
    expect(narou.matchUrl(new URL("https://syosetu.com/n1234ab/"))).toBeNull();
  });

  test("normalizes structured extraction, removes duplicates and rejects unsafe or excessive data", () => {
    const adapter = createKakuyomuAdapter();
    const identity = adapter.matchUrl(new URL("https://kakuyomu.jp/works/work-a/episodes/episode-1"))!;
    const toc = normalizeNovelViewerTocResult(adapter, identity, {
      complete: true,
      workTitle: "  Work   A  ",
      sections: [{
        title: " Part   One ",
        episodes: [
          { episodeId: "episode-1", title: " Episode   One ", canonicalUrl: "https://kakuyomu.jp/works/work-a/episodes/episode-1" },
          { episodeId: "episode-1", title: "Duplicate", canonicalUrl: "https://kakuyomu.jp/works/work-a/episodes/episode-1" },
          { episodeId: "external", title: "External", canonicalUrl: "https://example.com/works/work-a/episodes/external" },
          { episodeId: "wrong", title: "Wrong work", canonicalUrl: "https://kakuyomu.jp/works/work-b/episodes/wrong" },
          { episodeId: "empty", title: " ", canonicalUrl: "https://kakuyomu.jp/works/work-a/episodes/empty" },
          { episodeId: "malformed", title: "Malformed", canonicalUrl: "not a URL" }
        ]
      }]
    });
    expect(toc.workTitle).toBe("Work A");
    expect(toc.sections).toHaveLength(1);
    expect(toc.sections[0].title).toBe("Part One");
    expect(toc.sections[0].episodes).toEqual([{
      episodeId: "episode-1",
      order: 0,
      title: "Episode One",
      canonicalUrl: "https://kakuyomu.jp/works/work-a/episodes/episode-1"
    }]);
    expect(() => normalizeNovelViewerTocResult(adapter, identity, { complete: false, workTitle: "Work", sections: [] })).toThrow();
    expect(() => normalizeNovelViewerTocResult(adapter, identity, {
      complete: true,
      workTitle: "Work",
      sections: [{ episodes: [{
        episodeId: "too-long",
        title: "x".repeat(501),
        canonicalUrl: "https://kakuyomu.jp/works/work-a/episodes/too-long"
      }] }]
    })).toThrow(/title-too-long/);
    expect(() => normalizeNovelViewerTocResult(adapter, identity, {
      complete: true,
      workTitle: "Work",
      sections: [{ episodes: Array.from({ length: 5_001 }, (_, index) => ({
        episodeId: String(index),
        title: "Episode",
        canonicalUrl: `https://kakuyomu.jp/works/work-a/episodes/${index}`
      })) }]
    })).toThrow(/too-many-episodes/);
  });
});

test.describe("Novel Viewer TOC cache and request generations", () => {
  test("persists clamped Novel Viewer layout without breaking legacy Reader state", async ({}, testInfo) => {
    expect(normalizeReaderState(defaultReaderState)).toEqual(defaultReaderState);
    const normalized = normalizeReaderState({
      ...defaultReaderState,
      ui: {
        ...defaultReaderState.ui,
        tocWidthPx: NOVEL_VIEWER_TOC_WIDTH_MAX + 100,
        novelViewerSplitRatio: 2
      }
    });
    expect(normalized.ui.tocWidthPx).toBe(NOVEL_VIEWER_TOC_WIDTH_MAX);
    expect(normalized.ui.novelViewerSplitRatio).toBe(NOVEL_VIEWER_SPLIT_RATIO_MAX);
    expect(normalizeReaderState({
      ...defaultReaderState,
      ui: {
        ...defaultReaderState.ui,
        tocWidthPx: -100,
        novelViewerSplitRatio: -1
      }
    }).ui).toMatchObject({
      tocWidthPx: NOVEL_VIEWER_TOC_WIDTH_MIN,
      novelViewerSplitRatio: NOVEL_VIEWER_SPLIT_RATIO_MIN
    });
    expect(() => normalizeReaderState({
      ...defaultReaderState,
      ui: { ...defaultReaderState.ui, tocWidthPx: Number.NaN }
    })).toThrow(/tocWidthPx/);

    const filePath = path.join(testInfo.outputDir, "reader", "state.json");
    const store = new ReaderStateStore(filePath);
    await store.load();
    await store.save({
      ...defaultReaderState,
      ui: {
        ...defaultReaderState.ui,
        tocWidthPx: 340,
        novelViewerSplitRatio: 0.6
      }
    });
    const reloaded = new ReaderStateStore(filePath);
    const result = await reloaded.load();
    expect(result.ok).toBe(true);
    expect(result.state.ui).toMatchObject({ tocWidthPx: 340, novelViewerSplitRatio: 0.6 });
  });

  test("applies TTL, adapter-version and current-episode staleness with atomic serialized writes", async ({}, testInfo) => {
    let now = new Date("2026-07-15T00:00:00.000Z");
    const filePath = path.join(testInfo.outputDir, "reader", "toc-cache.json");
    const cache = new NovelViewerTocCache(filePath, () => now);
    const toc = makeToc("work-a", now.toISOString());
    await Promise.all([cache.put(toc), cache.put(makeToc("work-b", now.toISOString()))]);
    expect((await cache.get("kakuyomu", "work-a", 1, "episode-1"))?.fresh).toBe(true);
    expect((await cache.get("kakuyomu", "work-a", 2, "episode-1"))?.staleReason).toBe("adapter-version");
    expect((await cache.get("kakuyomu", "work-a", 1, "missing"))?.staleReason).toBe("episode-missing");
    now = new Date(now.getTime() + NOVEL_VIEWER_TOC_CACHE_TTL_MS);
    expect((await cache.get("kakuyomu", "work-a", 1, "episode-1"))?.staleReason).toBe("ttl");
    await cache.waitForIdle();
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as { entries: unknown[] };
    expect(parsed.entries).toHaveLength(2);
    expect((await readdir(path.dirname(filePath))).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  test("serializes cache mutations and bounds Windows rename lock retries without damaging the target", async ({}, testInfo) => {
    const readerDir = path.join(testInfo.outputDir, "reader");
    const retryPath = path.join(readerDir, "toc-cache.json");
    const retryDelays: number[] = [];
    let retryAttempts = 0;
    const retryCache = new NovelViewerTocCache(retryPath, () => new Date("2026-07-15T00:00:00.000Z"), {
      renameFile: async (source, destination) => {
        retryAttempts += 1;
        if (retryAttempts < 3) throw fileSystemError("EPERM");
        await rename(source, destination);
      },
      delay: async (milliseconds) => { retryDelays.push(milliseconds); }
    });
    await retryCache.put(makeToc("retry-success", "2026-07-15T00:00:00.000Z"));
    expect(retryAttempts).toBe(3);
    expect(retryDelays).toEqual(NOVEL_VIEWER_TOC_CACHE_RENAME_RETRY_DELAYS_MS.slice(0, 2));
    expect(JSON.parse(await readFile(retryPath, "utf8"))).toMatchObject({ schemaVersion: 1 });

    const serializedPath = path.join(testInfo.outputDir, "serialized", "toc-cache.json");
    const serializedCache = new NovelViewerTocCache(serializedPath);
    await Promise.all(Array.from({ length: 12 }, (_, index) => serializedCache.put(
      makeToc(`parallel-${index}`, new Date(Date.now() + index).toISOString())
    )));
    await serializedCache.waitForIdle();
    const serializedFile = JSON.parse(await readFile(serializedPath, "utf8")) as { entries: unknown[] };
    expect(serializedFile.entries).toHaveLength(12);
    expect((await readdir(path.dirname(serializedPath))).some((name) => name.includes(".tmp-"))).toBe(false);

    const baseline = await readFile(retryPath, "utf8");
    let nonRetryableAttempts = 0;
    const nonRetryableCache = new NovelViewerTocCache(retryPath, () => new Date("2026-07-15T01:00:00.000Z"), {
      renameFile: async () => {
        nonRetryableAttempts += 1;
        throw fileSystemError("ENOSPC");
      },
      delay: async () => { throw new Error("non-retryable errors must not wait"); }
    });
    await expect(nonRetryableCache.put(makeToc("no-retry", "2026-07-15T01:00:00.000Z"))).rejects.toMatchObject({ code: "ENOSPC" });
    expect(nonRetryableAttempts).toBe(1);
    expect(await readFile(retryPath, "utf8")).toBe(baseline);
    expect((await nonRetryableCache.snapshot()).entries.map((entry) => entry.workId)).toEqual(["retry-success"]);

    const exhaustedDelays: number[] = [];
    let exhaustedAttempts = 0;
    const exhaustedCache = new NovelViewerTocCache(retryPath, () => new Date("2026-07-15T02:00:00.000Z"), {
      renameFile: async () => {
        exhaustedAttempts += 1;
        throw fileSystemError("EBUSY");
      },
      delay: async (milliseconds) => { exhaustedDelays.push(milliseconds); }
    });
    await expect(exhaustedCache.put(makeToc("retry-exhausted", "2026-07-15T02:00:00.000Z"))).rejects.toMatchObject({ code: "EBUSY" });
    expect(exhaustedAttempts).toBe(NOVEL_VIEWER_TOC_CACHE_RENAME_RETRY_DELAYS_MS.length + 1);
    expect(exhaustedDelays).toEqual([...NOVEL_VIEWER_TOC_CACHE_RENAME_RETRY_DELAYS_MS]);
    expect(await readFile(retryPath, "utf8")).toBe(baseline);
    expect((await exhaustedCache.snapshot()).entries.map((entry) => entry.workId)).toEqual(["retry-success"]);
    expect((await readdir(readerDir)).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  test("cleans stale temporary files and waits for pending writes during TOC service disposal", async ({}, testInfo) => {
    const readerDir = path.join(testInfo.outputDir, "reader");
    const filePath = path.join(readerDir, "toc-cache.json");
    const staleTemporaryPath = `${filePath}.tmp-stale`;
    await mkdir(readerDir, { recursive: true });
    await writeFile(staleTemporaryPath, "stale", "utf8");
    const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    await utimes(staleTemporaryPath, oldTime, oldTime);

    let releaseRename: (() => void) | undefined;
    const renameRelease = new Promise<void>((resolve) => { releaseRename = resolve; });
    let signalRenameStarted: (() => void) | undefined;
    const renameStarted = new Promise<void>((resolve) => { signalRenameStarted = resolve; });
    const cache = new NovelViewerTocCache(filePath, () => new Date("2026-07-15T00:00:00.000Z"), {
      renameFile: async (source, destination) => {
        signalRenameStarted?.();
        await renameRelease;
        await rename(source, destination);
      }
    });
    const putPromise = cache.put(makeToc("pending", "2026-07-15T00:00:00.000Z"));
    await renameStarted;
    const service = new NovelViewerTocService(cache, () => undefined);
    let disposalFinished = false;
    const disposalPromise = service.dispose().then(() => { disposalFinished = true; });
    await Promise.resolve();
    expect(disposalFinished).toBe(false);
    releaseRename?.();
    await Promise.all([putPromise, disposalPromise]);
    expect(disposalFinished).toBe(true);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ schemaVersion: 1 });
    expect((await readdir(readerDir)).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  test("enforces LRU and file limits, preserves corrupt input, and never touches Reader state", async ({}, testInfo) => {
    let tick = Date.parse("2026-07-15T00:00:00.000Z");
    const readerDir = path.join(testInfo.outputDir, "reader");
    const filePath = path.join(readerDir, "toc-cache.json");
    const readerStatePath = path.join(readerDir, "state.json");
    await mkdir(readerDir, { recursive: true });
    await writeFile(filePath, "{broken cache\n", "utf8");
    const cache = new NovelViewerTocCache(filePath, () => new Date(tick++));
    expect((await cache.snapshot()).entries).toEqual([]);
    await Promise.all([
      cache.put(makeToc("recovered", new Date(tick).toISOString())),
      cache.put(makeToc("recovered-second", new Date(tick + 1).toISOString()))
    ]);
    const recoveredNames = await readdir(readerDir);
    expect(recoveredNames.filter((name) => name.startsWith("toc-cache.json.corrupt-"))).toHaveLength(1);
    expect(recoveredNames.some((name) => name.includes(".tmp-"))).toBe(false);
    expect((await cache.snapshot()).entries.map((entry) => entry.workId)).toEqual(["recovered", "recovered-second"]);
    await expect(readFile(readerStatePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    for (let index = 0; index < 51; index += 1) {
      await cache.put(makeToc(`lru-${index}`, new Date(tick).toISOString()));
    }
    expect((await cache.snapshot()).entries).toHaveLength(50);
    const largeCachePath = path.join(testInfo.outputDir, "large", "toc-cache.json");
    const largeCache = new NovelViewerTocCache(largeCachePath, () => new Date(tick++));
    for (let index = 0; index < 3; index += 1) {
      await largeCache.put(makeToc(`large-${index}`, new Date(tick).toISOString(), 3_000, 500));
    }
    const largePayload = await readFile(largeCachePath, "utf8");
    expect(Buffer.byteLength(largePayload)).toBeLessThanOrEqual(NOVEL_VIEWER_TOC_CACHE_MAX_BYTES);
    expect((await largeCache.snapshot()).entries.length).toBeLessThan(3);
  });

  test("keeps stale cache on failure and ignores a result after navigation changes", async ({}, testInfo) => {
    const cachePath = path.join(testInfo.outputDir, "reader", "toc-cache.json");
    const oldTime = new Date(Date.now() - NOVEL_VIEWER_TOC_CACHE_TTL_MS - 1_000).toISOString();
    const cache = new NovelViewerTocCache(cachePath);
    await cache.put(makeToc("work-a", oldTime));
    const emitted: string[] = [];
    const failingContents = {
      isDestroyed: () => false,
      executeJavaScriptInIsolatedWorld: async () => { throw new Error("fixture fetch failed"); }
    } as unknown as Electron.WebContents;
    const staleService = new NovelViewerTocService(cache, (state) => emitted.push(state.status));
    const staleState = await staleService.open(
      failingContents,
      "https://kakuyomu.jp/works/work-a/episodes/episode-1",
      1
    );
    expect(emitted).toContain("stale");
    expect(staleState.status).toBe("stale");
    expect(staleState.sections[0].episodes).toHaveLength(2);
    expect(staleState.error).toBeDefined();
    expect((await cache.get("kakuyomu", "work-a", 1))?.toc.fetchedAt).toBe(oldTime);

    let resolveExtraction: (() => void) | undefined;
    const extractionStarted = new Promise<void>((resolve) => {
      resolveExtraction = resolve;
    });
    let releaseResult: ((value: unknown) => void) | undefined;
    const pendingResult = new Promise<unknown>((resolve) => { releaseResult = resolve; });
    const pendingContents = {
      isDestroyed: () => false,
      executeJavaScriptInIsolatedWorld: () => {
        resolveExtraction?.();
        return pendingResult;
      }
    } as unknown as Electron.WebContents;
    const raceCache = new NovelViewerTocCache(path.join(testInfo.outputDir, "race", "toc-cache.json"));
    const raceService = new NovelViewerTocService(raceCache, () => undefined);
    const openPromise = raceService.open(
      pendingContents,
      "https://kakuyomu.jp/works/work-a/episodes/episode-1",
      1
    );
    await extractionStarted;
    raceService.setLocation("https://kakuyomu.jp/works/work-b/episodes/episode-1", 2);
    releaseResult?.({
      complete: true,
      workTitle: "Work A",
      sections: [{ episodes: [{
        episodeId: "episode-1",
        title: "Episode One",
        canonicalUrl: "https://kakuyomu.jp/works/work-a/episodes/episode-1"
      }] }]
    });
    await openPromise;
    expect((await raceCache.snapshot()).entries.some((entry) => entry.workId === "work-a")).toBe(false);
    expect(raceService.state.workId).toBe("work-b");
  });

  test("consolidates same-work fetches and lets a newer manual refresh supersede the old result", async ({}, testInfo) => {
    const rawResult = (workTitle: string) => ({
      complete: true,
      workTitle,
      sections: [{ episodes: [{
        episodeId: "episode-1",
        title: "Episode One",
        canonicalUrl: "https://kakuyomu.jp/works/work-a/episodes/episode-1"
      }] }]
    });
    let startFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { startFirst = resolve; });
    let releaseFirst: ((value: unknown) => void) | undefined;
    const firstResult = new Promise<unknown>((resolve) => { releaseFirst = resolve; });
    let extractionCalls = 0;
    const contents = {
      isDestroyed: () => false,
      executeJavaScriptInIsolatedWorld: (_worldId: number, sources: Array<{ code: string }>) => {
        if (sources[0]?.code.includes("return count")) return Promise.resolve(0);
        extractionCalls += 1;
        startFirst?.();
        return firstResult;
      }
    } as unknown as Electron.WebContents;
    const cache = new NovelViewerTocCache(path.join(testInfo.outputDir, "dedupe", "toc-cache.json"));
    const service = new NovelViewerTocService(cache, () => undefined);
    const firstOpen = service.open(contents, "https://kakuyomu.jp/works/work-a/episodes/episode-1", 1);
    await firstStarted;
    const secondOpen = service.open(contents, "https://kakuyomu.jp/works/work-a/episodes/episode-1", 1);
    releaseFirst?.(rawResult("Original Work"));
    await Promise.all([firstOpen, secondOpen]);
    expect(extractionCalls).toBe(1);
    expect(service.state.workTitle).toBe("Original Work");

    let releaseOldRefresh: ((value: unknown) => void) | undefined;
    const oldRefreshResult = new Promise<unknown>((resolve) => { releaseOldRefresh = resolve; });
    let refreshCalls = 0;
    const refreshContents = {
      isDestroyed: () => false,
      executeJavaScriptInIsolatedWorld: (_worldId: number, sources: Array<{ code: string }>) => {
        if (sources[0]?.code.includes("return count")) return Promise.resolve(1);
        refreshCalls += 1;
        return refreshCalls === 1 ? oldRefreshResult : Promise.resolve(rawResult("Newest Work"));
      }
    } as unknown as Electron.WebContents;
    const refreshCache = new NovelViewerTocCache(path.join(testInfo.outputDir, "refresh", "toc-cache.json"));
    await refreshCache.put(makeToc(
      "work-a",
      new Date(Date.now() - NOVEL_VIEWER_TOC_CACHE_TTL_MS - 1_000).toISOString()
    ));
    const refreshService = new NovelViewerTocService(refreshCache, () => undefined);
    const oldRefresh = refreshService.open(refreshContents, "https://kakuyomu.jp/works/work-a/episodes/episode-1", 1);
    await expect.poll(() => refreshCalls).toBe(1);
    const newRefresh = refreshService.refresh(refreshContents, "https://kakuyomu.jp/works/work-a/episodes/episode-1", 1);
    await newRefresh;
    releaseOldRefresh?.(rawResult("Obsolete Work"));
    await oldRefresh;
    expect(refreshService.state.workTitle).toBe("Newest Work");
    expect((await refreshCache.get("kakuyomu", "work-a", 1))?.toc.workTitle).toBe("Newest Work");
  });
});

test.describe("Novel Viewer TOC Side Panel", () => {
  test("synchronizes the remote viewport and bounds narrow fixed-width content without stale zoom", async ({}, testInfo) => {
    const { app, page } = await launchTocApp(testInfo);
    try {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(760, 720));
      await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V");
      await expect(page.getByTestId("novel-viewer-pane")).toBeVisible();
      const fixtureUrl = "novel-reader-test://fixture/viewport-wide";
      await page.locator("#novel-viewer-address").fill(fixtureUrl);
      await page.locator("#novel-viewer-address").press("Enter");
      await expect.poll(() => page.locator("#novel-viewer-address").inputValue()).toBe(fixtureUrl);
      await observeReaderResizeEvents(app);
      await expect.poll(async () => {
        return viewportFitDiagnostic(await readerViewSnapshot(app));
      }).toMatchObject({ ready: true });
      console.log("Novel Viewer narrow viewport:", viewportFitDiagnostic(await readerViewSnapshot(app)));

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1_600, 820));
      const mainSplitResizer = page.locator("#split-resizer");
      await expect(mainSplitResizer).toBeVisible();
      await mainSplitResizer.focus();
      await mainSplitResizer.press("Home");
      await expect.poll(async () => {
        const snapshot = await readerViewSnapshot(app);
        return {
          ready: snapshot.zoomFactor === 1 &&
            Math.abs(snapshot.viewportWidth - snapshot.bounds.width) <= 2 &&
            Math.abs(snapshot.viewportHeight - snapshot.bounds.height) <= 2 &&
            snapshot.documentWidth <= snapshot.viewportWidth + 2 &&
            snapshot.resizeEvents > 0,
          zoomFactor: snapshot.zoomFactor,
          documentWidth: snapshot.documentWidth,
          boundsWidth: snapshot.bounds.width,
          viewportWidth: snapshot.viewportWidth,
          viewportHeight: snapshot.viewportHeight,
          narrow: snapshot.zoomFactor < 0.99,
          capturedAt: new Date().toISOString()
        };
      }).toMatchObject({ ready: true });
      console.log("Novel Viewer normal viewport:", viewportFitDiagnostic(await readerViewSnapshot(app)));

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(760, 720));
      await expect.poll(async () => {
        return viewportFitDiagnostic(await readerViewSnapshot(app));
      }).toMatchObject({ ready: true });
      console.log("Novel Viewer restored narrow viewport:", viewportFitDiagnostic(await readerViewSnapshot(app)));
    } finally {
      await closeApp(app);
    }
  });

  test("stores work-level favorites, reopens the work page, and keeps narrow controls usable", async ({}, testInfo) => {
    const { app, page, userDataDir } = await launchTocApp(testInfo);
    try {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(760, 720));
      await openViewerAt(page, kakuyomuEpisodeOne);
      await observeReaderResizeEvents(app);
      const initialViewport = await readerViewSnapshot(app);
      expect(Math.abs(initialViewport.viewportWidth - initialViewport.bounds.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(initialViewport.viewportHeight - initialViewport.bounds.height)).toBeLessThanOrEqual(2);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1_600, 820));
      await expect.poll(async () => {
        const snapshot = await readerViewSnapshot(app);
        return Math.abs(snapshot.viewportWidth - snapshot.bounds.width) <= 2 &&
          Math.abs(snapshot.viewportHeight - snapshot.bounds.height) <= 2 &&
          snapshot.resizeEvents > 0 && snapshot.bounds.width > initialViewport.bounds.width;
      }).toBe(true);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(760, 720));
      await expect.poll(async () => {
        const snapshot = await readerViewSnapshot(app);
        return Math.abs(snapshot.viewportWidth - snapshot.bounds.width) <= 2 &&
          Math.abs(snapshot.viewportHeight - snapshot.bounds.height) <= 2 &&
          snapshot.bounds.width <= initialViewport.bounds.width + 2;
      }).toBe(true);
      await expect(page.locator("#novel-viewer-favorites")).toBeVisible();
      await expect(page.locator("#novel-viewer-favorites")).toHaveText("☆");
      expect(await page.locator(".novel-viewer-header").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect((await page.locator("#novel-viewer-address").boundingBox())?.width ?? 0).toBeGreaterThan(30);

      await page.locator("#novel-viewer-favorites").click();
      await expect(page.locator(".novel-viewer-favorites-dialog")).toBeVisible();
      await page.locator('[data-favorite-action="toggle"]').click();
      await expect(page.locator("#novel-viewer-favorites")).toHaveText("★");
      await expect(page.locator(".novel-viewer-favorite-row")).toHaveCount(1);

      const expectedWorkUrl = "novel-reader-test://fixture/toc/kakuyomu/works/work-alpha";
      const readerStatePath = path.join(userDataDir, "reader", "state.json");
      await expect.poll(async () => {
        const saved = JSON.parse(await readFile(readerStatePath, "utf8")) as {
          favorites?: Array<{ canonicalWorkUrl?: string }>;
        };
        return saved.favorites?.map((entry) => entry.canonicalWorkUrl) ?? [];
      }).toEqual([expectedWorkUrl]);

      await page.locator('[data-favorite-action="open"]').click();
      await expect(page.locator(".novel-viewer-favorites-dialog")).toBeHidden();
      await expect.poll(() => page.locator("#novel-viewer-address").inputValue()).toBe(expectedWorkUrl);
      await expect(page.locator("#novel-viewer-favorites")).toHaveText("★");

      await page.locator("#novel-viewer-toc").click();
      await expect(page.locator("#novel-viewer-content")).toHaveClass(/is-toc-narrow/);
      await expect(page.locator("#novel-viewer-toc-panel")).toBeVisible();
      await page.locator("#novel-viewer-toc-close").click();
      await expect.poll(async () => (await readerViewSnapshot(app)).visible).toBe(true);

      await page.locator("#novel-viewer-favorites").click();
      await page.locator('[data-favorite-action="remove"]').click();
      await expect(page.locator(".novel-viewer-favorite-row")).toHaveCount(0);
      await expect(page.locator("#novel-viewer-favorites")).toHaveText("☆");
      await expect.poll(async () => {
        const saved = JSON.parse(await readFile(readerStatePath, "utf8")) as { favorites?: unknown[] };
        return saved.favorites?.length ?? -1;
      }).toBe(0);
    } finally {
      await closeApp(app);
    }
  });

  test("migrates and opens a legacy slash-suffixed Kakuyomu favorite", async ({}, testInfo) => {
    const legacyWorkUrl = "novel-reader-test://fixture/toc/kakuyomu/works/work-alpha/";
    const canonicalWorkUrl = "novel-reader-test://fixture/toc/kakuyomu/works/work-alpha";
    const { app, page, userDataDir } = await launchTocApp(testInfo, async (directory) => {
      const readerDirectory = path.join(directory, "reader");
      await mkdir(readerDirectory, { recursive: true });
      await writeFile(path.join(readerDirectory, "state.json"), `${JSON.stringify({
        ...defaultReaderState,
        favorites: [{
          adapterId: "kakuyomu",
          workId: "work-alpha",
          canonicalWorkUrl: legacyWorkUrl,
          workTitle: "Legacy Fixture Work",
          addedAt: "2026-01-01T00:00:00.000Z"
        }]
      }, null, 2)}\n`, "utf8");
    });
    try {
      await openViewerAt(page, kakuyomuEpisodeTwo);
      await expect(page.locator("#novel-viewer-favorites")).toHaveText("★");
      await page.locator("#novel-viewer-favorites").click();
      await expect(page.locator(".novel-viewer-favorite-row")).toHaveCount(1);
      await page.locator('[data-favorite-action="open"]').click();
      await expect.poll(() => page.locator("#novel-viewer-address").inputValue()).toBe(canonicalWorkUrl);
      await expect.poll(async () => {
        const saved = JSON.parse(await readFile(path.join(userDataDir, "reader", "state.json"), "utf8")) as {
          favorites?: Array<{ canonicalWorkUrl?: string }>;
        };
        return saved.favorites?.[0]?.canonicalWorkUrl;
      }).toBe(canonicalWorkUrl);
    } finally {
      await closeApp(app);
    }
  });

  test("loads Kakuyomu fixture, resizes independent split boundaries, and navigates by episode identity", async ({}, testInfo) => {
    const { app, page, userDataDir } = await launchTocApp(testInfo);
    try {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1_800, 900));
      await openViewerAt(page, kakuyomuEpisodeOne);
      const workspacePath = path.join(userDataDir, "data", "workspace.json");
      const workspaceBefore = await readFile(workspacePath, "utf8").then(
        (value) => (JSON.parse(value) as { layout?: { splitRatio?: number } }).layout?.splitRatio ?? null,
        () => null
      );
      const logPath = path.join(userDataDir, "reader", "novel-viewer-debug.log");
      const beforeOpenLog = await readFile(logPath, "utf8");
      expect(beforeOpenLog).not.toContain("toc-fetch-start");
      await expect(readFile(path.join(userDataDir, "reader", "toc-cache.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      await setReaderScroll(app, 700);
      const beforeWide = await readerViewSnapshot(app);
      await page.evaluate(() => {
        const original = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function scrollIntoView(options?: boolean | ScrollIntoViewOptions): void {
          if (this instanceof HTMLElement && this.matches(".novel-viewer-toc-episode")) {
            (window as unknown as { __tocScrolledEpisode?: string }).__tocScrolledEpisode = this.dataset.episodeId;
            return;
          }
          original.call(this, options);
        };
      });
      await page.locator("#novel-viewer-toc").click();
      await expect(page.locator("#novel-viewer-toc-panel")).toBeVisible();
      await expect(page.locator("#novel-viewer-content")).toHaveClass(/is-toc-wide/);
      await expect(page.locator("#novel-viewer-toc-resizer")).toBeVisible();
      expect(Math.round((await page.locator("#novel-viewer-toc-panel").boundingBox())?.width ?? 0))
        .toBe(NOVEL_VIEWER_TOC_WIDTH_DEFAULT);
      await expect(page.locator(".novel-viewer-toc-work-title")).toHaveText("Fixture Kakuyomu Work");
      await expect(page.locator(".novel-viewer-toc-section-title")).toHaveText("Part One");
      await expect(page.locator(".novel-viewer-toc-episode")).toHaveCount(2);
      expect(await page.locator("#novel-viewer-toc-list").evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
      await expect(page.locator('.novel-viewer-toc-episode[data-episode-id="episode-1"]')).toHaveAttribute("aria-current", "page");
      await expect.poll(() => page.evaluate(() => (window as unknown as { __tocScrolledEpisode?: string }).__tocScrolledEpisode)).toBe("episode-1");
      await expect(page.locator('.novel-viewer-toc-episode[data-episode-id="episode-2"]')).toHaveText("<img src=x onerror=window.__tocInjected=true>");
      await expect(page.locator('.novel-viewer-toc-episode[data-episode-id="episode-2"]'))
        .toHaveAttribute("title", "<img src=x onerror=window.__tocInjected=true>");
      expect(await page.evaluate(() => (window as unknown as { __tocInjected?: boolean }).__tocInjected)).toBeUndefined();
      const wide = await readerViewSnapshot(app);
      expect(wide.id).toBe(beforeWide.id);
      expect(wide.url).toBe(beforeWide.url);
      expect(wide.bounds.width).toBeLessThan(beforeWide.bounds.width);
      expect(wide.scrollY).toBe(beforeWide.scrollY);

      await dragSeparatorBy(page, "#novel-viewer-toc-resizer", 70);
      await expect.poll(async () => Math.round((await page.locator("#novel-viewer-toc-panel").boundingBox())?.width ?? 0))
        .toBe(NOVEL_VIEWER_TOC_WIDTH_DEFAULT + 70);
      await expect.poll(async () => (await readerViewSnapshot(app)).visible).toBe(true);
      const afterTocGrow = await readerViewSnapshot(app);
      expect(afterTocGrow.id).toBe(wide.id);
      expect(afterTocGrow.url).toBe(wide.url);
      expect(afterTocGrow.scrollY).toBe(wide.scrollY);
      expect(afterTocGrow.bounds.width).toBeLessThan(wide.bounds.width);

      await dragSeparatorBy(page, "#novel-viewer-toc-resizer", 2_000);
      await expect.poll(async () => Math.round((await page.locator("#novel-viewer-toc-panel").boundingBox())?.width ?? 0))
        .toBe(NOVEL_VIEWER_TOC_WIDTH_MAX);
      await dragSeparatorBy(page, "#novel-viewer-toc-resizer", -2_000);
      await expect.poll(async () => Math.round((await page.locator("#novel-viewer-toc-panel").boundingBox())?.width ?? 0))
        .toBe(NOVEL_VIEWER_TOC_WIDTH_MIN);
      await dragSeparatorBy(page, "#novel-viewer-toc-resizer", 120);
      const savedTocWidth = NOVEL_VIEWER_TOC_WIDTH_MIN + 120;
      await page.locator("#novel-viewer-toc-close").click();
      await page.locator("#novel-viewer-toc").click();
      await expect.poll(async () => Math.round((await page.locator("#novel-viewer-toc-panel").boundingBox())?.width ?? 0))
        .toBe(savedTocWidth);

      const tocWidthBeforeMainSplit = Math.round((await page.locator("#novel-viewer-toc-panel").boundingBox())?.width ?? 0);
      const editorBeforeMainSplit = await page.locator('section.editor-pane[data-pane-id="left"]').boundingBox();
      const viewerBeforeMainSplit = await page.locator("#novel-viewer-pane").boundingBox();
      expect((editorBeforeMainSplit?.width ?? 0) /
        Math.max(1, (editorBeforeMainSplit?.width ?? 0) + (viewerBeforeMainSplit?.width ?? 0)))
        .toBeCloseTo(NOVEL_VIEWER_SPLIT_RATIO_DEFAULT, 1);
      const remoteBeforeMainSplit = await readerViewSnapshot(app);
      await dragSeparatorBy(page, "#split-resizer", 70);
      await expect.poll(async () => (await readerViewSnapshot(app)).visible).toBe(true);
      const editorAfterGrow = await page.locator('section.editor-pane[data-pane-id="left"]').boundingBox();
      const viewerAfterShrink = await page.locator("#novel-viewer-pane").boundingBox();
      const remoteAfterMainSplit = await readerViewSnapshot(app);
      expect((editorAfterGrow?.width ?? 0)).toBeGreaterThan(editorBeforeMainSplit?.width ?? 0);
      expect((viewerAfterShrink?.width ?? 0)).toBeLessThan(viewerBeforeMainSplit?.width ?? 0);
      expect(remoteAfterMainSplit.id).toBe(remoteBeforeMainSplit.id);
      expect(remoteAfterMainSplit.url).toBe(remoteBeforeMainSplit.url);
      expect(remoteAfterMainSplit.scrollY).toBe(remoteBeforeMainSplit.scrollY);
      expect(remoteAfterMainSplit.bounds.width).toBeLessThan(remoteBeforeMainSplit.bounds.width);
      expect(Math.abs(remoteAfterMainSplit.viewportWidth - remoteAfterMainSplit.bounds.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(remoteAfterMainSplit.viewportHeight - remoteAfterMainSplit.bounds.height)).toBeLessThanOrEqual(2);
      expect(Math.round((await page.locator("#novel-viewer-toc-panel").boundingBox())?.width ?? 0)).toBe(tocWidthBeforeMainSplit);
      await dragSeparatorBy(page, "#split-resizer", -140);
      const editorAfterShrink = await page.locator('section.editor-pane[data-pane-id="left"]').boundingBox();
      const viewerAfterGrow = await page.locator("#novel-viewer-pane").boundingBox();
      expect((editorAfterShrink?.width ?? 0)).toBeLessThan(editorAfterGrow?.width ?? 0);
      expect((viewerAfterGrow?.width ?? 0)).toBeGreaterThan(viewerAfterShrink?.width ?? 0);
      expect(Math.round((await page.locator("#novel-viewer-toc-panel").boundingBox())?.width ?? 0)).toBe(tocWidthBeforeMainSplit);

      await page.locator("#novel-viewer-toc-refresh").click();
      await expect.poll(async () => (await readFile(logPath, "utf8")).match(/toc-fetch-success/g)?.length ?? 0).toBe(2);
      await expect(page.locator(".novel-viewer-toc-episode")).toHaveCount(2);
      await page.locator('.novel-viewer-toc-episode[data-episode-id="episode-2"]').click();
      await expect.poll(() => page.locator("#novel-viewer-address").inputValue()).toBe(kakuyomuEpisodeTwo);
      await expect(page.locator("#novel-viewer-toc-panel")).toBeVisible();
      await expect(page.locator('.novel-viewer-toc-episode[data-episode-id="episode-2"]')).toHaveAttribute("aria-current", "page");
      const afterSelection = await readerViewSnapshot(app);
      expect(afterSelection.id).toBe(beforeWide.id);
      const rejected = await page.evaluate(async () => {
        try {
          await window.textEditor.selectNovelViewerTocEpisode({ adapterId: "kakuyomu", workId: "work-alpha", episodeId: "unknown" });
          return false;
        } catch {
          return true;
        }
      });
      expect(rejected).toBe(true);
      await expect(page.locator("#novel-viewer-address")).toHaveValue(kakuyomuEpisodeTwo);
      expect(await app.evaluate(({ session, webContents }) => {
        const readerSession = session.fromPartition("novel-viewer-reader");
        const reader = webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && contents.session === readerSession);
        return reader?.executeJavaScript("typeof window.textEditor");
      })).toBe("undefined");
      expect(await page.evaluate(async () => {
        try {
          await window.textEditor.updateNovelViewerUiLayout({ tocWidthPx: Number.NaN });
          return false;
        } catch {
          return true;
        }
      })).toBe(true);

      await page.locator("#novel-viewer-toc-close").click();
      await expect(page.locator("#novel-viewer-toc-panel")).toBeHidden();
      await dragSeparatorBy(page, "#split-resizer", 2_000);
      expect((await page.locator("#novel-viewer-pane").boundingBox())?.width ?? 0)
        .toBeGreaterThanOrEqual(NOVEL_VIEWER_PANE_MIN_WIDTH - 1);
      await dragSeparatorBy(page, "#split-resizer", -2_000);
      expect((await page.locator('section.editor-pane[data-pane-id="left"]').boundingBox())?.width ?? 0)
        .toBeGreaterThanOrEqual(NOVEL_VIEWER_EDITOR_MIN_WIDTH - 1);
      const splitBox = await page.locator("#editor-split").boundingBox();
      const resizerBox = await page.locator("#split-resizer").boundingBox();
      if (!splitBox || !resizerBox) throw new Error("Novel Viewer split geometry is unavailable");
      await dragSeparatorBy(
        page,
        "#split-resizer",
        splitBox.x + (splitBox.width - resizerBox.width) * NOVEL_VIEWER_SPLIT_RATIO_DEFAULT -
          (resizerBox.x + resizerBox.width / 2)
      );
      const readerStatePath = path.join(userDataDir, "reader", "state.json");
      await expect.poll(async () => {
        const state = JSON.parse(await readFile(readerStatePath, "utf8")) as {
          ui?: { tocWidthPx?: number; novelViewerSplitRatio?: number };
        };
        return state.ui?.tocWidthPx === savedTocWidth &&
          Math.abs((state.ui?.novelViewerSplitRatio ?? 0) - NOVEL_VIEWER_SPLIT_RATIO_DEFAULT) < 0.01;
      }).toBe(true);

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(760, 760));
      await setReaderScroll(app, 900);
      const beforeNarrow = await readerViewSnapshot(app);
      await page.locator("#novel-viewer-toc").click();
      await expect(page.locator("#novel-viewer-content")).toHaveClass(/is-toc-narrow/);
      await expect(page.locator("#novel-viewer-toc-resizer")).toBeHidden();
      await expect.poll(async () => (await readerViewSnapshot(app)).visible).toBe(false);
      const hidden = await readerViewSnapshot(app);
      expect(hidden.id).toBe(beforeNarrow.id);
      expect(hidden.bounds).toMatchObject({ width: 0, height: 0 });
      await page.locator("#novel-viewer-toc-close").click();
      await expect.poll(async () => (await readerViewSnapshot(app)).visible).toBe(true);
      const restored = await readerViewSnapshot(app);
      expect(restored.id).toBe(beforeNarrow.id);
      expect(restored.url).toBe(beforeNarrow.url);
      expect(restored.scrollY).toBe(beforeNarrow.scrollY);
      expect(restored.bounds.width).toBeGreaterThan(0);
      expect(Math.abs(restored.viewportWidth - restored.bounds.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(restored.viewportHeight - restored.bounds.height)).toBeLessThanOrEqual(2);
      await page.locator("#novel-viewer-toc").click();
      await expect(page.locator("#novel-viewer-content")).toHaveClass(/is-toc-narrow/);
      await page.locator('.novel-viewer-toc-episode[data-episode-id="episode-1"]').click();
      await expect(page.locator("#novel-viewer-toc-panel")).toBeHidden();
      await expect.poll(() => page.locator("#novel-viewer-address").inputValue()).toBe(kakuyomuEpisodeOne);
      expect((await readerViewSnapshot(app)).id).toBe(beforeNarrow.id);

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1_800, 900));
      await page.locator("#novel-viewer-close").click();
      await expect(page.getByTestId("novel-viewer-pane")).toBeHidden();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V");
      await expect(page.getByTestId("novel-viewer-pane")).toBeVisible();
      await expect(page.locator("#novel-viewer-toc")).toBeEnabled();
      await page.locator("#novel-viewer-toc").click();
      await expect(page.locator("#novel-viewer-content")).toHaveClass(/is-toc-wide/);
      await expect.poll(async () => Math.round((await page.locator("#novel-viewer-toc-panel").boundingBox())?.width ?? 0))
        .toBe(savedTocWidth);
      const reopenedSplit = await page.locator("#editor-split").boundingBox();
      const reopenedLeft = await page.locator('section.editor-pane[data-pane-id="left"]').boundingBox();
      expect((reopenedLeft?.width ?? 0) / Math.max(1, (reopenedSplit?.width ?? 1) - 5))
        .toBeCloseTo(NOVEL_VIEWER_SPLIT_RATIO_DEFAULT, 1);
      const workspaceAfter = await readFile(workspacePath, "utf8").then(
        (value) => (JSON.parse(value) as { layout?: { splitRatio?: number } }).layout?.splitRatio ?? null,
        () => null
      );
      expect(workspaceAfter).toBe(workspaceBefore);

      const cacheText = await readFile(path.join(userDataDir, "reader", "toc-cache.json"), "utf8");
      expect(cacheText).toContain("Fixture Kakuyomu Work");
      expect(cacheText).not.toMatch(/<html|<body/i);
      const diagnosticText = await readFile(logPath, "utf8");
      expect(diagnosticText).toContain("toc-fetch-success");
      expect(diagnosticText.match(/toc-fetch-start/g)).toHaveLength(2);
      expect(diagnosticText).not.toContain("<img src=x");
      expect(diagnosticText).not.toMatch(/<html|<body/i);
    } finally {
      await closeApp(app);
    }
  });

  test("extracts Narou chapters and keeps unsupported pages inert", async ({}, testInfo) => {
    const { app, page } = await launchTocApp(testInfo);
    try {
      await openViewerAt(page, narouEpisodeOne);
      await page.locator("#novel-viewer-toc").click();
      await expect(page.locator(".novel-viewer-toc-work-title")).toHaveText("Fixture Narou Work");
      await expect(page.locator(".novel-viewer-toc-section-title")).toHaveText("Opening Arc");
      await expect(page.locator(".novel-viewer-toc-episode")).toHaveCount(2);
      await expect(page.locator('.novel-viewer-toc-episode[data-episode-id="1"]')).toHaveAttribute("aria-current", "page");
      await page.locator("#novel-viewer-toc-close").click();
      await page.locator("#novel-viewer-address").fill("novel-reader-test://fixture/page-a");
      await page.locator("#novel-viewer-address").press("Enter");
      await expect.poll(() => page.locator("#novel-viewer-address").inputValue()).toBe("novel-reader-test://fixture/page-a");
      await expect(page.locator("#novel-viewer-toc")).toBeDisabled();
    } finally {
      await closeApp(app);
    }
  });

  test("restores persisted resize state and shows stale cache without failing the remote page", async ({}, testInfo) => {
    const oldTime = new Date(Date.now() - NOVEL_VIEWER_TOC_CACHE_TTL_MS - 1_000).toISOString();
    const staleToc: NovelViewerToc = {
      schemaVersion: 1,
      adapterId: "kakuyomu",
      adapterVersion: 1,
      workId: "work-fail",
      workTitle: "Retained Cached Work",
      canonicalWorkUrl: "novel-reader-test://fixture/toc/kakuyomu/works/work-fail",
      fetchedAt: oldTime,
      sections: [{
        order: 0,
        episodes: [{
          episodeId: "episode-1",
          order: 0,
          title: "Retained Episode",
          canonicalUrl: "novel-reader-test://fixture/toc/kakuyomu/works/work-fail/episodes/episode-1"
        }]
      }]
    };
    const { app, page } = await launchTocApp(testInfo, async (userDataDir) => {
      await new NovelViewerTocCache(path.join(userDataDir, "reader", "toc-cache.json")).put(staleToc);
      await writeFile(path.join(userDataDir, "reader", "state.json"), `${JSON.stringify({
        ...defaultReaderState,
        ui: {
          ...defaultReaderState.ui,
          tocWidthPx: 310,
          novelViewerSplitRatio: NOVEL_VIEWER_SPLIT_RATIO_DEFAULT
        }
      }, null, 2)}\n`, "utf8");
    });
    try {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1_800, 900));
      await openViewerAt(page, staleToc.sections[0].episodes[0].canonicalUrl);
      await page.locator("#novel-viewer-toc").click();
      await expect(page.locator("#novel-viewer-content")).toHaveClass(/is-toc-wide/);
      await expect.poll(async () => Math.round((await page.locator("#novel-viewer-toc-panel").boundingBox())?.width ?? 0))
        .toBe(310);
      const restoredSplit = await page.locator("#editor-split").boundingBox();
      const restoredLeft = await page.locator('section.editor-pane[data-pane-id="left"]').boundingBox();
      expect((restoredLeft?.width ?? 0) / Math.max(1, (restoredSplit?.width ?? 1) - 5))
        .toBeCloseTo(NOVEL_VIEWER_SPLIT_RATIO_DEFAULT, 1);
      await expect(page.locator(".novel-viewer-toc-work-title")).toHaveText("Retained Cached Work");
      await expect(page.locator(".novel-viewer-toc-episode")).toHaveText("Retained Episode");
      await expect(page.locator("#novel-viewer-toc-status")).toContainText(/could not update|saved table of contents/i);
      await expect(page.getByTestId("novel-viewer-pane")).toHaveAttribute("data-lifecycle", "visible");
      expect((await readerViewSnapshot(app)).visible).toBe(true);
    } finally {
      await closeApp(app);
    }
  });
});
