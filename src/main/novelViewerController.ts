import { app, BrowserWindow, WebContentsView, session, shell } from "electron";
import type { Input, Rectangle, Session, View, WebContents } from "electron";
import type {
  NovelViewerBoundsUpdate,
  NovelViewerErrorCode,
  NovelViewerOcclusionReason,
  NovelViewerOcclusionUpdate,
  NovelViewerRendererDiagnosticSnapshot,
  NovelViewerStartupState,
  NovelViewerStatus,
  ReaderScrollState,
  ReaderState
} from "../shared/novelViewer.js";
import { ReaderStateStore, defaultReaderState } from "./readerState.js";
import { NovelViewerDiagnostics } from "./novelViewerDiagnostics.js";
import {
  NOVEL_VIEWER_TEST_SCHEME,
  isPrivateNetworkAddress,
  isSafeReaderNetworkRequest,
  validateNovelViewerUrl
} from "./novelViewerSecurity.js";

const READER_PARTITION = "novel-viewer-reader";
const CHECKPOINT_INTERVAL_MS = 20_000;
const MAX_BOUND_VALUE = 100_000;
const ISOLATED_WORLD_ID = 999;
const MAX_SCROLL_VALUE = 100_000_000;
const SCROLL_RESTORE_DELAYS_MS = [100, 350, 800];
const OCCLUSION_REASONS = new Set<NovelViewerOcclusionReason>([
  "dialog",
  "context-menu",
  "editor-search",
  "global-search",
  "command-palette",
  "workspace-import"
]);

type NavigationSource = "input" | "page" | "redirect" | "history" | "reload" | "restore";

let nextViewObjectIdentifier = 0;
const viewObjectIdentifiers = new WeakMap<object, number>();

function objectIdentifier(value: object): number {
  const existing = viewObjectIdentifiers.get(value);
  if (existing) return existing;
  const identifier = ++nextViewObjectIdentifier;
  viewObjectIdentifiers.set(value, identifier);
  return identifier;
}

function safeText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned ? cleaned.slice(0, maximumLength) : undefined;
}

function safeDiagnosticUrl(value: unknown): string | undefined {
  const source = safeText(value, 8192);
  if (!source) return undefined;
  try {
    const parsed = new URL(source);
    if (["data:", "javascript:", "blob:", "file:"].includes(parsed.protocol)) {
      return `${parsed.protocol}<redacted>`;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return safeText(parsed.href, 4096);
  } catch {
    return "<invalid-url>";
  }
}

function timeout<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), milliseconds);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      }
    );
  });
}

function isScrollState(value: unknown): value is ReaderScrollState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scroll = value as Record<string, unknown>;
  return (
    typeof scroll.url === "string" &&
    scroll.url.length <= 4096 &&
    [scroll.scrollY, scroll.documentHeight, scroll.viewportHeight, scroll.progressRatio].every(
      (entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0
    ) &&
    (scroll.scrollY as number) <= MAX_SCROLL_VALUE &&
    (scroll.documentHeight as number) <= MAX_SCROLL_VALUE &&
    (scroll.viewportHeight as number) <= MAX_SCROLL_VALUE
  );
}

export class NovelViewerController {
  private readerSession: Session | null = null;
  private view: WebContentsView | null = null;
  private viewObjectIdentifier: number | null = null;
  private addedContentView: View | null = null;
  private state: ReaderState = structuredClone(defaultReaderState);
  private stateLoaded = false;
  private stateCorrupt = false;
  private isOpen = false;
  private rendererOcclusionReasons = new Set<NovelViewerOcclusionReason>();
  private windowHidden = false;
  private latestOcclusionRevision = -1;
  private loading = false;
  private pendingUrl: string | undefined;
  private committedUrl: string | undefined;
  private title: string | undefined;
  private error: NovelViewerStatus["error"];
  private lifecycle: NovelViewerStatus["lifecycle"] = "closed";
  private navigationEpoch = 0;
  private userInteractionEpoch = -1;
  private mainResponseStatus = 0;
  private latestBoundsRevision = -1;
  private lastValidBounds: Rectangle | null = null;
  private layoutVisible = false;
  private checkpointTimer: NodeJS.Timeout | null = null;
  private restoreTimers = new Set<NodeJS.Timeout>();
  private deferredTimers = new Set<NodeJS.Timeout>();
  private windowBoundsRefreshTimer: NodeJS.Timeout | null = null;
  private windowHandlersInstalled = false;
  private shuttingDown = false;
  private readonly allowTestProtocol = !app.isPackaged && process.env.TEXTEDITOR_NOVEL_VIEWER_TEST_MODE === "1";

  constructor(
    private readonly window: BrowserWindow,
    private readonly store: ReaderStateStore,
    private readonly diagnostics: NovelViewerDiagnostics
  ) {
    this.installWindowHandlers();
    this.logDiagnostic("controller-created");
  }

  private get occluded(): boolean {
    return this.windowHidden || this.rendererOcclusionReasons.size > 0;
  }

  ownsWebContents(contents: WebContents): boolean {
    return Boolean(this.view && !this.view.webContents.isDestroyed() && this.view.webContents.id === contents.id);
  }

  belongsToWindow(window: BrowserWindow): boolean {
    return this.window === window;
  }

  get status(): NovelViewerStatus {
    const history = this.view && !this.view.webContents.isDestroyed() ? this.view.webContents.navigationHistory : null;
    return {
      lifecycle: this.lifecycle,
      isOpen: this.isOpen,
      pendingUrl: this.pendingUrl,
      committedUrl: this.committedUrl,
      lastReadableUrl: this.state.progress.lastReadableUrl,
      title: this.title ?? this.state.progress.title,
      loading: this.loading,
      canGoBack: Boolean(history?.canGoBack()),
      canGoForward: Boolean(history?.canGoForward()),
      error: this.error
    };
  }

  get diagnosticsEnabled(): boolean {
    return this.diagnostics.enabled;
  }

  async dumpDiagnosticState(reason = "manual"): Promise<void> {
    if (!this.diagnostics.enabled) return;
    this.logDiagnostic("diagnostic-dump", { reason: safeText(reason, 120) ?? "manual" });
    this.sendToEditor("novel-viewer:request-diagnostic-snapshot", reason);
    await this.diagnostics.flush();
  }

  async bringToFrontForDiagnostics(): Promise<boolean> {
    if (!this.diagnostics.enabled || !this.view || this.view.webContents.isDestroyed() || this.window.isDestroyed()) {
      this.logDiagnostic("diagnostic-bring-to-front-unavailable");
      await this.diagnostics.flush();
      return false;
    }
    const view = this.view;
    this.logDiagnostic("diagnostic-bring-to-front-before");
    this.addReaderViewToCurrentContentView(view, "diagnostic-bring-to-front");
    if (this.lastValidBounds) this.setReaderViewBounds(view, this.lastValidBounds, "diagnostic-bring-to-front");
    this.setReaderViewVisible(view, true, "diagnostic-bring-to-front");
    this.logDiagnostic("diagnostic-bring-to-front-after");
    this.sendToEditor("novel-viewer:request-bounds");
    this.sendToEditor("novel-viewer:request-diagnostic-snapshot", "diagnostic-bring-to-front-after");
    await this.diagnostics.flush();
    return true;
  }

  recordRendererDiagnosticSnapshot(reason: string, snapshot: NovelViewerRendererDiagnosticSnapshot): void {
    if (!this.diagnostics.enabled) return;
    const normalizedReason = safeText(reason, 120);
    if (!normalizedReason || !this.isValidRendererDiagnosticSnapshot(snapshot)) {
      throw new Error("Invalid Novel Viewer renderer diagnostic snapshot.");
    }
    this.logDiagnostic("renderer-snapshot", {
      reason: normalizedReason,
      renderer: { ...snapshot, url: safeDiagnosticUrl(snapshot.url) ?? "" }
    });
  }

