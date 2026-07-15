import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

const PROBE_TIMEOUT_MS = 3_000;
const PROBE_OUTPUT_LIMIT = 1_024;

export type CodexExecutableSource = "explicit" | "where" | "path" | "standard";

export interface CodexExecutableCandidate {
  executablePath: string;
  source: CodexExecutableSource;
}

export interface ResolvedCodexExecutable extends CodexExecutableCandidate {
  version: string;
}

export interface CodexExecutableResolutionOptions {
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  queryWhere?: () => Promise<string[]>;
  probe?: (candidate: CodexExecutableCandidate, env: NodeJS.ProcessEnv) => Promise<ExecutableProbeResult>;
  onDiagnostic?: (event: string, details?: Record<string, unknown>) => void;
}

export interface ExecutableProbeResult {
  ok: boolean;
  version?: string;
  errorCode?: string;
  exitCode?: number;
}

export class CodexExecutableResolutionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Codex executable could not be resolved.");
    this.name = "CodexExecutableResolutionError";
    this.code = code;
  }
}

function cleanCandidatePath(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

function pathCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const entries = (env.PATH ?? env.Path ?? env.path ?? "")
    .split(path.delimiter)
    .map(cleanCandidatePath)
    .filter(Boolean);
  const names = platform === "win32" ? ["codex.exe", "codex"] : ["codex"];
  return entries.flatMap((entry) => names.map((name) => path.join(entry, name)));
}

function standardCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA
      ?? (env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Local") : undefined);
    if (!localAppData) return [];
    return [
      path.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
      path.join(localAppData, "OpenAI", "Codex", "bin", "codex.exe")
    ];
  }
  return ["/usr/local/bin/codex", "/opt/homebrew/bin/codex"];
}

async function defaultWhereCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string[]> {
  if (platform !== "win32") return [];
  const whereExecutable = path.join(env.SystemRoot ?? "C:\\Windows", "System32", "where.exe");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(whereExecutable, ["codex"], {
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      resolve([]);
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve([]);
    }, PROBE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (stdout.length < 16_384) stdout += String(chunk).slice(0, 16_384 - stdout.length);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? stdout.split(/\r?\n/).map(cleanCandidatePath).filter(Boolean) : []);
    });
  });
}

async function isFile(candidatePath: string): Promise<boolean> {
  if (!path.isAbsolute(candidatePath)) return false;
  try {
    return (await stat(candidatePath)).isFile();
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function defaultProbe(candidate: CodexExecutableCandidate, env: NodeJS.ProcessEnv): Promise<ExecutableProbeResult> {
  if (!(await isFile(candidate.executablePath))) return { ok: false, errorCode: "ENOENT" };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(candidate.executablePath, ["--version"], {
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({ ok: false, errorCode: errorCode(error) ?? "SPAWN_FAILED" });
      return;
    }
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, errorCode: "ETIMEDOUT" });
    }, PROBE_TIMEOUT_MS);
    const append = (chunk: Buffer | string): void => {
      if (output.length < PROBE_OUTPUT_LIMIT) output += String(chunk).slice(0, PROBE_OUTPUT_LIMIT - output.length);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, errorCode: errorCode(error) ?? "SPAWN_FAILED" });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const version = output.trim().slice(0, 200);
      resolve({
        ok: code === 0 && /^codex-cli\s+/i.test(version),
        version,
        exitCode: code ?? -1,
        ...(code === 0 ? {} : { errorCode: "NONZERO_EXIT" })
      });
    });
  });
}

export async function resolveCodexExecutable(options: CodexExecutableResolutionOptions = {}): Promise<ResolvedCodexExecutable> {
  const env = { ...process.env, ...options.env };
  const platform = options.platform ?? process.platform;
  const onDiagnostic = options.onDiagnostic ?? (() => undefined);
  const where = options.queryWhere ?? (() => defaultWhereCandidates(env, platform));
  const probe = options.probe ?? defaultProbe;
  const explicitPath = options.explicitPath?.trim();
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  onDiagnostic("executable-resolution-start", {
    explicitConfigured: Boolean(explicitPath),
    mainProcessPath: pathValue.slice(0, 16_384),
    pathEntryCount: pathValue.split(path.delimiter).filter(Boolean).length
  });

  const groups: Array<{ source: CodexExecutableSource; values: string[] }> = [
    { source: "explicit", values: explicitPath ? [cleanCandidatePath(explicitPath)] : [] },
    { source: "where", values: await where() },
    { source: "path", values: pathCandidates(env, platform) },
    { source: "standard", values: standardCandidates(env, platform) }
  ];
  const seen = new Set<string>();
  let probedCandidateCount = 0;
  let lastErrorCode = "ENOENT";
  for (const group of groups) {
    for (const rawPath of group.values) {
      const executablePath = cleanCandidatePath(rawPath);
      if (!path.isAbsolute(executablePath)) continue;
      const key = platform === "win32" ? executablePath.toLowerCase() : executablePath;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!options.probe && !(await isFile(executablePath))) continue;
      const candidate = { executablePath, source: group.source };
      probedCandidateCount += 1;
      const result = await probe(candidate, env);
      if (result.errorCode) lastErrorCode = result.errorCode;
      onDiagnostic("executable-candidate-probed", {
        candidatePath: executablePath,
        source: group.source,
        usable: result.ok,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        ...(typeof result.exitCode === "number" ? { exitCode: result.exitCode } : {})
      });
      if (result.ok) {
        const version = (result.version ?? "unknown").slice(0, 200);
        onDiagnostic("executable-resolved", { resolvedExecutablePath: executablePath, source: group.source, version });
        return { ...candidate, version };
      }
    }
  }
  onDiagnostic("executable-resolution-failed", { errorCode: lastErrorCode, candidateCount: probedCandidateCount });
  throw new CodexExecutableResolutionError(lastErrorCode);
}
