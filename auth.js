/** Passwords (scrypt), session cookies, CSRF double-submit. */
import crypto from "node:crypto";

export function scryptCost(env) {
  const n = Number(env.SCRYPT_N || 16384);
  return Number.isInteger(n) && n >= 1024 ? n : 16384;
}

export function hashPassword(password, n = 16384) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, { N: n, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err);
      else resolve(`scrypt$${n}$8$1$${salt.toString("hex")}$${key.toString("hex")}`);
    });
  });
}

export function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    const parts = String(stored || "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return resolve(false);
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (![n, r, p].every((x) => Number.isInteger(x) && x > 0)) return resolve(false);
    let salt;
    let expected;
    try {
      salt = Buffer.from(parts[4], "hex");
      expected = Buffer.from(parts[5], "hex");
    } catch { return resolve(false); }
    crypto.scrypt(password, salt, expected.length, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => {
      if (err || !key || key.length !== expected.length) return resolve(false);
      resolve(crypto.timingSafeEqual(key, expected));
    });
  });
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function tokensEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { out[k] = ""; }
  }
  return out;
}

export function cookieHeader(name, value, { maxAge = 1209600, httpOnly = false, secure = false } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (httpOnly) bits.push("HttpOnly");
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

export function validUsername(s) {
  return typeof s === "string" && /^[A-Za-z0-9._-]{3,32}$/.test(s);
}

export function validPassword(s) {
  return typeof s === "string" && s.length >= 8 && s.length <= 200;
}