  async initialize(restoreAllowed: boolean): Promise<NovelViewerStartupState> {
    if (!this.stateLoaded) {
      const loaded = await this.store.load();
      this.stateLoaded = true;
      this.state = loaded.state;
      if (!loaded.ok) {
        this.stateCorrupt = true;
        console.error(loaded.error);
        this.setError("reader-state-corrupt", "Novel Viewer state is damaged. The original file was preserved.", false);
      }
    }
    const shouldRestore = !this.stateCorrupt && restoreAllowed && this.state.ui.wasOpen;
    if (!restoreAllowed && this.state.ui.wasOpen && this.store.canWrite) {
      this.state.ui.wasOpen = false;
      await this.persistState(false);
    }
    this.emitStatus();
    return { shouldRestore, status: this.status };
  }

  async open(): Promise<NovelViewerStatus> {
    this.logDiagnostic("viewer-open-before");
    await this.ensureInitialized();
    this.isOpen = true;
    if (this.stateCorrupt) {
      this.setError("reader-state-corrupt", "Novel Viewer state is damaged. The original file was preserved.", false);
      return this.status;
    }
    this.error = undefined;
    this.lifecycle = "creating";
    this.emitStatus();
    this.ensureView();
    this.state.ui.wasOpen = true;
    await this.persistState(true);
    if (this.state.progress.lastReadableUrl && !this.pendingUrl && !this.committedUrl) {
      await this.navigate(this.state.progress.lastReadableUrl, "restore");
    } else {
      this.updateLifecycleAndVisibility();
    }
    this.logDiagnostic("viewer-open-after");
    return this.status;
  }

  async close(): Promise<NovelViewerStatus> {
    this.logDiagnostic("viewer-close-before");
    await this.ensureInitialized();
    this.isOpen = false;
    if (!this.stateCorrupt) {
      // Include the closed UI state in the final scroll checkpoint so readers
      // never observe a fresh checkpoint that still claims the View is open.
      this.state.ui.wasOpen = false;
    }
    await this.disposeView(false, 1_200);
    if (!this.stateCorrupt) {
      await this.persistState(false);
    }
    this.error = this.stateCorrupt ? this.error : undefined;
    this.lifecycle = "closed";
    this.emitStatus();
    this.logDiagnostic("viewer-close-after");
    return this.status;
  }

  async navigate(rawUrl: string, source: NavigationSource = "input"): Promise<NovelViewerStatus> {
    await this.ensureInitialized();
    if (!this.isOpen || this.stateCorrupt) return this.status;
    const validated = validateNovelViewerUrl(rawUrl, { allowTestProtocol: this.allowTestProtocol });
    if (!validated.ok) {
      this.pendingUrl = safeText(rawUrl, 4096);
      this.setError(
        source === "input" ? "unsupported-url" : "navigation-refused",
        source === "input" ? "This URL is not supported by Novel Viewer." : "Novel Viewer blocked this navigation.",
        true
      );
      return this.status;
    }

    const url = validated.url.href;
    const previousEpoch = this.navigationEpoch;
    if (this.committedUrl && previousEpoch > 0) {
      await timeout(this.checkpoint(previousEpoch), 700);
    }
    const epoch = this.beginNavigation(url);
    this.ensureView();
    if (!(await this.isPublicDestination(validated.url))) {
      if (epoch === this.navigationEpoch) {
        this.setError("navigation-refused", "Novel Viewer blocked a private or unresolved network destination.", true);
      }
      return this.status;
    }
    if (epoch !== this.navigationEpoch || !this.view || this.view.webContents.isDestroyed()) return this.status;

    try {
      await this.view.webContents.loadURL(url);
    } catch (loadError) {
      if (epoch === this.navigationEpoch && this.loading && this.pendingUrl === url) {
        const reason = loadError instanceof Error ? loadError.message : String(loadError);
        if (!reason.includes("ERR_ABORTED")) {
          this.handleLoadFailure(reason);
        }
      }
    }
    return this.status;
  }

  async goBack(): Promise<NovelViewerStatus> {
    return this.goHistory(-1);
  }

  async goForward(): Promise<NovelViewerStatus> {
    return this.goHistory(1);
  }

  async reloadOrStop(): Promise<NovelViewerStatus> {
    if (!this.isOpen) return this.status;
    const contents = this.view?.webContents;
    if (this.loading && contents && !contents.isDestroyed()) {
      this.navigationEpoch += 1;
      this.clearRestoreTimers();
      contents.stop();
      this.loading = false;
      this.pendingUrl = undefined;
      this.error = undefined;
      this.updateLifecycleAndVisibility();
      return this.status;
    }
    const target = this.committedUrl ?? this.state.progress.lastReadableUrl;
    if (!target) return this.status;
    if (this.error || !contents || contents.isDestroyed()) {
      await this.disposeRemoteOnly();
      this.ensureView();
      return this.navigate(target, "reload");
    }
    const validated = validateNovelViewerUrl(target, { allowTestProtocol: this.allowTestProtocol });
    if (!validated.ok || !(await this.isPublicDestination(validated.url))) {
      this.setError("navigation-refused", "Novel Viewer blocked this reload.", true);
      return this.status;
    }
    const epoch = this.beginNavigation(validated.url.href);
    if (epoch !== this.navigationEpoch || !this.view || this.view.webContents.isDestroyed()) return this.status;
    this.view.webContents.reload();
    return this.status;
  }

  async openExternal(): Promise<boolean> {
    if (!this.committedUrl) return false;
    const validated = validateNovelViewerUrl(this.committedUrl, { allowTestProtocol: false });
    if (!validated.ok || !(await this.isPublicDestination(validated.url))) return false;
    await shell.openExternal(validated.url.href);
    return true;
  }

