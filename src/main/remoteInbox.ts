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
type ReadResult = { content: string } | { error: string };
export type RemoteInboxDocument = { id?: string; target: string; content: string; revision: number; updatedAt: string };
export type RemoteInboxMutationResult = { ok: true; tabId: string; content: string; revision: number; updatedAt: string; beforeCharacters: number } | { ok: false; error: string; conflict?: boolean; tabId?: string; revision?: number; updatedAt?: string };
export type RemoteTabListItem = { id: string; title: string; pinned: boolean; updatedAt: string };
export type RemoteTabContent = RemoteTabListItem & { content: string };

export interface RemoteInboxServerOptions {
  dataRoot: () => string;
  append: (text: string, includeTimestamp: boolean, targetTabName: string) => Promise<AppendResult>;
  read: (targetTabName: string) => Promise<ReadResult>;
  getRemoteInbox: (targetTabName: string) => Promise<RemoteInboxDocument>;
  mutateRemoteInbox: (operation: "replace" | "clear", targetTabName: string, content: string, revision: number) => Promise<RemoteInboxMutationResult>;
  listTabs: () => Promise<RemoteTabListItem[]>;
  readTab: (id: string) => Promise<RemoteTabContent | null>;
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

  async auditPcClear(tabId: string, targetTabName: string, revision: number, beforeCharacters: number): Promise<void> {
    await this.audit("success", "local", 0, undefined, { operation: "REMOTE_INBOX_CLEAR", tabId, targetTabName, clientIp: "local", revision, beforeCharacters, afterCharacters: 0 });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    securityHeaders(response);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, { ok: true, version: "1.8.0" });
    if (request.method === "GET" && url.pathname === "/") return this.form(request, response);
    if (request.method === "GET" && url.pathname === "/api/read") return this.read(url, request, response);
    if (request.method === "GET" && url.pathname === "/api/remote-inbox") return this.getRemoteInbox(url, request, response);
    if (request.method === "PUT" && url.pathname === "/api/remote-inbox") return this.mutateRemoteInbox("replace", url, request, response);
    if (request.method === "DELETE" && url.pathname === "/api/remote-inbox") return this.mutateRemoteInbox("clear", url, request, response);
    if (request.method === "GET" && url.pathname === "/api/tabs") return this.listTabs(request, response);
    if (request.method === "GET" && url.pathname.startsWith("/api/tabs/")) return this.readTab(url, request, response);
    if (request.method === "POST" && url.pathname === "/api/append") return this.append(request, response);
    json(response, 404, { ok: false, error: "Not found" });
  }

  private form(_request: IncomingMessage, response: ServerResponse): void {
    const token = randomBytes(24).toString("base64url");
    this.csrfTokens.set(token, Date.now() + 30 * 60_000);
    response.setHeader("Set-Cookie", `remoteInboxCsrf=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=1800`);
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(formHtmlV18(token, targetNames(this.options.getSettings())));
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

  private async read(url: URL, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const settings = this.options.getSettings();
    const target = url.searchParams.get("target") ?? "";
    const order = url.searchParams.get("order") === "old" ? "old" : "new";
    const cursor = parseBoundedInt(url.searchParams.get("cursor"), 0, 0, 100_000);
    const limit = parseBoundedInt(url.searchParams.get("limit"), 100, 1, 100);
    const assertion = request.headers["cf-access-jwt-assertion"];
    if (typeof assertion !== "string") { await this.audit("failure", undefined, 0, "read-auth"); return json(response, 401, { ok: false, error: "Authentication required" }); }
    let email: string;
    try { email = await this.verify(assertion, settings); } catch { await this.audit("failure", undefined, 0, "read-jwt"); return json(response, 403, { ok: false, error: "Authentication rejected" }); }
    if (!isValidTargetName(target) || !targetNames(settings).includes(target)) { await this.audit("failure", email, 0, "read-target"); return json(response, 400, { ok: false, error: "Invalid target" }); }
    if (!this.allow(email)) { await this.audit("failure", email, 0, "read-rate-limit"); return json(response, 429, { ok: false, error: "Too many requests" }); }
    const result = await this.options.read(target);
    if ("error" in result) { await this.audit("failure", email, 0, "read-load"); return json(response, 500, { ok: false, error: "Could not read note" }); }
    const page = readPage(result.content, order, cursor, limit);
    await this.audit("success", email, Buffer.byteLength(page.content), "read");
    json(response, 200, { ok: true, target, order, ...page });
  }

  private async getRemoteInbox(url: URL, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const settings = this.options.getSettings();
    const target = url.searchParams.get("target") ?? settings.targetTabName;
    const email = await this.authenticate(request, response, settings, "REMOTE_INBOX_READ", target);
    if (!email) return;
    if (!isValidTargetName(target) || !targetNames(settings).includes(target)) { await this.audit("failure", email, 0, "invalid-target", auditMeta(request, "REMOTE_INBOX_READ", undefined, target)); return json(response, 400, { ok: false, error: "Invalid target" }); }
    if (!this.allow(email)) return json(response, 429, { ok: false, error: "Too many requests" });
    const document = await this.options.getRemoteInbox(target);
    await this.audit("success", email, 0, undefined, auditMeta(request, "REMOTE_INBOX_READ", document.id, target, document.revision, document.content.length, document.content.length));
    json(response, 200, { ok: true, ...document });
  }

  private async mutateRemoteInbox(operation: "replace" | "clear", url: URL, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const settings = this.options.getSettings();
    const target = url.searchParams.get("target") ?? settings.targetTabName;
    const operationName = operation === "replace" ? "REMOTE_INBOX_REPLACE" : "REMOTE_INBOX_CLEAR";
    const origin = request.headers.origin;
    if (origin && origin !== `https://${request.headers.host}`) return json(response, 403, { ok: false, error: "Invalid origin" });
    if (!this.validCsrf(request)) { await this.audit("failure", undefined, 0, "csrf", auditMeta(request, operationName, undefined, target)); return json(response, 403, { ok: false, error: "Invalid request token" }); }
    const email = await this.authenticate(request, response, settings, operationName, target);
    if (!email) return;
    if (!isValidTargetName(target) || !targetNames(settings).includes(target)) return json(response, 400, { ok: false, error: "Invalid target" });
    if (request.headers["content-type"]?.split(";")[0].toLowerCase() !== "application/json") return json(response, 400, { ok: false, error: "Content-Type must be application/json" });
    let payload: unknown;
    try { payload = JSON.parse(await readBody(request)); } catch (error) { return json(response, error instanceof Error && error.message === "too-large" ? 413 : 400, { ok: false, error: "Invalid request" }); }
    const revision = typeof (payload as { revision?: unknown })?.revision === "number" ? (payload as { revision: number }).revision : -1;
    const content = operation === "replace" && typeof (payload as { content?: unknown })?.content === "string" ? (payload as { content: string }).content : "";
    if (!Number.isInteger(revision) || revision < 0 || (operation === "replace" && Buffer.byteLength(content) > MAX_BODY_BYTES)) return json(response, 400, { ok: false, error: "Invalid content or revision" });
    if (!this.allow(email)) return json(response, 429, { ok: false, error: "Too many requests" });
    const result = await this.options.mutateRemoteInbox(operation, target, content, revision);
    if (!result.ok) { await this.audit("failure", email, 0, result.conflict ? "conflict" : "save", auditMeta(request, operationName, result.tabId, target, result.revision)); return json(response, result.conflict ? 409 : 500, result); }
    await this.audit("success", email, Buffer.byteLength(content), undefined, auditMeta(request, operationName, result.tabId, target, result.revision, result.beforeCharacters, result.content.length));
    json(response, 200, result);
  }

  private async listTabs(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const settings = this.options.getSettings();
    const email = await this.authenticate(request, response, settings, "TAB_LIST_READ");
    if (!email) return;
    if (!this.allow(email)) return json(response, 429, { ok: false, error: "Too many requests" });
    const tabs = await this.options.listTabs();
    await this.audit("success", email, 0, undefined, auditMeta(request, "TAB_LIST_READ"));
    json(response, 200, { ok: true, tabs });
  }

  private async readTab(url: URL, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const settings = this.options.getSettings();
    const email = await this.authenticate(request, response, settings, "TAB_CONTENT_READ");
    if (!email) return;
    let id = "";
    try { id = decodeURIComponent(url.pathname.slice("/api/tabs/".length)); } catch { return json(response, 400, { ok: false, error: "Invalid tab id" }); }
    if (!/^tab-[A-Za-z0-9_-]+$/.test(id)) return json(response, 400, { ok: false, error: "Invalid tab id" });
    if (!this.allow(email)) return json(response, 429, { ok: false, error: "Too many requests" });
    const tab = await this.options.readTab(id);
    if (!tab) { await this.audit("failure", email, 0, "not-found", auditMeta(request, "TAB_CONTENT_READ", id)); return json(response, 404, { ok: false, error: "Tab not found" }); }
    await this.audit("success", email, 0, undefined, auditMeta(request, "TAB_CONTENT_READ", id, tab.title));
    json(response, 200, { ok: true, ...tab });
  }

  private validCsrf(request: IncomingMessage): boolean {
    const csrf = request.headers["x-csrf-token"];
    const cookie = request.headers.cookie?.match(/(?:^|;\s*)remoteInboxCsrf=([^;]+)/)?.[1];
    return typeof csrf === "string" && Boolean(cookie) && csrf === cookie && (this.csrfTokens.get(csrf) ?? 0) >= Date.now();
  }

  private async authenticate(request: IncomingMessage, response: ServerResponse, settings: RemoteInboxSettings, operation: string, target?: string): Promise<string | null> {
    const assertion = request.headers["cf-access-jwt-assertion"];
    if (typeof assertion !== "string") { await this.audit("failure", undefined, 0, "auth", auditMeta(request, operation, undefined, target)); json(response, 401, { ok: false, error: "Authentication required" }); return null; }
    try { return await this.verify(assertion, settings); } catch { await this.audit("failure", undefined, 0, "jwt", auditMeta(request, operation, undefined, target)); json(response, 403, { ok: false, error: "Authentication rejected" }); return null; }
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

  private async audit(result: "success" | "failure", email: string | undefined, size: number, error?: string, metadata: Record<string, unknown> = {}): Promise<void> {
    const file = path.join(this.options.dataRoot(), "remote-inbox.log");
    await mkdir(path.dirname(file), { recursive: true });
    let entries: string[] = [];
    try { entries = (await readFile(file, "utf8")).split("\n").filter(Boolean).slice(-499); } catch { /* first audit entry */ }
    entries.push(JSON.stringify({ receivedAt: new Date().toISOString(), result, email, size, error, ...metadata }));
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
function clientIp(request: IncomingMessage): string { const forwarded = request.headers["cf-connecting-ip"]; return typeof forwarded === "string" && forwarded ? forwarded : request.socket.remoteAddress ?? "unknown"; }
function auditMeta(request: IncomingMessage, operation: string, tabId?: string, targetTabName?: string, revision?: number, beforeCharacters?: number, afterCharacters?: number): Record<string, unknown> { return { operation, tabId, targetTabName, clientIp: clientIp(request), revision, beforeCharacters, afterCharacters }; }
function parseBoundedInt(value: string | null, fallback: number, min: number, max: number): number { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback; }
function readPage(content: string, order: "new" | "old", cursor: number, limit: number): { content: string; nextCursor: number | null } {
  const entries = content ? content.split(/\n\n(?=\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\n)/) : [];
  const ordered = order === "new" ? [...entries].reverse() : entries;
  const page: string[] = [];
  let bytes = 0;
  for (const entry of ordered.slice(cursor, cursor + limit)) { const size = Buffer.byteLength(entry); if (page.length && bytes + size + 2 > 50 * 1024) break; let value = size > 50 * 1024 ? Buffer.from(entry).subarray(-50 * 1024).toString("utf8") : entry; while (Buffer.byteLength(value) > 50 * 1024) value = value.slice(1); page.push(value); bytes += Buffer.byteLength(value) + 2; }
  const consumed = page.length;
  return { content: page.join("\n\n"), nextCursor: cursor + consumed < ordered.length ? cursor + consumed : null };
}
function readBody(request: IncomingMessage): Promise<string> { return new Promise((resolve, reject) => { let size = 0; let tooLarge = false; const chunks: Buffer[] = []; request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_BODY_BYTES) tooLarge = true; else if (!tooLarge) chunks.push(chunk); }); request.on("end", () => tooLarge ? reject(new Error("too-large")) : resolve(Buffer.concat(chunks).toString("utf8"))); request.on("error", reject); }); }
function json(response: ServerResponse, status: number, payload: unknown): void { response.statusCode = status; response.setHeader("Content-Type", "application/json; charset=utf-8"); response.end(JSON.stringify(payload)); }
function securityHeaders(response: ServerResponse): void { response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("X-Frame-Options", "DENY"); response.setHeader("Referrer-Policy", "same-origin"); response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"); }
function formHtml(token: string, targets: string[]): string { const options = targets.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join(""); return `<!doctype html><html lang="ja"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Text Editor Remote Inbox</title><style>*{box-sizing:border-box}body{margin:0;background:#111;color:#eee;font:17px -apple-system,BlinkMacSystemFont,sans-serif;overflow-x:hidden}main{width:100%;max-width:680px;margin:auto;padding:16px}.modes{display:flex;gap:8px;margin-bottom:14px}.modes button{margin:0;flex:1}section[hidden]{display:none}select,input,textarea,button{display:block;width:100%;font:inherit;border-radius:10px}select,input,button{min-height:48px}select,input,textarea{padding:12px;background:#222;color:#fff;border:1px solid #555}textarea{margin-top:14px;min-height:48vh;resize:vertical}button{margin-top:14px;padding:12px;background:#3978d4;color:#fff;border:0;font-weight:700}.active{outline:2px solid #9fc4ff}.read-tools{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}.read-tools button{margin:0}.read-content{margin:14px 0 0;padding:14px;min-height:48vh;background:#222;border:1px solid #555;border-radius:10px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;overflow-x:hidden}</style><main><div class="modes"><button id="write-mode" class="active" type="button">送信</button><button id="read-mode" type="button">閲覧</button></div><section id="write"><select id="target" aria-label="送信先">${options}</select><textarea id="text" aria-label="メモ入力欄" placeholder="メモを入力"></textarea><button id="send">送信</button></section><section id="read" hidden><select id="read-target" aria-label="閲覧対象">${options}</select><div class="read-tools"><input id="search" type="search" aria-label="検索" placeholder="検索"><button id="order" type="button">新しい順</button><button id="reload" type="button">再読み込み</button><button id="more" type="button" hidden>追加読み込み</button></div><pre id="content" class="read-content" aria-live="polite"></pre></section></main><script>const $=s=>document.querySelector(s),g=$('#target'),t=$('#text'),b=$('#send'),k='texteditor-remote-draft',w=$('#write'),r=$('#read'),c=$('#content'),rt=$('#read-target'),q=$('#search'),o=$('#order'),m=$('#more');let order='new',cursor=0,next=null,all='';t.value=localStorage.getItem(k)||'';t.oninput=()=>localStorage.setItem(k,t.value);$('#write-mode').onclick=()=>mode('write');$('#read-mode').onclick=()=>{mode('read');load(true)};function mode(v){w.hidden=v!=='write';r.hidden=v!=='read';$('#write-mode').classList.toggle('active',v==='write');$('#read-mode').classList.toggle('active',v==='read')}const send=async()=>{if(!t.value.trim())return;b.disabled=true;try{let x=await fetch('/api/append',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'${token}'},body:JSON.stringify({target:g.value,text:t.value})});if(!x.ok)throw 0;t.value='';localStorage.removeItem(k)}finally{b.disabled=false}};b.onclick=send;t.onkeydown=e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();void send()}};async function load(reset){if(reset){cursor=0;next=null;all=''}let x=await fetch('/api/read?target='+encodeURIComponent(rt.value)+'&order='+order+'&cursor='+cursor);if(!x.ok){c.textContent='読み込めませんでした。';return}let d=await x.json();all+=all&&d.content?'\\n\\n'+d.content:d.content;cursor=d.nextCursor??cursor;next=d.nextCursor;c.textContent=filter(all);m.hidden=next===null}function filter(v){let z=q.value.trim();return z?v.split('\\n').filter(x=>x.includes(z)).join('\\n'):v}q.oninput=()=>c.textContent=filter(all);rt.onchange=()=>load(true);$('#reload').onclick=()=>load(true);o.onclick=()=>{order=order==='new'?'old':'new';o.textContent=order==='new'?'新しい順':'古い順';load(true)};m.onclick=()=>{if(next!==null)load(false)}</script></html>`; }
function escapeHtml(value: string): string { return value.replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }

function formHtmlV18(token: string, targets: string[]): string {
  void formHtml;
  const options = targets.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
  return `<!doctype html><html lang="ja"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Text Editor Remote Inbox</title>
<style>*{box-sizing:border-box}body{margin:0;background:#111;color:#eee;font:16px -apple-system,BlinkMacSystemFont,sans-serif;overflow-x:hidden}main{width:100%;max-width:760px;margin:auto;padding:14px}.modes,.actions{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}.modes button{flex:1}.actions button{flex:1 1 140px}section[hidden]{display:none}select,input,textarea,button{display:block;width:100%;font:inherit;border-radius:10px}select,input,button{min-height:48px}select,input,textarea{padding:12px;background:#222;color:#fff;border:1px solid #555}textarea{min-height:48vh;resize:vertical}.append{min-height:120px;margin-top:16px}.readonly{margin:14px 0;padding:14px;min-height:52vh;background:#222;border:1px solid #555;border-radius:10px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;overflow-x:hidden}.meta,.status{min-height:1.5em;margin:8px 2px;color:#bbb}.status.error{color:#ff9b9b}.active{outline:2px solid #9fc4ff}</style>
<main><div class="modes"><button id="inbox-mode" class="active" type="button">Remote Inbox</button><button id="tabs-mode" type="button">タブ閲覧</button></div>
<section id="inbox"><select id="target" aria-label="Remote Inbox">${options}</select><div id="meta" class="meta"></div><div id="status" class="status">再読み込みしてください。</div><textarea id="editor" aria-label="Remote Inbox本文"></textarea><div class="actions"><button id="save" type="button">保存</button><button id="reload" type="button">再読み込み</button><button id="copy" type="button">全文コピー</button><button id="clear" type="button">クリア</button></div><textarea id="append-text" class="append" aria-label="追記メモ" placeholder="追記するメモ"></textarea><button id="append" type="button">追記</button></section>
<section id="tabs" hidden><select id="tab-select" aria-label="タブ選択"></select><div id="tab-meta" class="meta"></div><input id="tab-search" type="search" aria-label="本文内検索" placeholder="本文内検索"><div class="actions"><button id="tab-reload" type="button">再読み込み</button><button id="tab-copy" type="button">全文コピー</button></div><pre id="tab-content" class="readonly"></pre></section></main>
<script>const $=s=>document.querySelector(s),inbox=$('#inbox'),tabs=$('#tabs'),target=$('#target'),editor=$('#editor'),meta=$('#meta'),status=$('#status'),appendText=$('#append-text'),tabSelect=$('#tab-select'),tabContent=$('#tab-content'),tabMeta=$('#tab-meta'),tabSearch=$('#tab-search'),csrf='${token}';let revision=0,updatedAt='',tabRaw='';function mode(v){inbox.hidden=v!=='inbox';tabs.hidden=v!=='tabs';$('#inbox-mode').classList.toggle('active',v==='inbox');$('#tabs-mode').classList.toggle('active',v==='tabs')}$('#inbox-mode').onclick=()=>mode('inbox');$('#tabs-mode').onclick=()=>{mode('tabs');loadTabs()};function setStatus(v,error=false){status.textContent=v;status.classList.toggle('error',error)}function showMeta(){meta.textContent='更新日時：'+(updatedAt?new Date(updatedAt).toLocaleString():'未保存')+' / revision '+revision}async function loadInbox(){let r=await fetch('/api/remote-inbox?target='+encodeURIComponent(target.value));if(!r.ok){setStatus('読み込みに失敗しました。',true);return}let d=await r.json();editor.value=d.content;revision=d.revision;updatedAt=d.updatedAt;showMeta();setStatus('保存済み')}async function mutate(method){setStatus('保存中');let body={revision};if(method==='PUT')body.content=editor.value;let r=await fetch('/api/remote-inbox?target='+encodeURIComponent(target.value),{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});let d=await r.json();if(r.status===409){setStatus('別の画面または操作によって内容が更新されています。再読み込みしてから編集内容を確認してください。',true);return}if(!r.ok){setStatus('保存に失敗しました。入力内容は保持されています。',true);return}editor.value=d.content;revision=d.revision;updatedAt=d.updatedAt;showMeta();setStatus('保存済み')}async function append(){if(!appendText.value.trim())return;let r=await fetch('/api/append',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({target:target.value,text:appendText.value})});if(!r.ok){setStatus('追記に失敗しました。入力内容は保持されています。',true);return}appendText.value='';await loadInbox()}async function copy(v){await navigator.clipboard.writeText(v)}$('#save').onclick=()=>mutate('PUT');$('#reload').onclick=loadInbox;$('#copy').onclick=()=>copy(editor.value);$('#clear').onclick=()=>{if(confirm('Remote Inboxの内容をすべて削除します。\nこの操作は元に戻せません。'))mutate('DELETE')};$('#append').onclick=append;appendText.onkeydown=e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();append()}};target.onchange=loadInbox;async function loadTabs(){let r=await fetch('/api/tabs');if(!r.ok){tabMeta.textContent='一覧を取得できませんでした。';return}let d=await r.json();tabSelect.innerHTML=d.tabs.map(t=>'<option value="'+t.id+'">'+t.title.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))+'</option>').join('');if(d.tabs.length)loadTab();else{tabRaw='';tabContent.textContent='';tabMeta.textContent='閲覧を許可されたタブがありません。'}}async function loadTab(){if(!tabSelect.value)return;let r=await fetch('/api/tabs/'+encodeURIComponent(tabSelect.value));if(!r.ok){tabMeta.textContent='タブを取得できませんでした。';return}let d=await r.json();tabRaw=d.content;tabContent.textContent=filterTab();tabMeta.textContent=d.title+' / '+new Date(d.updatedAt).toLocaleString()}function filterTab(){let q=tabSearch.value.trim();return q?tabRaw.split('\n').filter(line=>line.includes(q)).join('\n'):tabRaw}tabSelect.onchange=loadTab;tabSearch.oninput=()=>tabContent.textContent=filterTab();$('#tab-reload').onclick=loadTab;$('#tab-copy').onclick=()=>copy(tabRaw);loadInbox()</script></html>`;
}
