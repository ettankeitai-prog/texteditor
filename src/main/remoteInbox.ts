import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RemoteInboxSettings } from "../shared/schema.js";

const MAX_BODY_BYTES = 100 * 1024;
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

type Jose = typeof import("jose");
type AppendResult = { ok: true; receivedAt: string } | { ok: false; error: string };

export interface RemoteInboxServerOptions {
  dataRoot: () => string;
  append: (text: string, includeTimestamp: boolean, targetTabName: string) => Promise<AppendResult>;
  getSettings: () => RemoteInboxSettings;
  onStatus: (status: RemoteInboxStatus) => void;
}

export interface RemoteInboxStatus {
  state: "stopped" | "running" | "error";
  message?: string;
  url?: string;
}

export class RemoteInboxServer {
  private server: Server | null = null;
  private currentPort: number | null = null;
  private readonly csrfTokens = new Map<string, number>();
  private readonly rateLimits = new Map<string, number[]>();
  private readonly jwks = new Map<string, ReturnType<Jose["createRemoteJWKSet"]>>();

  constructor(private readonly options: RemoteInboxServerOptions) {}

  async configure(): Promise<RemoteInboxStatus> {
    const settings = this.options.getSettings();
    if (!settings.enabled) {
      await this.stop();
      return { state: "stopped" };
    }
    if (!validSettings(settings)) {
      const status = { state: "error" as const, message: "Remote Inbox settings are incomplete or invalid." };
      this.options.onStatus(status);
      return status;
    }
    if (this.server && this.currentPort === settings.port) {
      return { state: "running", url: `http://127.0.0.1:${settings.port}` };
    }
    await this.stop();
    try {
      this.server = createServer((request, response) => void this.handle(request, response));
      await new Promise<void>((resolve, reject) => {
        const server = this.server!;
        server.once("error", reject);
        server.listen(settings.port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      this.currentPort = settings.port;
      const status = { state: "running" as const, url: `http://127.0.0.1:${settings.port}` };
      this.options.onStatus(status);
      return status;
    } catch (error) {
      this.server?.close();
      this.server = null;
      this.currentPort = null;
      const status = { state: "error" as const, message: error instanceof Error ? error.message : "Unable to start server." };
      this.options.onStatus(status);
      return status;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.currentPort = null;
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.options.onStatus({ state: "stopped" });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    securityHeaders(response);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, { ok: true, version: "1.6.0" });
    if (request.method === "GET" && url.pathname === "/") return this.form(request, response);
    if (request.method === "POST" && url.pathname === "/api/append") return this.append(request, response);
    json(response, 404, { ok: false, error: "Not found" });
  }

  private form(_request: IncomingMessage, response: ServerResponse): void {
    const token = randomBytes(24).toString("base64url");
    this.csrfTokens.set(token, Date.now() + 30 * 60_000);
    response.setHeader("Set-Cookie", `remoteInboxCsrf=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=1800`);
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(formHtml(token, targetNames(this.options.getSettings())));
  }

  private async append(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const settings = this.options.getSettings();
    const origin = request.headers.origin;
    if (origin && origin !== `https://${request.headers.host}`) return json(response, 403, { ok: false, error: "Invalid origin" });
    const csrf = request.headers["x-csrf-token"];
    const cookie = request.headers.cookie?.match(/(?:^|;\s*)remoteInboxCsrf=([^;]+)/)?.[1];
    if (typeof csrf !== "string" || !cookie || csrf !== cookie || this.csrfTokens.get(csrf)! < Date.now()) {
      await this.audit("failure", undefined, 0, "csrf");
      return json(response, 403, { ok: false, error: "Invalid request token" });
    }
    if (request.headers["content-type"]?.split(";")[0].toLowerCase() !== "application/json") return json(response, 400, { ok: false, error: "Content-Type must be application/json" });
    let payload: unknown;
    try { payload = JSON.parse(await readBody(request)); } catch (error) {
      const status = error instanceof Error && error.message === "too-large" ? 413 : 400;
      return json(response, status, { ok: false, error: status === 413 ? "Request too large" : "Invalid JSON" });
    }
    if (!payload || typeof payload !== "object" || typeof (payload as { text?: unknown }).text !== "string" || !(payload as { text: string }).text.trim()) return json(response, 400, { ok: false, error: "Text is required" });
    const text = (payload as { text: string }).text;
    const requestedTarget = (payload as { target?: unknown }).target;
    const targets = targetNames(settings);
    const targetTabName = requestedTarget === undefined ? settings.targetTabName : typeof requestedTarget === "string" && isValidTargetName(requestedTarget) && targets.includes(requestedTarget) ? requestedTarget : "";
    const assertion = request.headers["cf-access-jwt-assertion"];
    if (typeof assertion !== "string") { await this.audit("failure", undefined, Buffer.byteLength(text), "auth"); return json(response, 401, { ok: false, error: "Authentication required" }); }
    let email: string;
    try { email = await this.verify(assertion, settings); } catch { await this.audit("failure", undefined, Buffer.byteLength(text), "jwt"); return json(response, 403, { ok: false, error: "Authentication rejected" }); }
    if (!targetTabName) { await this.audit("failure", email, Buffer.byteLength(text), "target"); return json(response, 400, { ok: false, error: "Invalid target" }); }
    if (!this.allow(email)) { await this.audit("failure", email, Buffer.byteLength(text), "rate-limit"); return json(response, 429, { ok: false, error: "Too many requests" }); }
    const result = await this.options.append(text, settings.includeTimestamp, targetTabName);
    await this.audit(result.ok ? "success" : "failure", email, Buffer.byteLength(text), result.ok ? undefined : "save");
    if (!result.ok) return json(response, 500, { ok: false, error: "Could not save note" });
    json(response, 200, result);
  }

  private async verify(token: string, settings: RemoteInboxSettings): Promise<string> {
    const jose: Jose = await new Function("moduleName", "return import(moduleName)")("jose") as Jose;
    const domain = settings.accessTeamDomain.replace(/\/$/, "");
    let jwks = this.jwks.get(domain);
    if (!jwks) { jwks = jose.createRemoteJWKSet(new URL(`${domain}/cdn-cgi/access/certs`)); this.jwks.set(domain, jwks); }
    const verified = await jose.jwtVerify(token, jwks, { issuer: domain, audience: settings.accessAudience, algorithms: ["RS256"] });
    const email = typeof verified.payload.email === "string" ? verified.payload.email.trim().toLowerCase() : "";
    if (!email || email !== settings.allowedEmail.trim().toLowerCase()) throw new Error("email");
    return email;
  }

  private allow(email: string): boolean {
    const now = Date.now();
    const entries = (this.rateLimits.get(email) ?? []).filter((at) => at > now - RATE_WINDOW_MS);
    if (entries.length >= RATE_LIMIT) return false;
    entries.push(now); this.rateLimits.set(email, entries); return true;
  }

  private async audit(result: "success" | "failure", email: string | undefined, size: number, error?: string): Promise<void> {
    const file = path.join(this.options.dataRoot(), "remote-inbox.log");
    await mkdir(path.dirname(file), { recursive: true });
    let entries: string[] = [];
    try { entries = (await readFile(file, "utf8")).split("\n").filter(Boolean).slice(-499); } catch { /* first audit entry */ }
    entries.push(JSON.stringify({ receivedAt: new Date().toISOString(), result, email, size, error }));
    await writeFile(file, `${entries.join("\n")}\n`, "utf8");
  }
}

function validSettings(value: RemoteInboxSettings): boolean {
  try { const url = new URL(value.accessTeamDomain); return url.protocol === "https:" && Boolean(url.hostname) && Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535 && isValidTargetName(value.targetTabName) && Boolean(value.accessAudience.trim()) && /^\S+@\S+\.\S+$/.test(value.allowedEmail.trim()); } catch { return false; }
}
function isValidTargetName(value: string): boolean { return value === value.trim() && value.length > 0 && value.length <= 120 && !/[\u0000-\u001F\u007F]/.test(value); }
function targetNames(settings: RemoteInboxSettings): string[] {
  const names = Array.isArray(settings.targetTabNames) ? settings.targetTabNames.filter(isValidTargetName) : [];
  return [...new Set(names)].length ? [...new Set(names)] : [settings.targetTabName];
}
function readBody(request: IncomingMessage): Promise<string> { return new Promise((resolve, reject) => { let size = 0; const chunks: Buffer[] = []; request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_BODY_BYTES) { reject(new Error("too-large")); request.destroy(); } else chunks.push(chunk); }); request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); request.on("error", reject); }); }
function json(response: ServerResponse, status: number, payload: unknown): void { response.statusCode = status; response.setHeader("Content-Type", "application/json; charset=utf-8"); response.end(JSON.stringify(payload)); }
function securityHeaders(response: ServerResponse): void { response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("X-Frame-Options", "DENY"); response.setHeader("Referrer-Policy", "same-origin"); response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"); }
function formHtml(token: string, targets: string[]): string { const options = targets.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join(""); return `<!doctype html><html lang="ja"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Text Editor Remote Inbox</title><style>*{box-sizing:border-box}body{margin:0;background:#111;color:#eee;font:17px -apple-system,BlinkMacSystemFont,sans-serif;overflow-x:hidden}main{width:100%;max-width:680px;margin:auto;padding:16px}select,textarea,button{display:block;width:100%;font:inherit;border-radius:10px}select,button{min-height:48px}select,textarea{padding:12px;background:#222;color:#fff;border:1px solid #555}textarea{margin-top:14px;min-height:48vh;resize:vertical}button{margin-top:14px;padding:12px;background:#3978d4;color:#fff;border:0;font-weight:700}</style><main><select id="target" aria-label="送信先">${options}</select><textarea id="text" aria-label="メモ入力欄" placeholder="メモを入力"></textarea><button id="send">送信</button></main><script>const g=document.querySelector('#target'),t=document.querySelector('#text'),b=document.querySelector('#send'),k='texteditor-remote-draft';t.value=localStorage.getItem(k)||'';t.oninput=()=>localStorage.setItem(k,t.value);b.onclick=async()=>{if(!t.value.trim())return;b.disabled=true;try{let r=await fetch('/api/append',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'${token}'},body:JSON.stringify({target:g.value,text:t.value})});if(!r.ok)throw 0;t.value='';localStorage.removeItem(k)}finally{b.disabled=false}};</script></html>`; }
function escapeHtml(value: string): string { return value.replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