  updateBounds(update: NovelViewerBoundsUpdate): void {
    this.logDiagnostic("renderer-bounds-received", { update });
    if (
      !update ||
      !Number.isInteger(update.layoutRevision) ||
      update.layoutRevision < 0 ||
      typeof update.visible !== "boolean" ||
      ![update.x, update.y, update.width, update.height].every(
        (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_BOUND_VALUE
      )
    ) {
      throw new Error("Invalid Novel Viewer bounds.");
    }
    if (update.layoutRevision < this.latestBoundsRevision) {
      this.logDiagnostic("renderer-bounds-ignored-old-revision", { update });
      return;
    }
    const contentBounds = this.window.getContentBounds();
    if (update.x + update.width > contentBounds.width + 1 || update.y + update.height > contentBounds.height + 1) {
      throw new Error("Novel Viewer bounds are outside the editor window.");
    }
    this.latestBoundsRevision = update.layoutRevision;
    const nextBounds = {
      x: Math.round(update.x),
      y: Math.round(update.y),
      width: Math.round(update.width),
      height: Math.round(update.height)
    };
    if (nextBounds.width > 0 && nextBounds.height > 0) {
      this.lastValidBounds = nextBounds;
    }
    // A transient zero-sized layout hides the View but must not discard the
    // last usable rectangle needed for restore/show recovery.
    this.layoutVisible = update.visible && nextBounds.width > 0 && nextBounds.height > 0;
    this.applyViewVisibility();
    this.logDiagnostic("renderer-bounds-applied", { update });
  }

  setOcclusion(update: NovelViewerOcclusionUpdate): void {
    this.logDiagnostic("renderer-occlusion-received", { update });
    if (
      !update ||
      !Number.isInteger(update.revision) ||
      update.revision < 0 ||
      !Array.isArray(update.reasons) ||
      update.reasons.length > OCCLUSION_REASONS.size ||
      !update.reasons.every((reason) => typeof reason === "string" && OCCLUSION_REASONS.has(reason as NovelViewerOcclusionReason))
    ) {
      throw new Error("Invalid Novel Viewer occlusion state.");
    }
    if (update.revision < this.latestOcclusionRevision) {
      this.logDiagnostic("renderer-occlusion-ignored-old-revision", { update });
      return;
    }
    const wasOccluded = this.occluded;
    this.latestOcclusionRevision = update.revision;
    this.rendererOcclusionReasons = new Set(update.reasons as NovelViewerOcclusionReason[]);
    this.handleOcclusionChange(wasOccluded);
    this.logDiagnostic("renderer-occlusion-applied", { update });
  }

  focusRemote(): void {
    if (!this.isOpen || this.occluded || this.error || !this.view || this.view.webContents.isDestroyed()) return;
    this.view.webContents.focus();
  }

  handleCertificateError(contents: WebContents): boolean {
    if (!this.ownsWebContents(contents)) return false;
    this.setError("certificate-error", "Novel Viewer refused an invalid HTTPS certificate.", true);
    return true;
  }

  async checkpointBeforeLifecycle(timeoutMilliseconds = 1_200): Promise<void> {
    await timeout(this.checkpoint(this.navigationEpoch), timeoutMilliseconds);
  }

  async shutdown(checkpointAlreadyTaken = false): Promise<void> {
    this.logDiagnostic("controller-shutdown-before");
    this.shuttingDown = true;
    this.removeWindowHandlers();
    await this.disposeView(true, checkpointAlreadyTaken ? 0 : 1_200);
    await timeout(this.store.waitForIdle(), 600);
    this.logDiagnostic("controller-shutdown-after");
    await timeout(this.diagnostics.flush(), 600);
  }

  async suspendForRendererReload(checkpointAlreadyTaken = false): Promise<void> {
    await this.disposeView(true, checkpointAlreadyTaken ? 0 : 1_200);
    this.isOpen = false;
    this.rendererOcclusionReasons.clear();
    this.latestOcclusionRevision = -1;
    this.latestBoundsRevision = -1;
    this.layoutVisible = false;
    this.shuttingDown = false;
    this.lifecycle = "closed";
    this.emitStatus();
  }

  private handleWindowHiddenState(event: string): void {
    if (this.window.isDestroyed()) return;
    this.logDiagnostic(`${event}-before`);
    const wasOccluded = this.occluded;
    this.windowHidden = this.window.isMinimized() || !this.window.isVisible();
    this.handleOcclusionChange(wasOccluded);
    if (!this.windowHidden) this.scheduleWindowBoundsRefresh(0);
    this.logDiagnostic(`${event}-after`);
  }

  private handleWindowGeometryChange(event: string): void {
    this.logDiagnostic(`${event}-before`);
    this.scheduleWindowBoundsRefresh();
    this.logDiagnostic(`${event}-after`);
  }

  private readonly handleWindowMinimize = (): void => this.handleWindowHiddenState("window-minimize");
  private readonly handleWindowHide = (): void => this.handleWindowHiddenState("window-hide");
  private readonly handleWindowRestore = (): void => this.handleWindowHiddenState("window-restore");
  private readonly handleWindowShow = (): void => this.handleWindowHiddenState("window-show");
  private readonly handleWindowResize = (): void => this.handleWindowGeometryChange("window-resize");
  private readonly handleWindowMaximize = (): void => this.handleWindowGeometryChange("window-maximize");
  private readonly handleWindowUnmaximize = (): void => this.handleWindowGeometryChange("window-unmaximize");

  private installWindowHandlers(): void {
    if (this.windowHandlersInstalled) return;
    this.windowHandlersInstalled = true;
    this.window.on("minimize", this.handleWindowMinimize);
    this.window.on("hide", this.handleWindowHide);
    this.window.on("restore", this.handleWindowRestore);
    this.window.on("show", this.handleWindowShow);
    this.window.on("resize", this.handleWindowResize);
    this.window.on("maximize", this.handleWindowMaximize);
    this.window.on("unmaximize", this.handleWindowUnmaximize);
  }

  private removeWindowHandlers(): void {
    if (!this.windowHandlersInstalled) return;
    this.windowHandlersInstalled = false;
    this.window.removeListener("minimize", this.handleWindowMinimize);
    this.window.removeListener("hide", this.handleWindowHide);
    this.window.removeListener("restore", this.handleWindowRestore);
    this.window.removeListener("show", this.handleWindowShow);
    this.window.removeListener("resize", this.handleWindowResize);
    this.window.removeListener("maximize", this.handleWindowMaximize);
    this.window.removeListener("unmaximize", this.handleWindowUnmaximize);
    if (this.windowBoundsRefreshTimer) {
      clearTimeout(this.windowBoundsRefreshTimer);
      this.windowBoundsRefreshTimer = null;
    }
  }

  private handleOcclusionChange(wasOccluded: boolean): void {
    const occluded = this.occluded;
    if (!wasOccluded && occluded && this.isOpen) void timeout(this.checkpoint(this.navigationEpoch), 700);
    this.updateLifecycleAndVisibility();
    if (wasOccluded && !occluded) this.scheduleWindowBoundsRefresh(0);
  }

  private scheduleWindowBoundsRefresh(delay = 50): void {
    if (this.shuttingDown || this.window.isDestroyed()) return;
    if (this.windowBoundsRefreshTimer) clearTimeout(this.windowBoundsRefreshTimer);
    this.windowBoundsRefreshTimer = setTimeout(() => {
      this.windowBoundsRefreshTimer = null;
      this.applyViewVisibility();
      if (this.isOpen) this.sendToEditor("novel-viewer:request-bounds");
    }, delay);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.stateLoaded) await this.initialize(true);
  }

  private ensureSession(): Session {
    if (this.readerSession) return this.readerSession;
    const readerSession = session.fromPartition(READER_PARTITION, { cache: false });
    readerSession.setPermissionCheckHandler(() => false);
    readerSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    readerSession.setDevicePermissionHandler(() => false);
    readerSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    readerSession.on("will-download", (event, _item) => {
      event.preventDefault();
      this.deferNavigationError("navigation-refused", "Downloads are disabled in Novel Viewer.");
    });
    readerSession.on("select-hid-device", (event, _details, callback) => {
      event.preventDefault();
      callback("");
    });
    readerSession.on("select-serial-port", (event, _portList, _webContents, callback) => {
      event.preventDefault();
      callback("");
    });
    readerSession.on("select-usb-device", (event, _details, callback) => {
      event.preventDefault();
      callback("");
    });
    readerSession.webRequest.onBeforeRequest((details, callback) => {
      if (details.resourceType === "mainFrame") {
        callback({ cancel: !validateNovelViewerUrl(details.url, { allowTestProtocol: this.allowTestProtocol }).ok });
        return;
      }
      callback({ cancel: !isSafeReaderNetworkRequest(details.url, this.allowTestProtocol) });
    });
    readerSession.webRequest.onCompleted((details) => {
      const contents = this.view?.webContents;
      if (
        details.resourceType === "mainFrame" &&
        contents &&
        !contents.isDestroyed() &&
        details.webContentsId === contents.id &&
        details.url === this.committedUrl
      ) {
        this.mainResponseStatus = details.statusCode;
      }
    });
    if (this.allowTestProtocol) this.installTestProtocol(readerSession);
    this.readerSession = readerSession;
    return readerSession;
  }

