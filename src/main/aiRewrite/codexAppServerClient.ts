import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import type { AiRewriteErrorCode } from "../../shared/aiRewrite.js";
import { resolveCodexExecutable } from "./codexExecutableResolver.js";

type JsonObject = Record<string, unknown>;
const SPAWN_TIMEOUT_MS = 5_000;
const INITIALIZE_TIMEOUT_MS = 10_000;
const STDERR_PREFIX_LIMIT = 4_096;

export class CodexAppServerError extends Error {
  constructor(
    public readonly code: AiRewriteErrorCode,
    message: string,
    public readonly rpcCode?: number,
    public readonly resetAt?: string
  ) {
    super(message);
    this.name = "CodexAppServerError";
  }
}

export interface CodexAppServerNotification {
  method: string;
  params?: unknown;
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CodexAppServerLaunchOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  resolveCodexExecutable?: boolean;
  explicitExecutablePath?: string;
  commandSource?: string;
}

function safeChildEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of Object.keys(environment)) {
    if (["OPENAI_API_KEY", "CODEX_API_KEY", "AZURE_OPENAI_API_KEY"].includes(key.toUpperCase())) {
      delete environment[key];
    }
  }
  return environment;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadLineInterface | null = null;
  private requestSequence = 0;
  private pending = new Map<number, PendingRequest>();
  private notificationListeners = new Set<(notification: CodexAppServerNotification) => void>();
  private starting: Promise<void> | null = null;
  private closing = false;
  private resolvedExecutablePath = "";
  private resolvedExecutableSource = "";
  private stderrPrefix = "";
  private stderrBytes = 0;
  private initializeRequestSent = false;
  private initializeResponseReceived = false;

  constructor(
    private readonly launchOptions: CodexAppServerLaunchOptions,
    private readonly onDiagnostic: (event: string, details?: Record<string, unknown>) => void = () => undefined
  ) {}

  isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;
    if (this.starting) return this.starting;
    this.starting = this.startInternal().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startInternal(): Promise<void> {
    this.closing = false;
    this.stderrPrefix = "";
    this.stderrBytes = 0;
    this.initializeRequestSent = false;
    this.initializeResponseReceived = false;
    let command = this.launchOptions.command;
    let commandSource = this.launchOptions.commandSource ?? "configured";
    if (this.launchOptions.resolveCodexExecutable) {
      try {
        const resolved = await resolveCodexExecutable({
          explicitPath: this.launchOptions.explicitExecutablePath,
          env: safeChildEnvironment(this.launchOptions.env),
          onDiagnostic: this.onDiagnostic
        });
        command = resolved.executablePath;
        commandSource = resolved.source;
      } catch (error) {
        const wrapped = this.launchError(error);
        this.onDiagnostic("startup-failed", {
          errorCode: wrapped.code,
          initializeRequestSent: false,
          initializeResponseReceived: false
        });
        throw wrapped;
      }
    }
    this.resolvedExecutablePath = command;
    this.resolvedExecutableSource = commandSource;
    this.onDiagnostic("spawn-start", {
      resolvedExecutablePath: command,
      executableSource: commandSource,
      commandArgs: this.launchOptions.args.join(" "),
      spawnTimeoutMs: SPAWN_TIMEOUT_MS,
      initializeTimeoutMs: INITIALIZE_TIMEOUT_MS
    });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, this.launchOptions.args, {
        cwd: this.launchOptions.cwd,
        env: safeChildEnvironment(this.launchOptions.env),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      const wrapped = this.launchError(error);
      this.onDiagnostic("spawn-error", {
        resolvedExecutablePath: command,
        spawnErrorCode: this.nodeErrorCode(error) ?? wrapped.code,
        initializeRequestSent: false,
        initializeResponseReceived: false
      });
      throw wrapped;
    }
    this.child = child;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer | string) => {
      const value = String(chunk);
      this.stderrBytes += Buffer.byteLength(chunk);
      if (!this.initializeResponseReceived && this.stderrPrefix.length < STDERR_PREFIX_LIMIT) {
        this.stderrPrefix += value.slice(0, STDERR_PREFIX_LIMIT - this.stderrPrefix.length);
      }
    });
    child.once("error", (error) => this.handleProcessError(child, error));
    child.once("exit", (code, signal) => this.handleExit(child, code, signal));
    child.once("close", (code, signal) => {
      this.onDiagnostic("process-close", {
        resolvedExecutablePath: command,
        exitCode: code ?? -1,
        signal: signal ?? "none",
        stderrBytes: this.stderrBytes,
        stderrPrefix: this.stderrPrefix,
        initializeRequestSent: this.initializeRequestSent,
        initializeResponseReceived: this.initializeResponseReceived
      });
    });

    try {
      await this.waitForSpawn(child);
      await this.request("initialize", {
        clientInfo: {
          name: "texteditor_ai_rewrite",
          title: "Text Editor AI Rewrite",
          version: "2.1.0"
        }
      }, INITIALIZE_TIMEOUT_MS);
      this.notify("initialized", {});
      this.onDiagnostic("initialized-notification-sent", {
        resolvedExecutablePath: this.resolvedExecutablePath,
        initializeRequestSent: this.initializeRequestSent,
        initializeResponseReceived: this.initializeResponseReceived
      });
    } catch (error) {
      const wrapped = error instanceof CodexAppServerError ? error : this.launchError(error);
      this.onDiagnostic("startup-failed", {
        resolvedExecutablePath: this.resolvedExecutablePath,
        errorCode: wrapped.code,
        stderrBytes: this.stderrBytes,
        stderrPrefix: this.stderrPrefix,
        initializeRequestSent: this.initializeRequestSent,
        initializeResponseReceived: this.initializeResponseReceived
      });
      await this.close();
      throw wrapped;
    }
  }

  private waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        if (child.exitCode === null) child.kill();
        this.onDiagnostic("spawn-timeout", {
          resolvedExecutablePath: this.resolvedExecutablePath,
          timeoutMs: SPAWN_TIMEOUT_MS
        });
        reject(new CodexAppServerError("launch-failed", "Codex App Serverの起動がタイムアウトしました。"));
      }, SPAWN_TIMEOUT_MS);
      const onSpawn = (): void => {
        cleanup();
        this.onDiagnostic("spawn-success", {
          resolvedExecutablePath: this.resolvedExecutablePath,
          executableSource: this.resolvedExecutableSource,
          processId: child.pid ?? -1
        });
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        this.onDiagnostic("spawn-error", {
          resolvedExecutablePath: this.resolvedExecutablePath,
          spawnErrorCode: this.nodeErrorCode(error) ?? "UNKNOWN"
        });
        reject(this.launchError(error));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  async request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (!this.isRunning()) {
      if (method === "initialize") {
        if (!this.child) throw new CodexAppServerError("launch-failed", "Codex App Serverを起動できませんでした。");
      } else {
        await this.start();
      }
    }
    const child = this.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) {
      throw new CodexAppServerError("server-exited", "Codex App Serverが終了しました。");
    }
    const id = ++this.requestSequence;
    if (method === "initialize") this.initializeRequestSent = true;
    if (method === "thread/start") {
      const threadParams = isJsonObject(params) ? params : {};
      this.onDiagnostic("thread-start-request", {
        method: this.safeMethod(method),
        requestId: id,
        params: threadParams,
        model: typeof threadParams.model === "string" ? threadParams.model : null,
        cwd: typeof threadParams.cwd === "string" ? threadParams.cwd : null,
        approvalPolicy: typeof threadParams.approvalPolicy === "string" ? threadParams.approvalPolicy : null,
        sandbox: typeof threadParams.sandbox === "string" ? threadParams.sandbox : threadParams.sandbox ?? null
      });
    }
    this.onDiagnostic("request-sent", {
      method: this.safeMethod(method),
      requestId: id,
      timeoutMs,
      initializeRequestSent: this.initializeRequestSent,
      initializeResponseReceived: this.initializeResponseReceived
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.onDiagnostic("request-timeout", {
          method: this.safeMethod(method),
          requestId: id,
          timeoutMs,
          initializeRequestSent: this.initializeRequestSent,
          initializeResponseReceived: this.initializeResponseReceived
        });
        reject(new CodexAppServerError("timeout", "Codex App Serverからの応答がタイムアウトしました。"));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, "utf8");
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.onDiagnostic("request-write-failed", {
          method: this.safeMethod(method),
          requestId: id,
          errorCode: this.nodeErrorCode(error) ?? "WRITE_FAILED"
        });
        reject(new CodexAppServerError("server-exited", "Codex App Serverへ送信できませんでした。"));
      }
    });
  }

  notify(method: string, params: unknown): void {
    const child = this.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify({ method, params })}\n`, "utf8");
  }

  onNotification(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.onDiagnostic("protocol-parse-failed", { bytes: Buffer.byteLength(line) });
      const error = new CodexAppServerError("protocol-error", "Codex App Serverから不正な応答を受信しました。");
      this.rejectAll(error);
      this.emitNotification({ method: "client/protocol-error" });
      return;
    }
    if (!isJsonObject(message)) return;
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.onDiagnostic("response-unmatched", {
          responseId: message.id,
          hasError: "error" in message,
          pendingRequestCount: this.pending.size
        });
        return;
      }
      if (pending.method === "initialize") this.initializeResponseReceived = true;
      this.onDiagnostic("response-received", {
        method: this.safeMethod(pending.method),
        responseId: message.id,
        requestIdMatched: true,
        hasError: isJsonObject(message.error),
        initializeRequestSent: this.initializeRequestSent,
        initializeResponseReceived: this.initializeResponseReceived
      });
      if (pending.method === "thread/start" && isJsonObject(message.error)) {
        this.onDiagnostic("thread-start-response-error", {
          method: this.safeMethod(pending.method),
          responseId: message.id,
          requestIdMatched: true,
          error: {
            code: typeof message.error.code === "number" || typeof message.error.code === "string" ? message.error.code : null,
            message: typeof message.error.message === "string" ? message.error.message : null,
            data: "data" in message.error ? message.error.data : null
          }
        });
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (isJsonObject(message.error)) {
        const rpcCode = typeof message.error.code === "number" ? message.error.code : undefined;
        const rpcMessage = typeof message.error.message === "string" ? message.error.message : "Codex App Server request failed.";
        pending.reject(new CodexAppServerError(this.classifyRpcError(rpcMessage), this.safeRpcMessage(rpcMessage), rpcCode));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string" && "id" in message) {
      this.rejectServerRequest(message.id, message.method);
      return;
    }
    if (typeof message.method === "string") {
      const notification = { method: message.method, params: message.params };
      this.emitNotification(notification);
    }
  }

  private rejectServerRequest(id: unknown, method: string): void {
    const child = this.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) return;
    const response = {
      id,
      error: {
        code: -32601,
        message: "This text-only integration does not permit tools, approvals, or host actions."
      }
    };
    child.stdin.write(`${JSON.stringify(response)}\n`, "utf8");
    this.onDiagnostic("server-request-refused", {
      method: /^[A-Za-z0-9_./:-]{1,80}$/.test(method) ? method : "invalid-method"
    });
  }

  private classifyRpcError(message: string): AiRewriteErrorCode {
    const normalized = message.toLowerCase();
    if (/rate.?limit|quota|usage.?limit|insufficient/.test(normalized)) return "quota-exceeded";
    if (/not.?logged|unauth|authentication|required login|sign.?in/.test(normalized)) return "not-logged-in";
    return "protocol-error";
  }

  private safeRpcMessage(message: string): string {
    const code = this.classifyRpcError(message);
    if (code === "quota-exceeded") return "Codexの利用枠に到達しました。";
    if (code === "not-logged-in") return "Codex CLIでChatGPTアカウントへログインしてください。";
    return "Codex App Serverとの通信に失敗しました。";
  }

  private safeMethod(method: string): string {
    return /^[A-Za-z0-9_./:-]{1,100}$/.test(method) ? method : "invalid-method";
  }

  private nodeErrorCode(error: unknown): string | undefined {
    return isJsonObject(error) && typeof error.code === "string" ? error.code : undefined;
  }

  private launchError(error: unknown): CodexAppServerError {
    const nativeCode = this.nodeErrorCode(error);
    const code = nativeCode === "ENOENT" ? "cli-not-found" : "launch-failed";
    return new CodexAppServerError(
      code,
      code === "cli-not-found" ? "Codex CLIが見つかりません。Codex CLIをインストールしてください。" : "Codex App Serverを起動できませんでした。"
    );
  }

  private handleProcessError(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    const wrapped = this.launchError(error);
    this.onDiagnostic("process-error", {
      resolvedExecutablePath: this.resolvedExecutablePath,
      spawnErrorCode: this.nodeErrorCode(error) ?? wrapped.code,
      stderrBytes: this.stderrBytes,
      stderrPrefix: this.stderrPrefix,
      initializeRequestSent: this.initializeRequestSent,
      initializeResponseReceived: this.initializeResponseReceived
    });
    this.lines?.close();
    this.lines = null;
    this.child = null;
    this.rejectAll(wrapped);
    this.emitNotification({ method: "client/process-exited" });
  }

  private handleExit(child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.onDiagnostic("process-exit", {
      resolvedExecutablePath: this.resolvedExecutablePath,
      exitCode: code ?? -1,
      signal: signal ?? "none",
      stderrBytes: this.stderrBytes,
      stderrPrefix: this.stderrPrefix,
      initializeRequestSent: this.initializeRequestSent,
      initializeResponseReceived: this.initializeResponseReceived,
      expected: this.closing
    });
    this.lines?.close();
    this.lines = null;
    this.child = null;
    const error = new CodexAppServerError("server-exited", "Codex App Serverが終了しました。");
    this.rejectAll(error);
    this.emitNotification({ method: "client/process-exited" });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private emitNotification(notification: CodexAppServerNotification): void {
    for (const listener of this.notificationListeners) listener(notification);
  }

  async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    if (!child) return;
    this.onDiagnostic("shutdown-requested", {
      resolvedExecutablePath: this.resolvedExecutablePath,
      pendingRequestCount: this.pending.size
    });
    this.rejectAll(new CodexAppServerError("canceled", "AI文章整形をキャンセルしました。"));
    if (!child.stdin.destroyed) child.stdin.end();
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill();
        resolve();
      }, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
