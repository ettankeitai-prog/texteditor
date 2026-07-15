const readline = require("node:readline");

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let turnSequence = 0;
const pendingTurns = new Map();
process.stderr.write("mock app-server startup diagnostic\n");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function promptText(params) {
  const input = Array.isArray(params?.input) ? params.input : [];
  return input.map((entry) => typeof entry?.text === "string" ? entry.text : "").join("\n");
}

function sourceText(prompt) {
  const match = prompt.match(/--- 対象本文ここから ---\n([\s\S]*?)\n--- 対象本文ここまで ---/);
  return match?.[1] ?? "";
}

function rewrittenText(source) {
  if (source.includes("[CONFLICT_TEST]")) return "競合確認用の整形結果です。";
  return source
    .replace("[CANCEL_TEST]", "")
    .replace(/ {2,}/g, " ")
    .replace(/これは文章。/g, "これは文章です。")
    .trim() || "整形結果";
}

lines.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.method === "initialized") return;
  if (request.method === "initialize") {
    send({ id: request.id, result: { userAgent: "mock", platformFamily: "windows", platformOs: "windows" } });
    return;
  }
  if (request.method === "account/read") {
    const mode = process.env.TEXTEDITOR_CODEX_MOCK_MODE;
    const apiKeyReachedChild = Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.AZURE_OPENAI_API_KEY);
    send({ id: request.id, result: mode === "not-logged-in" ? { account: null } : { account: { type: mode === "api-key" || apiKeyReachedChild ? "apiKey" : "chatgpt", email: "mock@example.invalid" } } });
    return;
  }
  if (request.method === "model/list") {
    send({ id: request.id, result: { data: [{ id: "mock-default", displayName: "Mock default", isDefault: true }] } });
    return;
  }
  if (request.method === "account/rateLimits/read") {
    send({ id: request.id, result: process.env.TEXTEDITOR_CODEX_MOCK_MODE === "quota" ? { limitReached: true, resetAt: "2099-01-01T00:00:00Z" } : { limitReached: false } });
    return;
  }
  if (request.method === "thread/start") {
    if (request.params?.model === "mock-thread-error") {
      send({
        id: request.id,
        error: {
          code: -32602,
          message: "Mock thread configuration rejected",
          data: {
            field: "sandbox",
            reason: "unsupported test value",
            inputText: "mock source body must not be logged",
            rewrittenText: "mock generated body must not be logged"
          }
        }
      });
      return;
    }
    if (request.params?.approvalPolicy !== "never" || request.params?.sandbox !== "read-only" || request.params?.ephemeral !== true || typeof request.params?.cwd !== "string") {
      send({ id: request.id, error: { code: -32602, message: "Unsafe thread configuration" } });
      return;
    }
    send({ id: request.id, result: { thread: { id: `thread-${Date.now()}` } } });
    return;
  }
  if (request.method === "turn/start") {
    if (request.params?.approvalPolicy !== "never" || request.params?.sandboxPolicy?.type !== "readOnly") {
      send({ id: request.id, error: { code: -32602, message: "Unsafe turn configuration" } });
      return;
    }
    const turnId = `turn-${++turnSequence}`;
    const prompt = promptText(request.params);
    send({ id: request.id, result: { turn: { id: turnId, status: "inProgress" } } });
    const delay = /\[(?:CANCEL|CONFLICT)_TEST\]/.test(prompt) ? 350 : 10;
    const timer = setTimeout(() => {
      pendingTurns.delete(turnId);
      const output = JSON.stringify({ rewrittenText: rewrittenText(sourceText(prompt)) });
      send({ method: "item/agentMessage/delta", params: { threadId: request.params.threadId, turnId, delta: output } });
      send({ method: "item/completed", params: { threadId: request.params.threadId, turnId, item: { type: "agentMessage", text: output } } });
      send({ method: "turn/completed", params: { threadId: request.params.threadId, turn: { id: turnId, status: "completed" } } });
    }, delay);
    pendingTurns.set(turnId, timer);
    return;
  }
  if (request.method === "turn/interrupt") {
    const timer = pendingTurns.get(request.params?.turnId);
    if (timer) clearTimeout(timer);
    pendingTurns.delete(request.params?.turnId);
    send({ id: request.id, result: {} });
    send({ method: "turn/completed", params: { threadId: request.params?.threadId, turn: { id: request.params?.turnId, status: "interrupted" } } });
    return;
  }
  if (request.method === "test/exit") {
    process.exit(2);
  }
  if (request.method === "test/malformed") {
    process.stdout.write("not-json\n");
    return;
  }
  // Unknown test methods intentionally receive no response so timeout behavior can be tested.
});

process.stdin.on("end", () => process.exit(0));