  private installTestProtocol(readerSession: Session): void {
    const scheme = NOVEL_VIEWER_TEST_SCHEME.slice(0, -1);
    if (readerSession.protocol.isProtocolHandled(scheme)) return;
    readerSession.protocol.handle(scheme, async (request) => {
      const requestUrl = new URL(request.url);
      const page = safeText(requestUrl.pathname, 120) ?? "/";
      if (page === "/slow.svg") {
        await new Promise((resolve) => setTimeout(resolve, 900));
        return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', {
          headers: { "content-type": "image/svg+xml" }
        });
      }
      if (page === "/download.txt") {
        return new Response("Downloads are disabled by Novel Viewer.", {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-disposition": "attachment; filename=sample.txt"
          }
        });
      }
      if (page === "/redirect-to-blocked") {
        return new Response(null, {
          status: 302,
          headers: { location: `${scheme}://blocked/redirect-target?secret=must-not-be-logged` }
        });
      }
      if (page === "/redirect-to-page-b") {
        return new Response(null, {
          status: 302,
          headers: { location: `${scheme}://fixture/page-b` }
        });
      }
      if (page === "/subframe-http-500") {
        return new Response('<!doctype html><title>Subframe failure</title><body data-page-id="subframe-http-500"><p>Subframe HTTP 500</p></body>', {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
      if (page === "/subframe-network-failure") return Response.error();
      const isBlockedTarget = requestUrl.hostname === "blocked";
      const title = isBlockedTarget ? "Blocked Target Fixture" : page === "/page-b" ? "Fixture B" : "Fixture A";
      const pageId = isBlockedTarget ? "blocked-target" : page === "/page-b" ? "page-b" : "page-a";
      const blockedTargetMarker = isBlockedTarget
        ? '<p id="blocked-target-marker">BLOCKED_TARGET_FIXTURE_BODY</p><script>window.__novelViewerBlockedTargetExecuted = true;</script>'
        : "";
      const body = `<!doctype html><meta charset="utf-8"><title>${title}</title>
        <style>body{font-family:sans-serif;margin:20px;min-height:4200px}button,a{display:block;margin:12px}</style>
        <body data-page-id="${pageId}">
        <h1>${title}</h1><a id="next" href="${scheme}://fixture/page-b">Next</a>
        <a id="blocked" href="${scheme}://blocked/private">Blocked</a>
        ${blockedTargetMarker}
        <a id="download" href="${scheme}://fixture/download.txt">Download</a>
        <button id="popup" onclick="window.open('${scheme}://fixture/popup')">Popup</button>
        <button id="permission" onclick="navigator.geolocation.getCurrentPosition(()=>{},()=>{})">Permission</button>
        ${page === "/slow" ? `<img src="${scheme}://fixture/slow.svg" alt="">` : ""}
        <div style="height:3900px"></div><p id="bottom">Bottom</p></body>`;
      return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
    });
  }

  private ensureView(): void {
    if (this.view && !this.view.webContents.isDestroyed()) return;
    this.logDiagnostic("reader-view-create-before");
    const view = new WebContentsView({
      webPreferences: {
        session: this.ensureSession(),
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: false,
        spellcheck: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        disableDialogs: true,
        safeDialogs: true
      }
    });
    this.view = view;
    this.viewObjectIdentifier = objectIdentifier(view);
    this.logDiagnostic("reader-view-created");
    this.addReaderViewToCurrentContentView(view, "reader-view-create");
    this.setReaderViewBounds(view, { x: 0, y: 0, width: 0, height: 0 }, "reader-view-create");
    this.setReaderViewVisible(view, false, "reader-view-create");
    this.installWebContentsHandlers(view.webContents);
    this.startCheckpointTimer();
    this.updateLifecycleAndVisibility();
    this.logDiagnostic("reader-view-create-after");
  }

