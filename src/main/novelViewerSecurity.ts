import { isIP } from "node:net";

export const NOVEL_VIEWER_MAX_URL_LENGTH = 4096;
export const NOVEL_VIEWER_ALLOWED_HOSTS = new Set(["kakuyomu.jp", "ncode.syosetu.com"]);
export const NOVEL_VIEWER_TEST_SCHEME = "novel-reader-test:";

export interface NovelViewerUrlValidationOptions {
  allowTestProtocol?: boolean;
}
export type NovelViewerUrlValidation =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

function normalizeHost(host: string): string {
  const unwrapped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return unwrapped.toLowerCase().replace(/\.$/, "").split("%")[0];
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".").map((part) => Number(part));
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function isNonPublicIpv4(address: string): boolean {
  const parts = parseIpv4(address);
  if (!parts) return true;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6ToBigInt(address: string): bigint | null {
  let source = normalizeHost(address);
  const ipv4Match = source.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match) {
    const ipv4 = parseIpv4(ipv4Match[2]);
    if (!ipv4) return null;
    source = `${ipv4Match[1]}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function hasIpv6Prefix(value: bigint, prefix: bigint, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return value >> shift === prefix >> shift;
}

function isNonPublicIpv6(address: string): boolean {
  const value = ipv6ToBigInt(address);
  if (value === null) return true;
  const ipv4MappedPrefix = 0xffffn;
  if (value >> 32n === ipv4MappedPrefix) {
    const ipv4 = Number(value & 0xffffffffn);
    return isNonPublicIpv4(`${ipv4 >>> 24}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`);
  }
  return (
    value === 0n ||
    value === 1n ||
    hasIpv6Prefix(value, 0xfc00n << 112n, 7) ||
    hasIpv6Prefix(value, 0xfe80n << 112n, 10) ||
    hasIpv6Prefix(value, 0xff00n << 112n, 8) ||
    hasIpv6Prefix(value, 0x20010db8n << 96n, 32)
  );
}

export function isPrivateNetworkHost(host: string): boolean {
  const normalized = normalizeHost(host);
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  const family = isIP(normalized);
  if (family === 4) return isNonPublicIpv4(normalized);
  if (family === 6) return isNonPublicIpv6(normalized);
  return false;
}

export function isPrivateNetworkAddress(address: string): boolean {
  const normalized = normalizeHost(address);
  const family = isIP(normalized);
  return family === 4 ? isNonPublicIpv4(normalized) : family === 6 ? isNonPublicIpv6(normalized) : true;
}

export function validateNovelViewerUrl(
  input: string,
  options: NovelViewerUrlValidationOptions = {}
): NovelViewerUrlValidation {
  if (typeof input !== "string") return { ok: false, reason: "The URL must be text." };
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > NOVEL_VIEWER_MAX_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, reason: "The URL is empty or too long." };
  }
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: "The URL is invalid." };
  }
  if (options.allowTestProtocol && parsed.protocol === NOVEL_VIEWER_TEST_SCHEME) {
    return parsed.hostname === "fixture" && !parsed.username && !parsed.password
      ? { ok: true, url: parsed }
      : { ok: false, reason: "The test URL is invalid." };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "Only HTTPS URLs are supported." };
  if (parsed.username || parsed.password || parsed.port) {
    return { ok: false, reason: "Credentials and custom ports are not supported." };
  }
  const host = normalizeHost(parsed.hostname);
  if (isPrivateNetworkHost(host) || !NOVEL_VIEWER_ALLOWED_HOSTS.has(host)) {
    return { ok: false, reason: "This website is not supported by Novel Viewer." };
  }
  return { ok: true, url: parsed };
}

export function isSafeReaderNetworkRequest(rawUrl: string, allowTestProtocol = false): boolean {
  if (typeof rawUrl !== "string" || rawUrl.length > NOVEL_VIEWER_MAX_URL_LENGTH * 2) return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (allowTestProtocol && parsed.protocol === NOVEL_VIEWER_TEST_SCHEME) {
    return parsed.hostname === "fixture";
  }
  return parsed.protocol === "https:" && !parsed.username && !parsed.password && !isPrivateNetworkHost(parsed.hostname);
}
