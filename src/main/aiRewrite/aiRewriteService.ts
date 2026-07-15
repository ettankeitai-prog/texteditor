import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  AI_REWRITE_MAX_CHARACTERS,
  AI_REWRITE_TIMEOUT_MS,
  buildAiRewritePrompt,
  isAiRewritePresetId,
  validateAiRewriteOutput,
  type AiRewriteConnectionStatus,
  type AiRewriteFailure,
  type AiRewriteRequest,
  type AiRewriteResponse
} from "../../shared/aiRewrite.js";
import {
  CodexAppServerClient,
  CodexAppServerError,
  type CodexAppServerLaunchOptions,
  type CodexAppServerNotification
} from "./codexAppServerClient.js";

type JsonObject = Record<string, unknown>;
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

interface ThreadStartParams {
  model: string;
  cwd: string;
  approvalPolicy: "never";
  sandbox: SandboxMode;
  ephemeral: true;
}

interface ActiveTurn {
  threadId?: string;
  turnId?: string;
  canceled: boolean;
}

interface ReadyState {
  authMode: "chatgpt";
  model: string;
  modelCount: number;
  effort?: string;
  resetAt?: string;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectAt(value: unknown, key: string): JsonObject | null {
  return isObject(value) && isObject(value[key]) ? value[key] as JsonObject : null;
}

function stringAt(value: unknown, key: string): string | undefined {
  return isObject(value) && typeof value[key] === "string" ? value[key] as string : undefined;
}

function findStringByKeys(value: unknown, keys: Set<string>, depth = 0): string | undefined {
  if (depth > 5 || !value) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findStringByKeys(entry, keys, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isObject(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key.toLowerCase()) && typeof child === "string") return child;
    const found = findStringByKeys(child, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function containsTruthyKey(value: unknown, keys: Set<string>, depth = 0): boolean {
  if (depth > 5 || !value) return false;
  if (Array.isArray(value)) return value.some((entry) => containsTruthyKey(entry, keys, depth + 1));
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    (keys.has(key.toLowerCase()) && (child === true || child === "true")) || containsTruthyKey(child, keys, depth + 1)
  );
}

function containsExhaustedUsage(value: unknown, depth = 0): boolean {
  if (depth > 5 || !value) return false;
  if (Array.isArray(value)) return value.some((entry) => containsExhaustedUsage(entry, depth + 1));
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    (key.toLowerCase() === "usedpercent" && typeof child === "number" && Number.isFinite(child) && child >= 100)
    || containsExhaustedUsage(child, depth + 1)
  );
}

function findResetAt(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || !value) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findResetAt(entry, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isObject(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (["resetat", "resetsat", "resettime"].includes(key.toLowerCase())) {
      if (typeof child === "string" && child.length <= 100) return child;
      if (typeof child === "number" && Number.isFinite(child) && child > 0) {
        const timestamp = child < 1_000_000_000_000 ? child * 1_000 : child;
        const date = new Date(timestamp);
        if (!Number.isNaN(date.getTime())) return date.toISOString();
      }
    }
    const found = findResetAt(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function modelEffort(model: unknown): string | undefined {
  if (!isObject(model)) return undefined;
  const supported = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.map((entry) => typeof entry === "string" ? entry : stringAt(entry, "reasoningEffort") ?? stringAt(entry, "effort"))
    : [];
  return supported.find((entry) => entry === "low")
    ?? stringAt(model, "defaultReasoningEffort")
    ?? undefined;
}

function failure(code: AiRewriteFailure["code"], message: string, resetAt?: string): AiRewriteFailure {
  return { ok: false, code, message, ...(resetAt ? { resetAt } : {}) };
}

export class AiRewriteService {
  private readonly client: CodexAppServerClient;
  private activeTurn: ActiveTurn | null = null;

  constructor(
    private readonly workspaceDirectory: string,
    launchOptions: CodexAppServerLaunchOptions,
    diagnostic: (event: string, details?: Record<string, unknown>) => void = () => undefined
  ) {
    this.client = new CodexAppServerClient(launchOptions, diagnostic);
  }

  static defaultLaunchOptions(workspaceDirectory: string): CodexAppServerLaunchOptions {
    return {
      command: "codex",
      args: ["app-server"],
      cwd: workspaceDirectory,
      resolveCodexExecutable: true,
      explicitExecutablePath: process.env.TEXTEDITOR_CODEX_EXECUTABLE ?? process.env.TEXTEDITOR_CODEX_PATH
    };
  }

  async status(): Promise<AiRewriteConnectionStatus> {
    if (this.activeTurn) return { state: "ready", message: "AI文章整形を実行中です。" };
    try {
      const ready = await this.ensureReady();
      return {
        state: "ready",
        message: "ChatGPTプランのCodex利用枠を使用できます。",
        authMode: ready.authMode,
        model: ready.model,
        availableModelCount: ready.modelCount,
        resetAt: ready.resetAt
      };
    } catch (error) {
      return this.connectionFailure(error);
    }
  }

  async run(request: AiRewriteRequest): Promise<AiRewriteResponse> {
    if (this.activeTurn) return failure("busy", "AI文章整形はすでに実行中です。");
    if (!isAiRewritePresetId(request?.preset) || typeof request?.text !== "string") {
      return failure("invalid-output", "AI文章整形の入力が不正です。");
    }
    if (!request.text.trim()) return failure("empty-input", "整形する文章がありません。");
    if (request.text.length > AI_REWRITE_MAX_CHARACTERS) {
      return failure("input-too-large", `文章は${AI_REWRITE_MAX_CHARACTERS.toLocaleString("ja-JP")}文字以内にしてください。`);
    }

    const active: ActiveTurn = { canceled: false };
    this.activeTurn = active;
    try {
      const ready = await this.ensureReady();
      const threadStartParams: ThreadStartParams = {
        model: ready.model,
        cwd: this.workspaceDirectory,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true
      };
      const threadResult = await this.client.request("thread/start", threadStartParams, 20_000);
      active.threadId = stringAt(objectAt(threadResult, "thread"), "id") ?? stringAt(threadResult, "threadId");
      if (!active.threadId) throw new CodexAppServerError("protocol-error", "Codex App Serverがthread IDを返しませんでした。");
      if (active.canceled) throw new CodexAppServerError("canceled", "AI文章整形をキャンセルしました。");
      const rawOutput = await this.executeTurn(active, ready.model, ready.effort, buildAiRewritePrompt(request.preset, request.text));
      const rewrittenText = validateAiRewriteOutput(request.text, rawOutput);
      if (!rewrittenText) return failure("empty-output", "Codexから有効な整形結果を取得できませんでした。");
      return { ok: true, rewrittenText, model: ready.model };
    } catch (error) {
      return this.runFailure(error);
    } finally {
      if (this.activeTurn === active) this.activeTurn = null;
    }
  }

  private async executeTurn(active: ActiveTurn, model: string, effort: string | undefined, prompt: string): Promise<string> {
    let deltaText = "";
    let completedText = "";
    let settled = false;
    let resolveCompletion: (value: string) => void = () => undefined;
    let rejectCompletion: (error: Error) => void = () => undefined;
    const completion = new Promise<string>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const unsubscribe = this.client.onNotification((notification) => {
      if (settled) return;
      const turnId = this.notificationTurnId(notification);
      if (active.turnId && turnId && turnId !== active.turnId) return;
      if (notification.method === "item/agentMessage/delta") {
        const delta = stringAt(notification.params, "delta");
        if (delta) deltaText += delta;
      } else if (notification.method === "item/completed") {
        const item = objectAt(notification.params, "item");
        if (item && stringAt(item, "type") === "agentMessage") {
          const text = stringAt(item, "text") ?? stringAt(item, "message") ?? findStringByKeys(item.content, new Set(["text"]));
          if (text) completedText = text;
        }
      } else if (notification.method === "turn/completed") {
        const turn = objectAt(notification.params, "turn");
        const status = stringAt(turn, "status") ?? stringAt(notification.params, "status") ?? "completed";
        settled = true;
        if (/fail|error/i.test(status)) {
          const message = findStringByKeys(notification.params, new Set(["message", "error"]));
          rejectCompletion(new CodexAppServerError(/rate|quota|limit/i.test(message ?? "") ? "quota-exceeded" : "protocol-error", message ?? "Codexの処理に失敗しました。"));
        } else if (/interrupt|cancel/i.test(status) || active.canceled) {
          rejectCompletion(new CodexAppServerError("canceled", "AI文章整形をキャンセルしました。"));
        } else {
          resolveCompletion(completedText || deltaText);
        }
      } else if (notification.method === "client/process-exited" || notification.method === "client/protocol-error") {
        settled = true;
        rejectCompletion(new CodexAppServerError(
          notification.method === "client/protocol-error" ? "protocol-error" : "server-exited",
          notification.method === "client/protocol-error" ? "Codex App Serverから不正な応答を受信しました。" : "Codex App Serverが終了しました。"
        ));
      }
    });

    let timeout: NodeJS.Timeout | null = null;
    try {
      const turnResult = await this.client.request("turn/start", {
        threadId: active.threadId,
        input: [{ type: "text", text: prompt }],
        model,
        ...(effort ? { effort } : {}),
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
        outputSchema: {
          type: "object",
          properties: { rewrittenText: { type: "string" } },
          required: ["rewrittenText"],
          additionalProperties: false
        }
      }, 20_000);
      active.turnId = stringAt(objectAt(turnResult, "turn"), "id") ?? stringAt(turnResult, "turnId");
      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (active.threadId && active.turnId) {
          void this.client.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }, 5_000).catch(() => undefined);
        }
        rejectCompletion(new CodexAppServerError("timeout", "AI文章整形がタイムアウトしました。"));
      }, AI_REWRITE_TIMEOUT_MS);
      return await completion;
    } finally {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
    }
  }