  private installWebContentsHandlers(contents: WebContents): void {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("did-start-loading", () => this.logDiagnostic("webcontents-did-start-loading", {
      webContentsUrl: safeDiagnosticUrl(contents.getURL()),
      navigationEpoch: this.navigationEpoch,
      committedUrl: safeDiagnosticUrl(this.committedUrl),
      lastReadableUrl: safeDiagnosticUrl(this.state.progress.lastReadableUrl)
    }));
    contents.on("did-stop-loading", () => this.logDiagnostic("webcontents-did-stop-loading", {
      webContentsUrl: safeDiagnosticUrl(contents.getURL()),
      navigationEpoch: this.navigationEpoch,
      committedUrl: safeDiagnosticUrl(this.committedUrl),
      lastReadableUrl: safeDiagnosticUrl(this.state.progress.lastReadableUrl)
    }));
    contents.on("will-navigate", (event, url) => {
      if (!this.isOpen) {
        event.preventDefault();
        return;
      }
      const validated = validateNovelViewerUrl(url, { allowTestProtocol: this.allowTestProtocol });
      if (!validated.ok) {
        // Electron 43 can terminate on preventDefault() from a custom-scheme test page;
        // production still cancels here, while the test-only path is canceled by webRequest.
        if (!this.allowTestProtocol) event.preventDefault();
        this.deferNavigationError("navigation-refused", "Novel Viewer blocked this navigation.");
        return;
      }
      event.preventDefault();
      void this.navigate(validated.url.href, "page");
    });
    contents.on("will-redirect", (event) => {
      const url = event.url;
      const frameProcessId = event.frame?.processId ?? null;
      const frameRoutingId = event.frame?.routingId ?? null;
      if (!event.isMainFrame) {
        const requestAllowed = isSafeReaderNetworkRequest(url, this.allowTestProtocol);
        // The production handler rejects the individual unsafe frame navigation here.
        // The custom-scheme fixture is rejected by the Session request guard because
        // Electron 43 can terminate a test renderer when that redirect is canceled here.
        if (!requestAllowed && !this.allowTestProtocol) event.preventDefault();
        this.logDiagnostic("subframe-redirect-observed", {
          targetUrl: safeDiagnosticUrl(url),
          isMainFrame: false,
          frameProcessId,
          frameRoutingId,
          validationResult: requestAllowed ? "allowed" : "refused",
          validationScope: "subframe-request",
          rejected: !requestAllowed,
          promotedToGlobalError: false,
          navigationEpoch: this.navigationEpoch,
          committedUrl: safeDiagnosticUrl(this.committedUrl),
          lastReadableUrl: safeDiagnosticUrl(this.state.progress.lastReadableUrl),
          webContentsUrl: safeDiagnosticUrl(contents.getURL())
        });
        return;
      }
      const validated = validateNovelViewerUrl(url, { allowTestProtocol: this.allowTestProtocol });
      if (!validated.ok) {
        // Keep the production event guard; the explicit test scheme uses the Session guard.
        if (!this.allowTestProtocol) event.preventDefault();
        this.logDiagnostic("main-frame-redirect-refused", {
          targetUrl: safeDiagnosticUrl(url),
          isMainFrame: true,
          frameProcessId,
          frameRoutingId,
          validationResult: "refused",
          validationScope: "top-level-navigation",
          validationReason: safeText(validated.reason, 240),
          rejected: true,
          promotedToGlobalError: true,
          navigationEpoch: this.navigationEpoch,
          committedUrl: safeDiagnosticUrl(this.committedUrl),
          lastReadableUrl: safeDiagnosticUrl(this.state.progress.lastReadableUrl),
          webContentsUrl: safeDiagnosticUrl(contents.getURL())
        });
        this.deferNavigationError("navigation-refused", "Novel Viewer blocked an unsafe redirect.");
        return;
      }
      event.preventDefault();
      this.logDiagnostic("main-frame-redirect-allowed", {
        targetUrl: safeDiagnosticUrl(validated.url.href),
        isMainFrame: true,
        frameProcessId,
        frameRoutingId,
        validationResult: "allowed",
        validationScope: "top-level-navigation",
        rejected: false,
        promotedToGlobalError: false,
        navigationEpoch: this.navigationEpoch,
        committedUrl: safeDiagnosticUrl(this.committedUrl),
        lastReadableUrl: safeDiagnosticUrl(this.state.progress.lastReadableUrl),
        webContentsUrl: safeDiagnosticUrl(contents.getURL())
      });
      void this.navigate(validated.url.href, "redirect");
    });
    contents.on("did-start-navigation", (event) => {
      this.logDiagnostic("webcontents-did-start-navigation", {
        url: safeDiagnosticUrl(event.url),
        isMainFrame: event.isMainFrame,
        frameProcessId: event.frame?.processId ?? null,
        frameRoutingId: event.frame?.routingId ?? null,
        navigationEpoch: this.navigationEpoch,
        committedUrl: safeDiagnosticUrl(this.committedUrl),
        lastReadableUrl: safeDiagnosticUrl(this.state.progress.lastReadableUrl),
        webContentsUrl: safeDiagnosticUrl(contents.getURL())
      });
      if (!event.isMainFrame) return;
      const validated = validateNovelViewerUrl(event.url, { allowTestProtocol: this.allowTestProtocol });
      if (!validated.ok) {
        this.deferNavigationError("navigation-refused", "Novel Viewer stopped an unsafe navigation.");
      }
    });
    contents.on("did-redirect-navigation", (event) => {
      this.logDiagnostic("webcontents-did-redirect-navigation", {
        url: safeDiagnosticUrl(event.url),
        isMainFrame: event.isMainFrame,
        frameProcessId: event.frame?.processId ?? null,
        frameRoutingId: event.frame?.routingId ?? null,
        navigationEpoch: this.navigationEpoch,
        committedUrl: safeDiagnosticUrl(this.committedUrl),
        lastReadableUrl: safeDiagnosticUrl(this.state.progress.lastReadableUrl),
        webContentsUrl: safeDiagnosticUrl(contents.getURL())
      });
    });
    contents.on("did-frame-navigate", (_event, url, httpResponseCode, _httpStatusText, isMainFrame, frameProcessId, frameRoutingId) => {
      this.logDiagnostic("webcontents-did-frame-navigate", {
        url: safeDiagnosticUrl(url),
        httpResponseCode,
        isMainFrame,
        frameProcessId,
        frameRoutingId,
        navigationEpoch: this.navigationEpoch,
        committedUrl: safeDiagnosticUrl(this.committedUrl),
        lastReadableUrl: safeDiagnosticUrl(this.state.progress.lastReadableUrl),
        webContentsUrl: safeDiagnosticUrl(contents.getURL())
      });
      if (!isMainFrame) return;
      this.commitNavigation(url, httpResponseCode);
    });
    contents.on("did-navigate", (_event, url, httpResponseCode, _httpStatusText) => {
      this.logDiagnostic("webcontents-did-navigate", {
        url: safeDiagnosticUrl(url),
        isMainFrame: true,
        httpResponseCode,
        navigationEpoch: this.navigationEpoch,
        committedUrl: safeDiagnosticUrl(this.committedUrl),
        lastReadableUrl: safeDiagnosticUrl(this.state.progress.lastReadableUrl),
        webContentsUrl: safeDiagnosticUrl(contents.getURL())
      });
      this.commitNavigation(url, this.mainResponseStatus);
    });
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      const validated = validateNovelViewerUrl(url, { allowTestProtocol: this.allowTestProtocol });
      if (!validated.ok) {
        contents.stop();
        this.setError("navigation-refused", "Novel Viewer stopped an unsafe in-page navigation.", true);
        return;
      }
      this.navigationEpoch += 1;
      this.clearRestoreTimers();
      this.committedUrl = validated.url.href;
      this.pendingUrl = undefined;
      this.loading = false;
      this.error = undefined;
      this.markReadable(this.navigationEpoch);
    });
    contents.on("did-finish-load", () => {
      this.logDiagnostic("webcontents-did-finish-load");
      void this.handleFinishedLoad();
    });
    contents.on("dom-ready", () => void this.initializeRestoreInteraction(this.navigationEpoch));
    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame, frameProcessId, frameRoutingId) => {
      this.logDiagnostic("webcontents-did-fail-load", {
        errorCode,
        errorDescription: safeText(errorDescription, 240),
        validatedUrl: safeDiagnosticUrl(validatedUrl),
        isMainFrame,
        frameProcessId,
        frameRoutingId,
        promotedToGlobalError: isMainFrame && errorCode !== -3,
        navigationEpoch: this.navigationEpoch,
        committedUrl: safeDiagnosticUrl(this.committedUrl),
        lastReadableUrl: safeDiagnosticUrl(this.state.progress.lastReadableUrl),
        webContentsUrl: safeDiagnosticUrl(contents.getURL())
      });
      if (!isMainFrame || errorCode === -3) return;
      if (validatedUrl && this.pendingUrl && validatedUrl !== this.pendingUrl && validatedUrl !== this.committedUrl) return;
      this.handleLoadFailure(errorDescription, errorCode);
    });
    contents.on("page-title-updated", (event, pageTitle) => {
      event.preventDefault();
      this.logDiagnostic("webcontents-page-title-updated", { title: safeText(pageTitle, 300) });
      const current = contents.getURL();
      if (current && (current === this.committedUrl || current === this.pendingUrl)) {
        this.title = safeText(pageTitle, 300);
        this.emitStatus();
      }
    });
    contents.on("before-input-event", (event, input) => this.handleRemoteInput(event, input));
    contents.on("before-mouse-event", (_event, mouse) => {
      if (mouse.type === "mouseDown") this.userInteractionEpoch = this.navigationEpoch;
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("select-bluetooth-device", (event, _deviceList, callback) => {
      event.preventDefault();
      callback("");
    });
    contents.on("will-prevent-unload", (event) => event.preventDefault());
    contents.on("render-process-gone", (_event, details) => {
      this.logDiagnostic("webcontents-render-process-gone", {
        reason: details.reason,
        exitCode: details.exitCode
      });
      if (this.lifecycle === "closing" || this.shuttingDown) return;
      this.detachDeadView();
      this.setError("renderer-crashed", `Novel Viewer stopped safely (${details.reason}).`, true);
    });
    contents.on("unresponsive", () => {
      this.logDiagnostic("webcontents-unresponsive");
      if (this.lifecycle === "closing" || this.shuttingDown) return;
      contents.stop();
      if (this.checkpointTimer) {
        clearInterval(this.checkpointTimer);
        this.checkpointTimer = null;
      }
      this.setError("unresponsive", "Novel Viewer became unresponsive and was hidden.", true);
    });
    contents.on("responsive", () => this.logDiagnostic("webcontents-responsive"));
  }

  private handleRemoteInput(event: Electron.Event, input: Input): void {
    if (input.type !== "keyDown" && input.type !== "rawKeyDown") return;
    this.userInteractionEpoch = this.navigationEpoch;
    const modifier = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (modifier && key === "l") {
      event.preventDefault();
      this.sendToEditor("novel-viewer:focus-address");
    } else if ((modifier && key === "r") || key === "f5") {
      event.preventDefault();
      void this.reloadOrStop();
    } else if (input.alt && key === "left") {
      event.preventDefault();
      void this.goBack();
    } else if (input.alt && key === "right") {
      event.preventDefault();
      void this.goForward();
    } else if (modifier && input.shift && key === "w") {
      event.preventDefault();
      this.sendToEditor("novel-viewer:request-close");
    } else if (key === "escape") {
      event.preventDefault();
      this.sendToEditor("novel-viewer:focus-address");
    } else if (modifier && (key === "s" || key === "o" || key === "p")) {
      event.preventDefault();
    }
  }

  private beginNavigation(url: string): number {
    this.navigationEpoch += 1;
    this.userInteractionEpoch = -1;
    this.clearRestoreTimers();
    this.clearDeferredTimers();
    this.pendingUrl = url;
    this.loading = true;
    this.error = undefined;
    this.mainResponseStatus = 0;
    this.updateLifecycleAndVisibility();
    return this.navigationEpoch;
  }

  private commitNavigation(rawUrl: string, responseCode: number): void {
    const validated = validateNovelViewerUrl(rawUrl, { allowTestProtocol: this.allowTestProtocol });
    if (!validated.ok) {
      this.view?.webContents.stop();
      this.setError("navigation-refused", "Novel Viewer stopped an unsafe committed navigation.", true);
      return;
    }
    this.committedUrl = validated.url.href;
    this.pendingUrl = validated.url.href;
    if (responseCode > 0) this.mainResponseStatus = responseCode;
    this.emitStatus();
  }

  private async handleFinishedLoad(): Promise<void> {
    const epoch = this.navigationEpoch;
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const current = contents.getURL();
    const validated = validateNovelViewerUrl(current, { allowTestProtocol: this.allowTestProtocol });
    if (!validated.ok || current !== this.committedUrl) return;
    if (this.mainResponseStatus >= 400) {
      this.loading = false;
      this.pendingUrl = undefined;
      this.setError("load-failed", `Novel Viewer could not open this page (HTTP ${this.mainResponseStatus}).`, true);
      return;
    }
    this.loading = false;
    this.pendingUrl = undefined;
    this.error = undefined;
    this.markReadable(epoch);
    await this.initializeRestoreInteraction(epoch);
    this.scheduleScrollRestore(epoch);
  }

  private markReadable(epoch: number): void {
    if (epoch !== this.navigationEpoch || !this.committedUrl) return;
    this.state.progress.lastReadableUrl = this.committedUrl;
    this.state.progress.title = this.title;
    this.state.progress.lastViewedAt = new Date().toISOString();
    this.updateLifecycleAndVisibility();
    void this.persistState(true);
  }

  private handleLoadFailure(description: string, errorCode?: number): void {
    this.loading = false;
    this.pendingUrl = undefined;
    if (this.error?.code === "certificate-error") {
      this.emitStatus();
      return;
    }
    const offline = errorCode === -106 || errorCode === -105 || /internet_disconnected|name_not_resolved/i.test(description);
    this.setError(
      offline ? "offline" : "load-failed",
      offline ? "Novel Viewer could not reach the site. Check the network connection." : "Novel Viewer could not load this page.",
      true
    );
  }

  private async goHistory(offset: -1 | 1): Promise<NovelViewerStatus> {
    const contents = this.view?.webContents;
    if (!this.isOpen || !contents || contents.isDestroyed()) return this.status;
    const history = contents.navigationHistory;
    const targetIndex = history.getActiveIndex() + offset;
    if (!history.canGoToOffset(offset)) return this.status;
    const entry = history.getEntryAtIndex(targetIndex);
    const validated = entry && validateNovelViewerUrl(entry.url, { allowTestProtocol: this.allowTestProtocol });
    if (!validated || !validated.ok || !(await this.isPublicDestination(validated.url))) {
      this.setError("navigation-refused", "Novel Viewer blocked an unsafe history entry.", true);
      return this.status;
    }
    await timeout(this.checkpoint(this.navigationEpoch), 700);
    this.beginNavigation(validated.url.href);
    history.goToOffset(offset);
    return this.status;
  }

  private async isPublicDestination(url: URL): Promise<boolean> {
    if (this.allowTestProtocol && url.protocol === NOVEL_VIEWER_TEST_SCHEME) return true;
    if (url.protocol !== "https:" || !this.readerSession) return false;
    try {
      const result = await this.readerSession.resolveHost(url.hostname);
      return result.endpoints.length > 0 && result.endpoints.every((endpoint) => !isPrivateNetworkAddress(endpoint.address));
    } catch {
      return false;
    }
  }

  private startCheckpointTimer(): void {
    if (this.checkpointTimer) return;
    this.checkpointTimer = setInterval(() => {
      void (async () => {
        const shouldCheckpoint = this.isOpen && !this.occluded && !this.loading;
        this.logDiagnostic("periodic-20s-before", { shouldCheckpoint });
        // Existing reconciliation behavior is intentionally unchanged while
        // diagnostics determine whether it affects membership or z-order.
        this.applyViewVisibility("periodic-20s");
        if (shouldCheckpoint) await this.checkpoint(this.navigationEpoch);
        this.logDiagnostic("periodic-20s-after", { shouldCheckpoint });
      })();
    }, CHECKPOINT_INTERVAL_MS);
  }

  private async checkpoint(epoch: number): Promise<void> {
    const contents = this.view?.webContents;
    const expectedUrl = this.committedUrl;
    if (!contents || contents.isDestroyed() || !expectedUrl || epoch !== this.navigationEpoch || this.stateCorrupt) return;
    try {
      const result = await contents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{
        code: `(() => {
          const root = document.documentElement;
          const body = document.body;
          const documentHeight = Math.max(root?.scrollHeight || 0, body?.scrollHeight || 0, root?.offsetHeight || 0, body?.offsetHeight || 0);
          const viewportHeight = Math.max(0, window.innerHeight || 0);
          const scrollY = Math.max(0, window.scrollY || root?.scrollTop || body?.scrollTop || 0);
          const range = Math.max(0, documentHeight - viewportHeight);
          return { url: location.href, scrollY, documentHeight, viewportHeight, progressRatio: range > 0 ? scrollY / range : 0 };
        })()`
      }]);
      if (epoch !== this.navigationEpoch || expectedUrl !== this.committedUrl || !isScrollState(result) || result.url !== expectedUrl) return;
      this.state.progress.scroll = {
        url: result.url,
        scrollY: result.scrollY,
        documentHeight: result.documentHeight,
        viewportHeight: result.viewportHeight,
        progressRatio: Math.min(1, Math.max(0, result.progressRatio))
      };
      this.state.progress.lastViewedAt = new Date().toISOString();
      await this.persistState(true);
    } catch {
      // A Reader checkpoint is best-effort and never participates in document saving.
    }
  }

  private async initializeRestoreInteraction(epoch: number): Promise<void> {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed() || epoch !== this.navigationEpoch) return;
    try {
      await contents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{
        code: `(() => {
          const key = "__novelViewerRestoreState";
          if (globalThis[key]) return true;
          const state = { interacted: false, restoring: false };
          globalThis[key] = state;
          const mark = () => { if (!state.restoring) state.interacted = true; };
          for (const type of ["wheel", "pointerdown", "touchstart", "keydown"]) addEventListener(type, mark, { capture: true, passive: true });
          addEventListener("scroll", mark, { capture: true, passive: true });
          return true;
        })()`
      }]);
    } catch {
      // Restoration remains optional when isolated-world setup is unavailable.
    }
  }

  private scheduleScrollRestore(epoch: number): void {
    const saved = this.state.progress.scroll;
    if (!saved || !this.committedUrl || saved.url !== this.committedUrl || this.userInteractionEpoch === epoch) return;
    SCROLL_RESTORE_DELAYS_MS.forEach((delay, index) => {
      const timer = setTimeout(() => {
        this.restoreTimers.delete(timer);
        void this.restoreScrollAttempt(epoch, saved, index === SCROLL_RESTORE_DELAYS_MS.length - 1);
      }, delay);
      this.restoreTimers.add(timer);
    });
  }

  private async restoreScrollAttempt(epoch: number, saved: ReaderScrollState, finalAttempt: boolean): Promise<void> {
    const contents = this.view?.webContents;
    if (
      !contents ||
      contents.isDestroyed() ||
      epoch !== this.navigationEpoch ||
      saved.url !== this.committedUrl ||
      this.userInteractionEpoch === epoch
    ) return;
    try {
      const result = await contents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{
        code: `(() => {
          const state = globalThis.__novelViewerRestoreState;
          if (!state || state.interacted) return { restored: false, canceled: true };
          const root = document.documentElement;
          const body = document.body;
          const height = Math.max(root?.scrollHeight || 0, body?.scrollHeight || 0, root?.offsetHeight || 0, body?.offsetHeight || 0);
          const viewport = Math.max(0, window.innerHeight || 0);
          const range = Math.max(0, height - viewport);
          const savedHeight = ${JSON.stringify(saved.documentHeight)};
          const ratio = ${JSON.stringify(Math.min(1, Math.max(0, saved.progressRatio)))};
          const heightDifference = savedHeight > 0 ? Math.abs(height - savedHeight) / savedHeight : 1;
          const target = heightDifference <= 0.2 ? ${JSON.stringify(saved.scrollY)} : range * ratio;
          state.restoring = true;
          window.scrollTo(0, Math.min(range, Math.max(0, target)));
          requestAnimationFrame(() => { state.restoring = false; });
          return { restored: true, canceled: false };
        })()`
      }]);
      if (epoch !== this.navigationEpoch || result?.canceled) this.clearRestoreTimers();
    } catch {
      if (finalAttempt && epoch === this.navigationEpoch) {
        this.sendToEditor("novel-viewer:scroll-restore-warning");
      }
    }
  }

  private clearRestoreTimers(): void {
    this.restoreTimers.forEach((timer) => clearTimeout(timer));
    this.restoreTimers.clear();
  }

  private deferNavigationError(code: NovelViewerErrorCode, message: string): void {
    const epoch = this.navigationEpoch;
    this.defer(() => {
      if (epoch === this.navigationEpoch) this.setError(code, message, true);
    }, 100);
  }

  private defer(callback: () => void, delay = 0): void {
    const timer = setTimeout(() => {
      this.deferredTimers.delete(timer);
      if (!this.shuttingDown && this.lifecycle !== "closing") callback();
    }, delay);
    this.deferredTimers.add(timer);
  }

  private clearDeferredTimers(): void {
    this.deferredTimers.forEach((timer) => clearTimeout(timer));
    this.deferredTimers.clear();
  }

  private async persistState(reportFailure: boolean): Promise<void> {
    if (this.stateCorrupt || !this.store.canWrite) return;
    try {
      await this.store.save(this.state);
    } catch (error) {
      if (reportFailure && this.lifecycle !== "closing" && !this.shuttingDown) {
        console.error("Failed to save Novel Viewer state:", error);
        this.setError("reader-state-save-failed", "Novel Viewer could not save its reading position.", true);
      }
    }
  }

  private setError(code: NovelViewerErrorCode, message: string, recoverable: boolean): void {
    this.loading = false;
    this.error = { code, message: safeText(message, 240) ?? "Novel Viewer error", recoverable };
    this.lifecycle = "error";
    this.emitStatus();
    this.defer(() => this.applyViewVisibility());
  }

  private addReaderViewToCurrentContentView(view: WebContentsView, context: string): void {
    this.logDiagnostic("add-child-view-before", { context });
    this.window.contentView.addChildView(view);
    this.addedContentView = this.window.contentView;
    this.logDiagnostic("add-child-view-after", { context });
  }

  private removeReaderViewFromCurrentContentView(view: WebContentsView, context: string): void {
    this.logDiagnostic("remove-child-view-before", { context });
    this.window.contentView.removeChildView(view);
    if (this.addedContentView === this.window.contentView) this.addedContentView = null;
    this.logDiagnostic("remove-child-view-after", { context });
  }

  private setReaderViewBounds(view: WebContentsView, bounds: Rectangle, context: string): void {
    this.logDiagnostic("set-bounds-before", { context, requestedBounds: bounds });
    view.setBounds(bounds);
    this.logDiagnostic("set-bounds-after", { context, requestedBounds: bounds });
  }

  private setReaderViewVisible(view: WebContentsView, visible: boolean, context: string): void {
    this.logDiagnostic("set-visible-before", { context, requestedVisible: visible });
    view.setVisible(visible);
    this.logDiagnostic("set-visible-after", { context, requestedVisible: visible });
  }

  private logDiagnostic(event: string, details: Record<string, unknown> = {}): void {
    if (!this.diagnostics.enabled) return;
    this.diagnostics.record(event, { ...details, main: this.captureDiagnosticSnapshot() });
  }

  private captureDiagnosticSnapshot(): Record<string, unknown> {
    const windowDestroyed = this.window.isDestroyed();
    const currentContentView = windowDestroyed ? null : this.window.contentView;
    const children = currentContentView?.children ?? [];
    const view = this.view;
    const readerIndex = view ? children.findIndex((child) => child === view) : -1;
    const childSnapshots = children.map((child, index) => {
      let webContentsId: number | null = null;
      let webContentsDestroyed: boolean | null = null;
      if (child instanceof WebContentsView) {
        try {
          webContentsId = child.webContents.id;
          webContentsDestroyed = child.webContents.isDestroyed();
        } catch {
          webContentsDestroyed = true;
        }
      }
      return {
        index,
        objectIdentifier: objectIdentifier(child),
        type: child.constructor.name,
        referenceMatchesReaderView: Boolean(view && child === view),
        webContentsId,
        webContentsDestroyed
      };
    });
    let readerVisible: boolean | null = null;
    let readerBounds: Rectangle | null = null;
    let webContentsId: number | null = null;
    let webContentsDestroyed: boolean | null = null;
    let url = "";
    let loading: boolean | null = null;
    if (view) {
      try {
        readerVisible = view.getVisible();
        readerBounds = view.getBounds();
        webContentsId = view.webContents.id;
        webContentsDestroyed = view.webContents.isDestroyed();
        if (!webContentsDestroyed) {
          url = safeDiagnosticUrl(view.webContents.getURL()) ?? "";
          loading = view.webContents.isLoading();
        }
      } catch {
        webContentsDestroyed = true;
      }
    }
    return {
      lifecycle: this.lifecycle,
      isOpen: this.isOpen,
      readerView: {
        exists: Boolean(view),
        objectIdentifier: this.viewObjectIdentifier,
        webContentsId,
        webContentsDestroyed,
        url,
        loading,
        getVisible: readerVisible,
        bounds: readerBounds
      },
      lastValidBounds: this.lastValidBounds,
      boundsVisible: this.layoutVisible,
      layoutVisible: this.layoutVisible,
      windowHidden: this.windowHidden,
      rendererOcclusionReasons: [...this.rendererOcclusionReasons],
      boundsRevision: this.latestBoundsRevision,
      occlusionRevision: this.latestOcclusionRevision,
      navigationEpoch: this.navigationEpoch,
      navigation: {
        pendingUrl: safeDiagnosticUrl(this.pendingUrl),
        committedUrl: safeDiagnosticUrl(this.committedUrl),
        lastReadableUrl: safeDiagnosticUrl(this.state.progress.lastReadableUrl),
        title: this.title,
        loading: this.loading
      },
      window: {
        destroyed: windowDestroyed,
        id: windowDestroyed ? null : this.window.id,
        visible: windowDestroyed ? null : this.window.isVisible(),
        minimized: windowDestroyed ? null : this.window.isMinimized()
      },
      parent: {
        currentContentViewObjectIdentifier: currentContentView ? objectIdentifier(currentContentView) : null,
        addedContentViewObjectIdentifier: this.addedContentView ? objectIdentifier(this.addedContentView) : null,
        childCount: children.length,
        readerIncluded: readerIndex >= 0,
        readerIndex,
        readerIsLastChild: readerIndex >= 0 && readerIndex === children.length - 1,
        readerIsTopmost: readerIndex >= 0 && readerIndex === children.length - 1,
        childrenAfterReader: readerIndex >= 0 ? children.length - readerIndex - 1 : null,
        addedContentViewMatchesCurrent: Boolean(currentContentView && this.addedContentView === currentContentView),
        children: childSnapshots
      }
    };
  }

  private isValidRendererDiagnosticSnapshot(snapshot: NovelViewerRendererDiagnosticSnapshot): boolean {
    const rectIsValid = (rect: { x: number; y: number; width: number; height: number } | undefined): boolean =>
      Boolean(rect) && [rect!.x, rect!.y, rect!.width, rect!.height].every(
        (value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_BOUND_VALUE
      );
    const elementIsValid = (element: NovelViewerRendererDiagnosticSnapshot["pane"]): boolean =>
      Boolean(element) &&
      typeof element.isConnected === "boolean" &&
      rectIsValid(element.rect) &&
      Number.isInteger(element.offsetWidth) &&
      Number.isInteger(element.offsetHeight) &&
      element.offsetWidth >= 0 &&
      element.offsetHeight >= 0 &&
      typeof element.display === "string" &&
      element.display.length <= 80 &&
      typeof element.visibility === "string" &&
      element.visibility.length <= 80;
    return Boolean(
      snapshot &&
      elementIsValid(snapshot.pane) &&
      elementIsValid(snapshot.slot) &&
      typeof snapshot.open === "boolean" &&
      typeof snapshot.narrowFallback === "boolean" &&
      typeof snapshot.splitMode === "string" && snapshot.splitMode.length <= 40 &&
      Array.isArray(snapshot.occlusionReasons) &&
      snapshot.occlusionReasons.every((reason) => OCCLUSION_REASONS.has(reason)) &&
      Number.isInteger(snapshot.layoutRevision) && snapshot.layoutRevision >= 0 &&
      typeof snapshot.nativeViewExpected === "boolean" &&
      typeof snapshot.placeholderVisible === "boolean" &&
      typeof snapshot.placeholderText === "string" && snapshot.placeholderText.length <= 500 &&
      typeof snapshot.title === "string" && snapshot.title.length <= 300 &&
      typeof snapshot.url === "string" && snapshot.url.length <= 4096 &&
      ["closed", "creating", "visible", "occluded", "error", "closing"].includes(snapshot.lifecycle)
    );
  }

  private updateLifecycleAndVisibility(): void {
    if (!this.isOpen) this.lifecycle = "closed";
    else if (this.error) this.lifecycle = "error";
    else if (this.lifecycle !== "creating") this.lifecycle = this.occluded ? "occluded" : "visible";
    else this.lifecycle = this.occluded ? "occluded" : "visible";
    this.applyViewVisibility();
    if (this.isOpen && !this.occluded && !this.error && this.committedUrl && (!this.layoutVisible || !this.lastValidBounds)) {
      this.scheduleWindowBoundsRefresh(0);
    }
    this.emitStatus();
  }

  private applyViewVisibility(context = "visibility-reconcile"): void {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    const bounds = this.lastValidBounds;
    const visible = Boolean(
      this.isOpen && !this.occluded && !this.error && this.committedUrl && this.layoutVisible && bounds
    );
    if (visible && bounds) {
      this.addReaderViewToCurrentContentView(this.view, context);
      this.setReaderViewBounds(this.view, bounds, context);
      this.setReaderViewVisible(this.view, true, context);
      const applied = this.view.getBounds();
      if (
        !this.view.getVisible() ||
        applied.x !== bounds.x ||
        applied.y !== bounds.y ||
        applied.width !== bounds.width ||
        applied.height !== bounds.height
      ) {
        this.scheduleWindowBoundsRefresh();
      }
    } else {
      this.setReaderViewVisible(this.view, false, context);
      this.setReaderViewBounds(this.view, { x: 0, y: 0, width: 0, height: 0 }, context);
    }
  }

  private emitStatus(): void {
    this.sendToEditor("novel-viewer:state", this.status);
  }

  private sendToEditor(channel: string, ...args: unknown[]): void {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
    this.window.webContents.send(channel, ...args);
  }

  private async disposeView(preserveWasOpen: boolean, checkpointTimeout: number): Promise<void> {
    if (this.windowBoundsRefreshTimer) {
      clearTimeout(this.windowBoundsRefreshTimer);
      this.windowBoundsRefreshTimer = null;
    }
    if (!this.view) {
      this.clearRestoreTimers();
      this.clearDeferredTimers();
      if (this.checkpointTimer) {
        clearInterval(this.checkpointTimer);
        this.checkpointTimer = null;
      }
      if (!preserveWasOpen && !this.stateCorrupt) this.state.ui.wasOpen = false;
      return;
    }
    this.lifecycle = "closing";
    this.loading = false;
    const checkpointEpoch = this.navigationEpoch;
    this.clearRestoreTimers();
    this.clearDeferredTimers();
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    const contents = this.view.webContents;
    if (!contents.isDestroyed()) contents.stop();
    if (checkpointTimeout > 0) await timeout(this.checkpoint(checkpointEpoch), checkpointTimeout);
    this.navigationEpoch += 1;
    if (!this.stateCorrupt) {
      this.state.ui.wasOpen = preserveWasOpen ? this.state.ui.wasOpen : false;
      await this.persistState(false);
    }
    await this.disposeRemoteOnly();
    this.pendingUrl = undefined;
    this.committedUrl = undefined;
    if (!preserveWasOpen) this.isOpen = false;
    this.lifecycle = preserveWasOpen && this.isOpen ? "closed" : "closed";
  }

  private async disposeRemoteOnly(): Promise<void> {
    const view = this.view;
    if (!view) return;
    this.logDiagnostic("reader-view-dispose-before");
    try {
      this.removeReaderViewFromCurrentContentView(view, "reader-view-dispose");
    } catch {
      // The window may already be tearing down.
    }
    const contents = view.webContents;
    if (!contents.isDestroyed()) {
      contents.removeAllListeners();
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.close({ waitForBeforeUnload: false });
    }
    this.view = null;
    this.viewObjectIdentifier = null;
    this.addedContentView = null;
    this.logDiagnostic("reader-view-dispose-after");
  }

  private detachDeadView(): void {
    const view = this.view;
    if (!view) return;
    this.logDiagnostic("reader-view-detach-dead-before");
    this.clearRestoreTimers();
    this.clearDeferredTimers();
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    try {
      this.removeReaderViewFromCurrentContentView(view, "reader-view-detach-dead");
    } catch {
      // A crashed view may already have detached itself.
    }
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    this.view = null;
    this.viewObjectIdentifier = null;
    this.addedContentView = null;
    this.logDiagnostic("reader-view-detach-dead-after");
  }
}
