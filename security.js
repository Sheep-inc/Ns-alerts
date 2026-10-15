/** Shared request guards: headers, body cap, CSRF signals, ntfy SSRF checks. */
import dns from "node:dns/promises";
import net from "node:net";

export const MAX_BODY = 1_000_000;

export function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store",
  };
}

export function maskSecret(value) {
  const s = String(value || "");
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** Browser cross-site POSTs are rejected. curl without Origin/Sec-Fetch-Site still works. */
export function isCrossSite(req) {
  if (String(req.headers["sec-fetch-site"] || "") === "cross-site") return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  let host;
  try { host = new URL(origin).host; }
  catch { return true; }
  const expected = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return !expected || host !== expected;
}

export function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket?.remoteAddress || "unknown";
}

export function makeLimiter({ limit, windowMs }) {
  const hits = new Map();
  function current(key) {
    const now = Date.now();
    const row = hits.get(key);
    if (!row || row.reset < now) return null;
    return row;
  }
  function hit(key) {
    const now = Date.now();
    const row = current(key);
    if (!row) {
      hits.set(key, { n: 1, reset: now + windowMs });
      return false;
    }
    row.n += 1;
    return row.n > limit;
  }
  hit.blocked = (key) => {
    const row = current(key);
    return Boolean(row && row.n >= limit);
  };
  return hit;
}

function ipv4ToInt(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

function inCidr4(ip, base, bits) {
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a == null || b == null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

export function isPrivateAddress(address) {
  const ip = String(address || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!ip) return true;
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (net.isIP(v4) === 4) {
    return inCidr4(v4, "0.0.0.0", 8)
      || inCidr4(v4, "10.0.0.0", 8)
      || inCidr4(v4, "100.64.0.0", 10)
      || inCidr4(v4, "127.0.0.0", 8)
      || inCidr4(v4, "169.254.0.0", 16)
      || inCidr4(v4, "172.16.0.0", 12)
      || inCidr4(v4, "192.168.0.0", 16)
      || inCidr4(v4, "255.255.255.255", 32);
  }
  if (net.isIP(ip) !== 6) return true;
  if (ip === "::" || ip === "::1") return true;
  if (ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  return false;
}

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);

/** http(s) only, no userinfo, no private/loopback address unless allowPrivate. */
export async function isAllowedNotifyUrl(raw, { allowPrivate = false } = {}) {
  let url;
  try { url = new URL(raw); }
  catch { return false; }
  if (url.username || url.password) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) return allowPrivate;
  if (net.isIP(host)) return allowPrivate || !isPrivateAddress(host);
  if (allowPrivate) return true;
  let records;
  try { records = await dns.lookup(host, { all: true, verbatim: true }); }
  catch { return false; }
  if (!records.length) return false;
  return records.every((r) => !isPrivateAddress(r.address));
}