  private notificationTurnId(notification: CodexAppServerNotification): string | undefined {
    return stringAt(objectAt(notification.params, "turn"), "id") ?? stringAt(notification.params, "turnId");
  }

  async cancel(): Promise<boolean> {
    const active = this.activeTurn;
    if (!active) return false;
    active.canceled = true;
    if (active.threadId && active.turnId) {
      await this.client.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }, 5_000).catch(() => undefined);
    }
    return true;
  }

  private async ensureReady(): Promise<ReadyState> {
    await mkdir(this.workspaceDirectory, { recursive: true });
    await this.client.start();
    const accountResult = await this.client.request("account/read", { refreshToken: false }, 15_000);
    const account = objectAt(accountResult, "account");
    if (!account) throw new CodexAppServerError("not-logged-in", "Codex CLIでChatGPTアカウントへログインしてください。");
    const authText = [
      stringAt(account, "type"),
      stringAt(account, "authMode"),
      stringAt(account, "authenticationMethod"),
      stringAt(account, "provider")
    ].filter(Boolean).join(" ").toLowerCase();
    if (/api.?key|apikey/.test(authText)) {
      throw new CodexAppServerError("api-key-auth", "この機能はChatGPTプランのCodex利用枠のみ対応しています。API従量課金には対応していません。");
    }
    if (!/chatgpt|chat.?gpt|subscription/.test(authText) && authText) {
      const email = stringAt(account, "email");
      if (!email) throw new CodexAppServerError("not-logged-in", "ChatGPTアカウントでCodex CLIへログインしてください。");
    }

    const modelResult = await this.client.request("model/list", { cursor: null, limit: 100 }, 15_000);
    const candidates = (isObject(modelResult) && Array.isArray(modelResult.data) ? modelResult.data : isObject(modelResult) && Array.isArray(modelResult.models) ? modelResult.models : [])
      .filter(isObject);
    const defaultModel = stringAt(modelResult, "defaultModel") ?? stringAt(modelResult, "defaultModelId");
    const model = candidates.find((entry) => entry.id === defaultModel)
      ?? candidates.find((entry) => entry.isDefault === true || entry.default === true)
      ?? candidates.find((entry) => {
        const tier = `${stringAt(entry, "latencyClass") ?? ""} ${stringAt(entry, "performanceTier") ?? ""}`.toLowerCase();
        return entry.isLightweight === true || /light|fast/.test(tier);
      })
      ?? candidates[0];
    const modelId = stringAt(model, "id") ?? stringAt(model, "model");
    if (!modelId) throw new CodexAppServerError("no-models", "利用可能なCodexモデルがありません。");

    let resetAt: string | undefined;
    try {
      const limits = await this.client.request("account/rateLimits/read", {}, 10_000);
      if (containsTruthyKey(limits, new Set(["limitreached", "quotaexhausted", "exhausted", "spendcontrolreached"])) || containsExhaustedUsage(limits)) {
        resetAt = findResetAt(limits);
        throw new CodexAppServerError("quota-exceeded", "Codexの利用枠に到達しました。", undefined, resetAt);
      }
      resetAt = findResetAt(limits);
    } catch (error) {
      if (error instanceof CodexAppServerError && error.code === "quota-exceeded") throw error;
      // Older app-server versions may not expose rate limits. Turn errors remain authoritative.
    }
    return { authMode: "chatgpt", model: modelId, modelCount: candidates.length, effort: modelEffort(model), resetAt };
  }

  private connectionFailure(error: unknown): AiRewriteConnectionStatus {
    const converted = this.runFailure(error);
    const state = converted.code === "not-logged-in" ? "not-logged-in"
      : converted.code === "api-key-auth" ? "api-key-auth"
      : converted.code === "quota-exceeded" ? "quota-exceeded"
      : converted.code === "cli-not-found" || converted.code === "launch-failed" ? "unavailable"
      : "error";
    return { state, message: converted.message, authMode: converted.code === "api-key-auth" ? "api-key" : undefined, resetAt: converted.resetAt };
  }

  private runFailure(error: unknown): AiRewriteFailure {
    if (error instanceof CodexAppServerError) {
      const messages: Partial<Record<CodexAppServerError["code"], string>> = {
        "cli-not-found": "Codex CLIが見つかりません。Codex CLIをインストールして、ChatGPTアカウントでログインしてください。",
        "launch-failed": "Codex App Serverを起動できませんでした。",
        "not-logged-in": "Codex CLIでChatGPTアカウントへログインしてください。",
        "api-key-auth": "この機能はChatGPTプランのCodex利用枠のみ対応しています。API従量課金には対応していません。",
        "no-models": "利用可能なCodexモデルがありません。",
        "quota-exceeded": "Codexの利用枠に到達しました。",
        "timeout": "AI文章整形がタイムアウトしました。",
        "canceled": "AI文章整形をキャンセルしました。",
        "server-exited": "Codex App Serverが予期せず終了しました。",
        "protocol-error": "Codex App Serverとの通信に失敗しました。"
      };
      return failure(error.code, messages[error.code] ?? error.message, error.resetAt);
    }
    return failure("protocol-error", "AI文章整形に失敗しました。");
  }

  async shutdown(): Promise<void> {
    void this.cancel().catch(() => undefined);
    await this.client.close();
  }
}

export function createAiRewriteLaunchOptions(workspaceDirectory: string, packaged: boolean): CodexAppServerLaunchOptions {
  const mockPath = !packaged ? process.env.TEXTEDITOR_CODEX_APP_SERVER_MOCK : undefined;
  if (mockPath && path.isAbsolute(mockPath)) {
    return {
      command: process.execPath,
      args: [mockPath],
      cwd: workspaceDirectory,
      env: { ELECTRON_RUN_AS_NODE: "1" }
    };
  }
  return AiRewriteService.defaultLaunchOptions(workspaceDirectory);
}
