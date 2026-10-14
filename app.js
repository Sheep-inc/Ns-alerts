/**
 * NS treinalerts — één proces, Node.js 20+ zonder extra pakketten.
 * UI op :8780, achtergrond-poller en ntfy-push.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as detect from "./detect.js";

const BASE = path.dirname(fileURLToPath(import.meta.url));
const NS = "https://gateway.apiportal.ns.nl";
export const DAYS = ["ma", "di", "wo", "do", "vr", "za", "zo"];

export class NoKey extends Error {
  constructor(message = "NS_API_KEY missing") {
    super(message);
    this.name = "NoKey";
  }
}

export function decodeNsBody(buf) {
  const b = Buffer.from(buf);
  const data = b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b;
  return JSON.parse(data.toString("utf8"));
}

function stripChars(s, chars) {
  const set = new Set(chars);
  let a = 0;
  let b = s.length;
  while (a < b && set.has(s[a])) a++;
  while (a < b && set.has(s[b - 1])) b--;
  return s.slice(a, b);
}

export function loadEnv(base, env) {
  const p = path.join(base, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const i = s.indexOf("=");
    const k = s.slice(0, i).trim();
    const v = stripChars(s.slice(i + 1).trim(), `"'`);
    if (!Object.prototype.hasOwnProperty.call(env, k)) env[k] = v;
  }
}

function pad(n) { return String(n).padStart(2, "0"); }

export function isoNaive(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function isoOffsetSeconds(date) {
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${isoNaive(date)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function activeWindow(sub, now, windowMin) {
  const days = sub.days || DAYS;
  if (!days.includes(DAYS[(now.getDay() + 6) % 7])) return null;
  const [h, m] = String(sub.time).split(":").map((x) => Number(x));
  const dep = new Date(now);
  dep.setHours(h, m, 0, 0);
  const start = dep.getTime() - windowMin * 60000;
  const end = dep.getTime() + 5 * 60000;
  if (start <= now.getTime() && now.getTime() <= end) return dep;
  return null;
}

function log(level, message) {
  const d = new Date();
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  console.log(`${ts} ${level} ${message}`);
}

function errStr(e) { return e instanceof Error ? e.message : String(e); }

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function pyInt(v) {
  if (typeof v === "boolean" || v == null) throw new Error(`invalid int ${v}`);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`invalid int ${v}`);
    return Math.trunc(v);
  }
  const s = String(v).trim();
  if (!/^[+-]?\d+$/.test(s)) throw new Error(`invalid int ${v}`);
  return Number.parseInt(s, 10);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function encodeParams(params) {
  return Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v)).replace(/%20/g, "+")}`).join("&");
}

function makeTopic() {
  const raw = crypto.randomBytes(18).toString("base64url").replace(/[_-]/g, "").toLowerCase().slice(0, 22);
  return `ns-alerts-${raw}`;
}

export function createApp(opts = {}) {
  const env = opts.env ?? process.env;
  const base = opts.base ?? BASE;
  const dataDir = opts.dataDir || env.DATA_DIR || path.join(base, "data");
  const subsFile = path.join(dataDir, "subscriptions.json");
  const cfgFile = path.join(dataDir, "config.json");
  const stateFile = path.join(dataDir, "state.json");
  const status = { last_poll: null, error: null };
  const cache = new Map();
  let stationsCache = null;
  let lastCall = 0;
  let nsChain = Promise.resolve();
  let pollChain = Promise.resolve();
  const sleepers = new Set();
  let stopped = false;
  let pollerPromise = null;
  let closed = false;
  let port = Number(opts.port ?? env.PORT ?? 8780);
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) send(res, 500, { error: errStr(e) });
      else res.end();
    });
  });

  function apiKey() { return String(env.NS_API_KEY || "").trim(); }

  function sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { sleepers.delete(cancel); resolve(); }, ms);
      const cancel = () => { clearTimeout(t); sleepers.delete(cancel); resolve(); };
      sleepers.add(cancel);
    });
  }
  function wake() { for (const c of [...sleepers]) c(); }

  function config() {
    const c = readJson(cfgFile, {});
    let changed = false;
    const defaults = [
      ["ntfy_server", "https://ntfy.sh"],
      ["ntfy_topic", null],
      ["delay_threshold", 3],
      ["delay_grow", 5],
      ["window_min", 60],
      ["poll_sec", 120],
    ];
    for (const [k, v] of defaults) {
      if (!Object.prototype.hasOwnProperty.call(c, k)) {
        c[k] = k === "ntfy_topic" ? makeTopic() : v;
        changed = true;
      }
    }
    if (changed) writeJson(cfgFile, c);
    if (env.NTFY_TOPIC) c.ntfy_topic = String(env.NTFY_TOPIC).trim();
    if (env.NTFY_SERVER) c.ntfy_server = String(env.NTFY_SERVER).trim();
    return c;
  }

  function seedSubscriptions() {
    if (fs.existsSync(subsFile)) return false;
    const seed = env.SEED_FILE || path.join(base, "seed", "subscriptions.json");
    if (!fs.existsSync(seed)) return false;
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${subsFile}.tmp`;
    fs.copyFileSync(seed, tmp);
    fs.renameSync(tmp, subsFile);
    log("INFO", `abonnementen geseed vanuit ${seed}`);
    return true;
  }

  function nsGet(nsPath, params, ttl = 90) {
    const key = apiKey();
    if (!key) throw new NoKey("NS_API_KEY missing");
    const url = NS + nsPath + (params ? `?${encodeParams(params)}` : "");
    const hit = cache.get(url);
    if (hit && Date.now() / 1000 - hit[0] < ttl) return Promise.resolve(hit[1]);
    const run = nsChain.then(() => nsFetch(url, key, ttl));
    nsChain = run.then(() => {}, () => {});
    return run;
  }

  async function nsFetch(url, key, ttl) {
    const hit = cache.get(url);
    if (hit && Date.now() / 1000 - hit[0] < ttl) return hit[1];
    const wait = 1 - (Date.now() / 1000 - lastCall);
    if (wait > 0) await sleep(wait * 1000);
    lastCall = Date.now() / 1000;
    const r = await fetch(url, {
      headers: { "Ocp-Apim-Subscription-Key": key, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`HTTP Error ${r.status}`);
    const data = decodeNsBody(Buffer.from(await r.arrayBuffer()));
    cache.set(url, [Date.now() / 1000, data]);
    if (cache.size > 500) cache.clear();
    return data;
  }

  async function stations() {
    if (!stationsCache) {
      const d = await nsGet("/reisinformatie-api/api/v2/stations", null, 86400);
      stationsCache = (d.payload || []).map((s) => ({
        code: s.code ?? null,
        name: s.namen?.lang ?? null,
        land: s.land ?? null,
      }));
    }
    return stationsCache;
  }

  async function ntfy(title, body, prio = "default") {
    const c = config();
    const priority = { min: 1, low: 2, default: 3, high: 4, urgent: 5 }[prio] ?? 3;
    const payload = JSON.stringify({ topic: c.ntfy_topic, title, message: body, priority });
    const r = await fetch(`${c.ntfy_server.replace(/\/+$/, "")}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`HTTP Error ${r.status}`);
    return r.status;
  }

  async function checkSub(sub, dep) {
    let cur;
    if (sub.train) {
      const d = await nsGet("/reisinformatie-api/api/v2/departures", { station: sub.from, maxJourneys: 40 });
      const deps = d?.payload?.departures || [];
      const m = deps.filter((x) => String(x?.product?.number) === String(sub.train));
      if (!m.length) return null;
      cur = detect.stateFromDeparture(m[0]);
      cur.stations = [sub.from];
    } else {
      const d = await nsGet("/reisinformatie-api/api/v3/trips", {
        fromStation: sub.from,
        toStation: sub.to,
        dateTime: isoOffsetSeconds(dep),
        previousAdvices: 1,
        nextAdvices: 2,
      });
      const t = detect.pickTrip(d.trips || [], sub.time);
      if (!t) return null;
      cur = detect.stateFromTrip(t);
    }
    const stns = new Set([...(cur.stations || []), sub.from, sub.to]);
    try {
      const dis = await nsGet("/disruptions/v3", { isActive: "true" }, 300);
      const list = Array.isArray(dis) ? dis : (dis?.payload || []);
      cur.disruptions = detect.relevantDisruptions(list, stns);
    } catch (e) {
      if (e instanceof NoKey) throw e;
      log("WARNING", `disruptions failed: ${errStr(e)}`);
      cur.disruptions = [];
    }
    return cur;
  }

  async function pollOnceInner(now) {
    const cfg = config();
    const when = now || new Date();
    if (!apiKey()) {
      status.error = "NS_API_KEY missing";
      status.last_poll = isoNaive(when);
      return;
    }
    const subs = readJson(subsFile, []);
    const st = readJson(stateFile, {});
    const today = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
    for (const sub of subs) {
      let dep;
      try { dep = activeWindow(sub, when, cfg.window_min); }
      catch (e) { log("WARNING", `check ${sub.id} failed: ${errStr(e)}`); status.error = errStr(e); continue; }
      if (!dep) continue;
      const k = `${sub.id}@${today}`;
      let cur;
      try { cur = await checkSub(sub, dep); }
      catch (e) { log("WARNING", `check ${sub.id} failed: ${errStr(e)}`); status.error = errStr(e); continue; }
      if (!cur) continue;
      const prev = Object.prototype.hasOwnProperty.call(st, k) ? st[k] : null;
      const ev = detect.diff(prev, cur, cfg.delay_threshold, cfg.delay_grow);
      st[k] = cur;
      if (ev.length) {
        const [title, body, prio] = detect.formatMsg(sub, cur, ev);
        log("INFO", `NOTIFY ${title}: ${body}`);
        try { await ntfy(title, body, prio); }
        catch (e) { log("WARNING", `ntfy failed: ${errStr(e)}`); }
      }
    }
    const next = {};
    for (const [k, v] of Object.entries(st)) if (k.endsWith(today)) next[k] = v;
    writeJson(stateFile, next);
    status.error = null;
    status.last_poll = isoNaive(when);
  }

  function pollOnce(now) {
    const run = pollChain.then(() => pollOnceInner(now));
    pollChain = run.then(() => {}, () => {});
    return run;
  }

  function startPoller() {
    stopped = false;
    pollerPromise = (async () => {
      while (!stopped) {
        try { await pollOnce(); }
        catch (e) { console.error(e); status.error = errStr(e); }
        if (stopped) break;
        await sleep((Number(config().poll_sec) || 120) * 1000);
      }
    })();
  }

  function authorized(req) {
    const pw = env.UI_PASSWORD || "";
    if (!pw) return true;
    const a = req.headers.authorization || "";
    if (!a.startsWith("Basic ")) return false;
    let decoded;
    try { decoded = Buffer.from(a.slice(6), "base64").toString("utf8"); }
    catch { return false; }
    const i = decoded.indexOf(":");
    const given = i === -1 ? decoded : decoded.slice(i + 1);
    return safeEqual(given, pw);
  }

  function send(res, code, obj, ctype = "application/json") {
    const b = Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj));
    res.writeHead(code, { "Content-Type": `${ctype}; charset=utf-8`, "Content-Length": b.length });
    res.end(b);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const n = Number(req.headers["content-length"] || 0);
      if (!n) return resolve({});
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).subarray(0, n).toString("utf8");
          resolve(raw ? JSON.parse(raw) : {});
        } catch (e) { reject(e); }
      });
      req.on("error", reject);
    });
  }

  async function handle(req, res) {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname !== "/healthz" && !authorized(req)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="NS treinalerts"', "Content-Length": "0" });
      res.end();
      return;
    }
    try {
      if (req.method === "GET") return await handleGet(req, res, u);
      if (req.method === "POST") return await handlePost(req, res, u);
      if (req.method === "DELETE") return handleDelete(res, u);
      send(res, 404, { error: "not found" });
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof SyntaxError) return send(res, 400, { error: "ongeldige json" });
      send(res, 500, { error: errStr(e) });
    }
  }

  async function handleGet(req, res, u) {
    if (u.pathname === "/") {
      return send(res, 200, fs.readFileSync(path.join(base, "static", "index.html"), "utf8"), "text/html");
    }
    if (u.pathname === "/healthz") return send(res, 200, { ok: true });
    if (u.pathname === "/api/subs" || u.pathname === "/api/export") return send(res, 200, readJson(subsFile, []));
    if (u.pathname === "/api/status") {
      const c = config();
      return send(res, 200, {
        key: Boolean(apiKey()),
        topic: c.ntfy_topic,
        server: c.ntfy_server,
        threshold: c.delay_threshold,
        last_poll: status.last_poll,
        error: status.error,
      });
    }
    if (u.pathname === "/api/stations") {
      const term = (u.searchParams.get("q") ?? "").toLowerCase();
      try {
        const resStations = (await stations()).filter((s) => (s.name || "").toLowerCase().includes(term) || term === (s.code || "").toLowerCase()).slice(0, 10);
        return send(res, 200, resStations);
      } catch (e) {
        if (e instanceof NoKey) return send(res, 503, { error: "NS_API_KEY missing" });
        return send(res, 502, { error: errStr(e) });
      }
    }
    return send(res, 404, { error: "not found" });
  }

  async function handlePost(req, res, u) {
    if (u.pathname === "/api/subs") {
      const b = await readBody(req);
      if (!b.from || !(b.to || b.train) || !b.time) return send(res, 400, { error: "van, naar/treinnummer en tijd verplicht" });
      const sub = {
        from: String(b.from).toUpperCase(),
        fromName: b.fromName ?? null,
        to: String(b.to || "").toUpperCase(),
        toName: b.toName ?? null,
        time: b.time ?? null,
        label: b.label ?? null,
        train: b.train ?? null,
        days: b.days && !(Array.isArray(b.days) && b.days.length === 0) ? b.days : DAYS.slice(0, 5),
        id: crypto.randomBytes(4).toString("hex"),
      };
      const s = readJson(subsFile, []);
      s.push(sub);
      writeJson(subsFile, s);
      return send(res, 200, sub);
    }
    if (u.pathname === "/api/import") {
      const b = await readBody(req);
      if (!Array.isArray(b) || !b.every((x) => x && typeof x === "object" && !Array.isArray(x) && x.from && x.time)) {
        return send(res, 400, { error: "ongeldige lijst" });
      }
      for (const x of b) {
        if (!Object.prototype.hasOwnProperty.call(x, "id")) x.id = crypto.randomBytes(4).toString("hex");
        if (!Object.prototype.hasOwnProperty.call(x, "days")) x.days = DAYS.slice(0, 5);
      }
      writeJson(subsFile, b);
      return send(res, 200, { ok: true, count: b.length });
    }
    if (u.pathname === "/api/test") {
      try {
        await ntfy("🚆 Test melding", "NS treinalerts werkt! Je ontvangt hier meldingen bij vertraging, spoorwijziging of uitval.");
      } catch (e) { return send(res, 502, { error: errStr(e) }); }
      return send(res, 200, { ok: true });
    }
    if (u.pathname === "/api/settings") {
      const b = await readBody(req);
      const c = config();
      if (Object.prototype.hasOwnProperty.call(b, "threshold")) c.delay_threshold = Math.max(1, pyInt(b.threshold));
      writeJson(cfgFile, c);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "not found" });
  }

  function handleDelete(res, u) {
    if (u.pathname.startsWith("/api/subs/")) {
      const id = decodeURIComponent(u.pathname.slice("/api/subs/".length));
      writeJson(subsFile, readJson(subsFile, []).filter((s) => s.id !== id));
      return send(res, 200, { ok: true });
    }
    return send(res, 404, {});
  }

  async function listen() {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", resolve);
    });
    port = server.address().port;
  }

  async function start() {
    fs.mkdirSync(dataDir, { recursive: true });
    seedSubscriptions();
    const c = config();
    log("INFO", `ntfy topic: ${c.ntfy_server}/${c.ntfy_topic}`);
    if (!apiKey()) log("WARNING", "NS_API_KEY missing — UI draait, poller staat stil tot de key er is (zet in .env en herstart)");
    await listen();
    startPoller();
    return api;
  }

  async function close() {
    if (closed) return;
    closed = true;
    stopped = true;
    wake();
    if (pollerPromise) await Promise.race([pollerPromise, sleep(500)]);
    if (server.listening) {
      await new Promise((resolve) => {
        server.close(resolve);
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      });
    }
  }

  const api = {
    start,
    close,
    pollOnce,
    activeWindow,
    get port() { return port; },
    dataDir,
    subsFile,
  };
  return api;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirect) {
  loadEnv(BASE, process.env);
  const app = createApp();
  app.start().catch((e) => { console.error(e); process.exit(1); });
}
