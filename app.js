/**
 * NS treinalerts — één proces, Node.js 22+ (node:sqlite).
 * UI op :8780, accounts, achtergrond-poller en ntfy-push.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import QRCode from "qrcode";
import { cookieHeader, hashPassword, hashToken, readCookies, scryptCost, tokensEqual, validPassword, validUsername, verifyPassword } from "./auth.js";
import { openDb } from "./db.js";
import * as detect from "./detect.js";
import {
  amsterdamParts,
  buildDigest,
  digestTarget,
  digestTargetFromNow,
  dueSlots,
  markSlot,
  parseDigestTimes,
} from "./digest.js";
import { MAX_BODY, clientIp, isAllowedNotifyUrl, isCrossSite, makeLimiter, maskSecret, securityHeaders } from "./security.js";

const BASE = path.dirname(fileURLToPath(import.meta.url));
const NS = "https://gateway.apiportal.ns.nl";
export const DAYS = ["ma", "di", "wo", "do", "vr", "za", "zo"];
const SESSION_MS = 14 * 24 * 3600 * 1000;
const STATIC = {
  "/": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/app.css": ["app.css", "text/css"],
  "/client.js": ["client.js", "text/javascript"],
  "/login.js": ["login.js", "text/javascript"],
  "/register.js": ["register.js", "text/javascript"],
  "/reset.js": ["reset.js", "text/javascript"],
  "/admin.js": ["admin.js", "text/javascript"],
  "/login": ["login.html", "text/html"],
  "/registreren": ["register.html", "text/html"],
  "/wachtwoord": ["reset.html", "text/html"],
  "/beheer": ["admin.html", "text/html"],
};

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

export function isoDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function clockMs(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(String(iso || ""));
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

function departureOnDate(sub) {
  const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sub.date || "");
  if (!p) return null;
  const [h, m] = String(sub.time).split(":").map((x) => Number(x));
  return new Date(+p[1], +p[2] - 1, +p[3], h, m, 0, 0);
}

export function activeWindow(sub, now, windowMin) {
  const [h, m] = String(sub.time).split(":").map((x) => Number(x));
  let dep;
  if (sub.date) {
    if (isoDate(now) !== sub.date) return null;
    dep = departureOnDate(sub);
    if (!dep) return null;
  } else {
    const days = sub.days || DAYS;
    if (!days.includes(DAYS[(now.getDay() + 6) % 7])) return null;
    dep = new Date(now);
    dep.setHours(h, m, 0, 0);
  }
  const start = dep.getTime() - windowMin * 60000;
  const end = dep.getTime() + 5 * 60000;
  if (start <= now.getTime() && now.getTime() <= end) return dep;
  return null;
}

/** One-time subs (field `date`) end after departure + 5 min, or once arrival has passed. */
export function oneTimeFinished(sub, now, arrivalIso) {
  if (!sub?.date) return false;
  const dep = departureOnDate(sub);
  if (!dep) return false;
  if (arrivalIso) {
    const arr = clockMs(arrivalIso);
    if (arr != null && now.getTime() >= arr) return true;
  }
  return now.getTime() > dep.getTime() + 5 * 60000;
}

function log(level, message) {
  const d = new Date();
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  console.log(`${ts} ${level} ${message}`);
}

function errStr(e) { return e instanceof Error ? e.message : String(e); }

function validDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const dt = new Date(+m[1], +m[2] - 1, +m[3]);
  return dt.getFullYear() === +m[1] && dt.getMonth() === +m[2] - 1 && dt.getDate() === +m[3];
}

function envFlag(v, fallback) {
  const s = String(v).trim().toLowerCase();
  if (["0", "false", "nee", "off", "no"].includes(s)) return false;
  if (["1", "true", "ja", "on", "yes"].includes(s)) return true;
  return fallback;
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

function encodeParams(params) {
  return Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v)).replace(/%20/g, "+")}`).join("&");
}

function validSubId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(id);
}

function makeTopic() {
  const raw = crypto.randomBytes(18).toString("base64url").replace(/[_-]/g, "").toLowerCase().slice(0, 22);
  return `ns-alerts-${raw}`;
}

function on(v) {
  return ["1", "true", "ja", "on", "yes"].includes(String(v || "").trim().toLowerCase());
}

export function createApp(opts = {}) {
  const env = opts.env ?? process.env;
  const base = opts.base ?? BASE;
  const dataDir = opts.dataDir || env.DATA_DIR || path.join(base, "data");
  const subsFile = path.join(dataDir, "subscriptions.json");
  const cfgFile = path.join(dataDir, "config.json");
  const stateFile = path.join(dataDir, "state.json");
  const digestFile = path.join(dataDir, "digest.json");
  const status = { last_poll: null, error: null };
  const digestStatus = new Map();
  const cache = new Map();
  let stationsCache = null;
  let lastCall = 0;
  let nsChain = Promise.resolve();
  let pollChain = Promise.resolve();
  let nsQueued = 0;
  let store = null;
  let dummyHash = null;
  const loginFails = makeLimiter({ limit: 8, windowMs: 10 * 60 * 1000 });
  const registerFails = makeLimiter({ limit: 20, windowMs: 15 * 60 * 1000 });
  const sleepers = new Set();
  let stopped = false;
  let pollerPromise = null;
  let closed = false;
  let port = Number(opts.port ?? env.PORT ?? 8780);
  const host = String(opts.host ?? env.HOST ?? "0.0.0.0");
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) send(res, 500, { error: "interne fout" });
      else res.end();
      log("WARNING", `request failed: ${errStr(e)}`);
    });
  });

  function apiKey() { return String(env.NS_API_KEY || "").trim(); }
  function secureCookie() { return on(env.COOKIE_SECURE); }
  function allowPrivate() { return on(env.NTFY_ALLOW_PRIVATE); }
  function digestGloballyOn() {
    if (env.DIGEST_ENABLED != null && String(env.DIGEST_ENABLED).trim() !== "") return envFlag(env.DIGEST_ENABLED, true);
    return true;
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { sleepers.delete(cancel); resolve(); }, ms);
      const cancel = () => { clearTimeout(t); sleepers.delete(cancel); resolve(); };
      sleepers.add(cancel);
    });
  }
  function wake() { for (const c of [...sleepers]) c(); }

  function freshSettings() {
    const times = parseDigestTimes(env.DIGEST_TIMES) || ["06:00", "21:00"];
    const enabled = env.DIGEST_ENABLED != null && String(env.DIGEST_ENABLED).trim() !== "" ? envFlag(env.DIGEST_ENABLED, true) : true;
    const quiet = env.DIGEST_QUIET != null && String(env.DIGEST_QUIET).trim() !== "" ? envFlag(env.DIGEST_QUIET, false) : false;
    return {
      ntfy_topic: makeTopic(),
      ntfy_server: "",
      delay_threshold: 3,
      delay_grow: 5,
      window_min: 30,
      digest_enabled: enabled,
      digest_times: times,
      digest_quiet: quiet,
    };
  }

  function userServer(user) {
    const custom = String(user?.ntfy_server || "").trim().replace(/\/+$/, "");
    if (custom) return custom;
    return String(env.NTFY_SERVER || "https://ntfy.sh").trim().replace(/\/+$/, "");
  }

  async function vettedServer(raw) {
    const server = String(raw || "").trim().replace(/\/+$/, "");
    if (!server || server === "https://ntfy.sh") return "";
    if (!(await isAllowedNotifyUrl(`${server}/`, { allowPrivate: allowPrivate() }))) return null;
    return server;
  }

  async function safeServer(user) {
    const server = userServer(user);
    if (await isAllowedNotifyUrl(`${server}/`, { allowPrivate: allowPrivate() })) return server;
    return "https://ntfy.sh";
  }

  function pollSeconds() {
    const n = Number(env.POLL_SEC || store?.meta("poll_sec") || 120);
    return Number.isFinite(n) && n >= 5 ? n : 120;
  }

  async function passwordDummy() {
    if (!dummyHash) dummyHash = await hashPassword("ns-alerts-dummy-password", scryptCost(env));
    return dummyHash;
  }

  function copySeed() {
    if (store.meta("legacy_imported") === "1" || fs.existsSync(subsFile)) return;
    const seed = env.SEED_FILE || path.join(base, "seed", "subscriptions.json");
    if (!fs.existsSync(seed)) return;
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${subsFile}.tmp`;
    fs.copyFileSync(seed, tmp);
    fs.renameSync(tmp, subsFile);
    log("INFO", "abonnementen geseed");
  }

  async function ensureAdmin() {
    if (store.countUsers() === 0) {
      const name = String(env.ADMIN_USERNAME || "").trim();
      const password = String(env.ADMIN_PASSWORD || "");
      if (!validUsername(name) || !validPassword(password)) {
        log("WARNING", "geen gebruikers; zet ADMIN_USERNAME en ADMIN_PASSWORD (8+ tekens) om een beheerder aan te maken");
        return null;
      }
      const settings = freshSettings();
      const topic = String(env.NTFY_TOPIC || "").trim();
      if (topic) settings.ntfy_topic = topic;
      const server = await vettedServer(env.NTFY_SERVER);
      if (server) settings.ntfy_server = server;
      else if (server === null) log("WARNING", "ntfy-server geweigerd");
      const user = store.insertUser({
        id: crypto.randomBytes(16).toString("hex"),
        username: name,
        password_hash: await hashPassword(password, scryptCost(env)),
        role: "admin",
        ...settings,
        created_at: new Date().toISOString(),
      });
      log("INFO", "admin aangemaakt");
      return user;
    }
    const name = String(env.ADMIN_USERNAME || "").trim();
    if (name) {
      const named = store.getUserByName(name);
      if (named?.role === "admin") return named;
    }
    return store.listUsers().find((u) => u.role === "admin") || null;
  }

  function legacySub(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const from = String(raw.from || "").toUpperCase();
    const time = String(raw.time || "");
    if (!from || !time) return null;
    const sub = {
      id: validSubId(raw.id) ? raw.id : crypto.randomBytes(4).toString("hex"),
      from,
      fromName: raw.fromName ? String(raw.fromName).slice(0, 80) : null,
      to: String(raw.to || "").toUpperCase(),
      toName: raw.toName ? String(raw.toName).slice(0, 80) : null,
      time,
      label: raw.label ? String(raw.label).slice(0, 80) : null,
      train: raw.train ? String(raw.train).slice(0, 12) : null,
    };
    if (raw.date) sub.date = String(raw.date);
    else sub.days = Array.isArray(raw.days) ? raw.days : DAYS.slice(0, 5);
    return sub;
  }

  async function migrateLegacy(admin) {
    if (store.meta("legacy_imported") === "1") return;
    const hasAny = [subsFile, cfgFile, stateFile, digestFile].some((f) => fs.existsSync(f));
    if (!hasAny) {
      store.metaSet("legacy_imported", "1");
      return;
    }
    if (!admin) {
      log("WARNING", "bestaande data gevonden maar geen admin — import uitgesteld");
      return;
    }
    const cfg = readJson(cfgFile, {});
    const topic = String(env.NTFY_TOPIC || cfg.ntfy_topic || admin.ntfy_topic || "").trim() || admin.ntfy_topic;
    const server = await vettedServer(env.NTFY_SERVER || cfg.ntfy_server || "");
    if (server === null) log("WARNING", "ntfy-server geweigerd");
    const patch = { ntfy_topic: topic, ntfy_server: server || "" };
    if (Number.isFinite(cfg.delay_threshold)) patch.delay_threshold = cfg.delay_threshold;
    if (Number.isFinite(cfg.delay_grow)) patch.delay_grow = cfg.delay_grow;
    if (Number.isFinite(cfg.window_min)) patch.window_min = cfg.window_min;
    if (cfg.digest_enabled != null) patch.digest_enabled = Boolean(cfg.digest_enabled);
    if (Array.isArray(cfg.digest_times)) patch.digest_times = cfg.digest_times;
    if (cfg.digest_quiet != null) patch.digest_quiet = Boolean(cfg.digest_quiet);
    store.updateSettings(admin.id, patch);
    if (env.POLL_SEC || cfg.poll_sec) store.metaSet("poll_sec", String(env.POLL_SEC || cfg.poll_sec));
    const subs = readJson(subsFile, []);
    if (Array.isArray(subs)) {
      for (const raw of subs) {
        const sub = legacySub(raw);
        if (!sub) continue;
        try { store.insertSub(admin.id, sub); }
        catch (e) { log("WARNING", `abonnement overgeslagen: ${errStr(e)}`); }
      }
    }
    const st = readJson(stateFile, null);
    if (st && typeof st === "object" && !Array.isArray(st)) store.writeState(admin.id, st);
    const dig = readJson(digestFile, null);
    if (dig && typeof dig === "object" && !Array.isArray(dig)) {
      store.writeDigest(admin.id, dig.events && typeof dig.events === "object" ? dig.events : {}, Array.isArray(dig.slots) ? dig.slots : []);
    }
    store.metaSet("legacy_imported", "1");
    log("INFO", "bestaande abonnementen en ntfy-topic geïmporteerd");
  }

  function nsGet(nsPath, params, ttl = 90) {
    const key = apiKey();
    if (!key) throw new NoKey("NS_API_KEY missing");
    const url = NS + nsPath + (params ? `?${encodeParams(params)}` : "");
    const hit = cache.get(url);
    if (hit && Date.now() / 1000 - hit[0] < ttl) return Promise.resolve(hit[1]);
    nsQueued += 1;
    const run = nsChain.then(() => nsFetch(url, key, ttl)).finally(() => { nsQueued -= 1; });
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
    try { store.addNsCount(amsterdamParts(new Date()).ymd); } catch { /* db closed */ }
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

  async function notifyUser(user, title, body, prio = "default", kind = "alert", extra = {}) {
    const server = userServer(user);
    if (!(await isAllowedNotifyUrl(`${server}/`, { allowPrivate: allowPrivate() }))) throw new Error("ntfy-server niet toegestaan");
    const mapped = { min: 1, low: 2, default: 3, high: 4, urgent: 5 }[prio];
    const priority = mapped ?? 3;
    const payloadObj = { topic: user.ntfy_topic, title, message: body, priority };
    if (kind === "alert") {
      payloadObj.tags = prio === "urgent" ? ["train", "rotating_light"] : (prio === "high" ? ["train", "warning"] : ["train"]);
      if (extra.click) payloadObj.click = extra.click;
    }
    const payload = JSON.stringify(payloadObj);
    const r = await fetch(`${server}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    if (r.status >= 300 && r.status < 400) throw new Error("ntfy-redirect geweigerd");
    if (!r.ok) throw new Error(`HTTP Error ${r.status}`);
    store.addNotification({
      user_id: user.id,
      username: user.username,
      kind,
      title,
      body,
      priority,
      created_at: new Date().toISOString(),
    });
    return r.status;
  }

  async function laterTrains(sub, dep, cur, trips) {
    let alts = detect.alternativeTrains(trips, { after: sub.time, skipNumber: cur.trainNumber });
    if (alts.length) return alts;
    const more = await nsGet("/reisinformatie-api/api/v3/trips", {
      fromStation: sub.from,
      toStation: sub.to,
      dateTime: isoOffsetSeconds(dep),
      previousAdvices: 0,
      nextAdvices: 6,
    });
    return detect.alternativeTrains(more?.trips, { after: sub.time, skipNumber: cur.trainNumber });
  }

  async function checkSub(sub, dep) {
    let cur;
    let trips = null;
    let deps = null;
    if (sub.train) {
      const d = await nsGet("/reisinformatie-api/api/v2/departures", { station: sub.from, maxJourneys: 40 });
      deps = d?.payload?.departures || [];
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
      trips = d.trips || [];
      const t = detect.pickTrip(trips, sub.time);
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
    cur.alternatives = [];
    if (cur.cancelled || (cur.delay || 0) >= 10 || cur.partCancelled) {
      try {
        cur.alternatives = sub.train
          ? detect.alternativeDepartures(deps, {
            after: (cur.planned || "").slice(11, 16) || sub.time,
            skipNumber: sub.train,
            direction: cur.direction || "",
          })
          : await laterTrains(sub, dep, cur, trips);
      } catch (e) {
        if (e instanceof NoKey) throw e;
        log("WARNING", `alternatives failed: ${errStr(e)}`);
        cur.alternatives = [];
      }
    }
    return cur;
  }

  function pruneFinished(when) {
    for (const user of store.listUsers()) {
      for (const sub of store.listSubs(user.id)) {
        if (oneTimeFinished(sub, when)) store.deleteSub(user.id, sub.id);
      }
    }
  }

  async function pollOnceInner(now) {
    const when = now || new Date();
    pruneFinished(when);
    if (!apiKey()) {
      status.error = "NS_API_KEY missing";
      status.last_poll = isoNaive(when);
      return;
    }
    for (const user of store.listUsers()) {
      if (user.disabled) continue;
      const subs = store.listSubs(user.id);
      const st = store.readState(user.id);
      const today = isoDate(when);
      const drop = new Set();
      for (const sub of subs) {
        let dep;
        try { dep = activeWindow(sub, when, user.window_min); }
        catch (e) { log("WARNING", `check ${sub.id} failed: ${errStr(e)}`); status.error = errStr(e); continue; }
        if (!dep) continue;
        const k = `${sub.id}@${today}`;
        let cur;
        try { cur = await checkSub(sub, dep); }
        catch (e) { log("WARNING", `check ${sub.id} failed: ${errStr(e)}`); status.error = errStr(e); continue; }
        if (!cur) continue;
        const prev = Object.prototype.hasOwnProperty.call(st, k) ? st[k] : null;
        const ev = detect.diff(prev, cur, user.delay_threshold, user.delay_grow);
        st[k] = cur;
        if (ev.length) {
          const [title, body, prio, click] = detect.formatMsg(sub, cur, ev);
          log("INFO", `NOTIFY ${user.username}: ${title}`);
          try { await notifyUser(user, title, body, prio, "alert", { click }); }
          catch (e) { log("WARNING", `ntfy failed: ${errStr(e)}`); }
        }
        if (oneTimeFinished(sub, when, cur.arrival)) drop.add(sub.id);
      }
      for (const id of drop) store.deleteSub(user.id, id);
      const next = {};
      for (const [k, v] of Object.entries(st)) if (String(k).endsWith(today)) next[k] = v;
      store.writeState(user.id, next);
    }
    status.error = null;
    status.last_poll = isoNaive(when);
  }

  function pollOnce(now) {
    const run = pollChain.then(() => pollOnceInner(now));
    pollChain = run.then(() => {}, () => {});
    return run;
  }

  async function runDigestInner(user, { now, slot, force } = {}) {
    if (!apiKey()) throw new NoKey("NS_API_KEY missing");
    const when = now || new Date();
    const target = slot ? digestTarget(when, slot) : digestTargetFromNow(when);
    const dis = await nsGet("/disruptions/v3", null, 60);
    const list = Array.isArray(dis) ? dis : (dis?.payload || []);
    const prev = store.readDigest(user.id);
    const built = buildDigest({
      disruptions: list,
      subs: store.listSubs(user.id),
      ymd: target.ymd,
      weekday: target.weekday,
      label: target.label,
      previous: force ? { events: {} } : prev,
      quiet: Boolean(user.digest_quiet),
    });
    if (built.sent) await notifyUser(user, built.title, built.body, built.priority, "digest");
    const slots = markSlot(prev.slots, when, slot);
    store.writeDigest(user.id, built.next.events, slots);
    store.addDigestRun({
      user_id: user.id,
      username: user.username,
      sent: built.sent,
      count: built.count,
      reason: built.reason || "",
      label: target.label,
      created_at: new Date().toISOString(),
    });
    const p = amsterdamParts(when);
    digestStatus.set(user.id, { at: `${p.ymd} ${p.hhmm}`, sent: built.sent, count: built.count, label: target.label });
    return { ok: true, sent: built.sent, count: built.count, reason: built.reason ?? null };
  }

  function runDigest(userOrOpts, maybeOpts) {
    const run = pollChain.then(async () => {
      if (userOrOpts && userOrOpts.id) return runDigestInner(userOrOpts, maybeOpts || {});
      const opts = userOrOpts || {};
      const users = store.listUsers().filter((u) => !u.disabled);
      if (!users.length) throw new Error("geen gebruiker");
      return runDigestInner(users[0], opts);
    });
    pollChain = run.then(() => {}, () => {});
    return run;
  }

  async function maybeDigestInner(now) {
    if (!digestGloballyOn() || !apiKey()) return [];
    const when = now || new Date();
    const results = [];
    for (const user of store.listUsers()) {
      if (user.disabled || !user.digest_enabled) continue;
      const due = dueSlots(when, user.digest_times || ["06:00", "21:00"], store.readDigest(user.id).slots);
      for (const slot of due) {
        try { results.push(await runDigestInner(user, { now: when, slot: slot.time, force: false })); }
        catch (e) {
          log("WARNING", `digest failed: ${errStr(e)}`);
          status.error = errStr(e);
          results.push({ ok: false, error: errStr(e) });
        }
      }
    }
    return results;
  }

  function maybeDigest(now) {
    const run = pollChain.then(() => maybeDigestInner(now));
    pollChain = run.then(() => {}, () => {});
    return run;
  }

  function startPoller() {
    stopped = false;
    pollerPromise = (async () => {
      while (!stopped) {
        try { await pollOnce(); }
        catch (e) { log("WARNING", errStr(e)); status.error = errStr(e); }
        try { await maybeDigest(); }
        catch (e) { log("WARNING", errStr(e)); status.error = errStr(e); }
        if (stopped) break;
        await sleep(pollSeconds() * 1000);
      }
    })();
  }

  function send(res, code, obj, ctype = "application/json") {
    const b = Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj));
    const headers = {
      ...securityHeaders(),
      "Content-Type": `${ctype}; charset=utf-8`,
      "Content-Length": b.length,
    };
    if (res.cookies?.length) headers["Set-Cookie"] = res.cookies;
    res.writeHead(code, headers);
    res.end(b);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; reject(e); } };
      const ok = (v) => { if (!settled) { settled = true; resolve(v); } };
      const n = Number(req.headers["content-length"] || 0);
      if (n > MAX_BODY) {
        const err = new Error("body te groot");
        err.status = 413;
        return fail(err);
      }
      if (!n) return ok({});
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          const err = new Error("body te groot");
          err.status = 413;
          fail(err);
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).subarray(0, n).toString("utf8");
          ok(raw ? JSON.parse(raw) : {});
        } catch (e) { fail(e); }
      });
      req.on("error", fail);
    });
  }

  function ensureCsrf(req, res) {
    const cookies = readCookies(req);
    res.cookies = [];
    if (!cookies.csrf || String(cookies.csrf).length < 16) {
      cookies.csrf = crypto.randomBytes(18).toString("base64url");
      res.cookies.push(cookieHeader("csrf", cookies.csrf, { secure: secureCookie() }));
    }
    return cookies;
  }

  function csrfOk(req, cookies) {
    const header = String(req.headers["x-csrf-token"] || "");
    return Boolean(cookies.csrf) && tokensEqual(header, cookies.csrf);
  }

  function sessionUser(req) {
    const sid = readCookies(req).sid;
    if (!sid) return null;
    const row = store.getSession(sid);
    if (!row || row.expires_at < Date.now()) {
      if (row) store.deleteSession(sid);
      return null;
    }
    const user = store.getUser(row.user_id);
    if (!user || user.disabled) {
      store.deleteSession(sid);
      return null;
    }
    return user;
  }

  function setSession(res, user) {
    const sid = crypto.randomBytes(24).toString("base64url");
    store.deleteUserSessions(user.id);
    store.createSession(sid, user.id, Date.now() + SESSION_MS);
    store.touchLogin(user.id, new Date().toISOString());
    res.cookies.push(cookieHeader("sid", sid, { maxAge: SESSION_MS / 1000, httpOnly: true, secure: secureCookie() }));
  }

  function requireUser(req, res) {
    const user = sessionUser(req);
    if (!user) {
      send(res, 401, { error: "niet ingelogd" });
      return null;
    }
    return user;
  }

  function requireAdmin(req, res) {
    const user = requireUser(req, res);
    if (!user) return null;
    if (user.role !== "admin") {
      send(res, 403, { error: "alleen voor beheerders" });
      return null;
    }
    return user;
  }

  async function statusFor(user) {
    return {
      key: Boolean(apiKey()),
      topic: user.ntfy_topic,
      server: await safeServer(user),
      threshold: user.delay_threshold,
      window_min: user.window_min,
      last_poll: status.last_poll,
      error: status.error,
      digest_enabled: user.digest_enabled,
      digest_times: user.digest_times,
      digest_quiet: user.digest_quiet,
      last_digest: digestStatus.get(user.id) || null,
      username: user.username,
      role: user.role,
    };
  }

  function cleanSub(b) {
    if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "ongeldige lijst" };
    if (!b.from || !(b.to || b.train) || !b.time) return { error: "van, naar/treinnummer en tijd verplicht" };
    const from = String(b.from).toUpperCase();
    const to = String(b.to || "").toUpperCase();
    if (!/^[A-Z0-9]{1,10}$/.test(from) || (to && !/^[A-Z0-9]{1,10}$/.test(to))) return { error: "ongeldig station" };
    const time = String(b.time);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { error: "tijd moet HH:MM zijn" };
    const train = b.train ? String(b.train).replace(/\D/g, "").slice(0, 8) : "";
    if (b.train && !train && !to) return { error: "van, naar/treinnummer en tijd verplicht" };
    const date = typeof b.date === "string" ? b.date.trim() : "";
    if (date && !validDate(date)) return { error: "datum moet JJJJ-MM-DD zijn" };
    let days;
    if (!date) {
      if (Array.isArray(b.days) && b.days.length) {
        if (b.days.some((d) => !DAYS.includes(d))) return { error: "ongeldige dagen" };
        days = [...new Set(b.days)];
      } else days = DAYS.slice(0, 5);
    }
    const id = validSubId(b.id) ? b.id : crypto.randomBytes(4).toString("hex");
    const sub = {
      id,
      from,
      fromName: b.fromName ? String(b.fromName).slice(0, 80) : null,
      to,
      toName: b.toName ? String(b.toName).slice(0, 80) : null,
      time,
      label: b.label ? String(b.label).slice(0, 80) : null,
      train: train || null,
    };
    if (date) sub.date = date;
    else sub.days = days;
    return { sub };
  }

  function audit(admin, action, target, detail) {
    store.audit({
      admin_id: admin.id,
      admin_name: admin.username,
      action,
      target: target || "",
      detail: detail || "",
      created_at: new Date().toISOString(),
    });
  }

  function guardLastAdmin(actor, target, res, verb) {
    if (target.id === actor.id) {
      send(res, 400, { error: verb === "delete" ? "je kunt jezelf niet verwijderen" : "je kunt jezelf niet uitschakelen" });
      return false;
    }
    if (target.role === "admin" && !target.disabled && store.countAdmins() <= 1) {
      send(res, 400, { error: "laatste beheerder blijft actief" });
      return false;
    }
    return true;
  }

  async function handle(req, res) {
    const u = new URL(req.url, "http://127.0.0.1");
    const cookies = ensureCsrf(req, res);
    if (req.method !== "GET" && req.method !== "HEAD") {
      const n = Number(req.headers["content-length"] || 0);
      if (n > MAX_BODY) return send(res, 413, { error: "body te groot" });
      if (isCrossSite(req)) return send(res, 403, { error: "cross-origin geweigerd" });
      if (!csrfOk(req, cookies)) return send(res, 403, { error: "csrf geweigerd" });
    }
    try {
      if (req.method === "GET") return await handleGet(req, res, u);
      if (req.method === "POST") return await handlePost(req, res, u);
      if (req.method === "DELETE") return await handleDelete(req, res, u);
      send(res, 404, { error: "not found" });
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof SyntaxError) return send(res, 400, { error: "ongeldige json" });
      if (e.status === 413) return send(res, 413, { error: "body te groot" });
      log("WARNING", errStr(e));
      send(res, 500, { error: "interne fout" });
    }
  }

  async function handleGet(req, res, u) {
    const file = STATIC[u.pathname];
    if (file) {
      const full = path.join(base, "static", file[0]);
      if (!fs.existsSync(full)) return send(res, 404, { error: "not found" });
      return send(res, 200, fs.readFileSync(full, "utf8"), file[1]);
    }
    if (u.pathname === "/healthz") return send(res, 200, { ok: true });
    if (!u.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
    if (u.pathname === "/api/topic/qr") {
      const user = requireUser(req, res);
      if (!user) return;
      const svg = await QRCode.toString(`${await safeServer(user)}/${user.ntfy_topic}`, { type: "svg", margin: 1 });
      return send(res, 200, svg, "image/svg+xml");
    }
    const user = requireUser(req, res);
    if (!user) return;
    if (u.pathname === "/api/subs" || u.pathname === "/api/export") return send(res, 200, store.listSubs(user.id));
    if (u.pathname === "/api/status") return send(res, 200, await statusFor(store.getUser(user.id)));
    if (u.pathname === "/api/admin/overview") {
      if (user.role !== "admin") return send(res, 403, { error: "alleen voor beheerders" });
      const day = amsterdamParts(new Date()).ymd;
      return send(res, 200, {
        users: store.listUsers().map((row) => ({
          id: row.id,
          username: row.username,
          role: row.role,
          disabled: row.disabled,
          last_login_at: row.last_login_at,
          subs: row.subs,
          topic: maskSecret(row.ntfy_topic),
          created_at: row.created_at,
        })),
        invites: store.listInvites(),
        system: {
          key: Boolean(apiKey()),
          last_poll: status.last_poll,
          error: status.error,
          ns_today: store.nsCount(day),
          ns_queued: nsQueued,
          rate: "1 request/s",
        },
        notifications: store.recentNotifications(40),
        digest_runs: store.recentDigestRuns(20),
        audit: store.recentAudit(40),
      });
    }
    if (u.pathname === "/api/stations") {
      const term = (u.searchParams.get("q") ?? "").slice(0, 40).toLowerCase();
      try {
        const resStations = (await stations()).filter((s) => (s.name || "").toLowerCase().includes(term) || term === (s.code || "").toLowerCase()).slice(0, 10);
        return send(res, 200, resStations);
      } catch (e) {
        if (e instanceof NoKey) return send(res, 503, { error: "NS_API_KEY missing" });
        return send(res, 502, { error: "NS-verzoek mislukt" });
      }
    }
    return send(res, 404, { error: "not found" });
  }

  async function handlePost(req, res, u) {
    if (u.pathname === "/api/login") return login(req, res);
    if (u.pathname === "/api/register") return register(req, res);
    if (u.pathname === "/api/reset") return resetPassword(req, res);
    if (u.pathname === "/api/logout") {
      const sid = readCookies(req).sid;
      if (sid) store.deleteSession(sid);
      res.cookies.push(cookieHeader("sid", "", { maxAge: 0, httpOnly: true, secure: secureCookie() }));
      return send(res, 200, { ok: true });
    }
    const adminMatch = /^\/api\/admin\/users\/([0-9a-f]{32})\/(disable|enable|reset|digest|test)$/.exec(u.pathname);
    if (u.pathname === "/api/admin/invites" || /^\/api\/admin\/invites\/[A-Za-z0-9_-]{8,64}\/revoke$/.test(u.pathname) || adminMatch) {
      return adminPost(req, res, u, adminMatch);
    }
    const user = requireUser(req, res);
    if (!user) return;
    if (u.pathname === "/api/subs") {
      const cleaned = cleanSub(await readBody(req));
      if (cleaned.error) return send(res, 400, { error: cleaned.error });
      store.insertSub(user.id, cleaned.sub);
      return send(res, 200, cleaned.sub);
    }
    if (u.pathname === "/api/import") {
      const b = await readBody(req);
      if (!Array.isArray(b)) return send(res, 400, { error: "ongeldige lijst" });
      if (b.length > 200) return send(res, 400, { error: "te veel abonnementen" });
      const list = [];
      const ids = new Set();
      for (const item of b) {
        const cleaned = cleanSub(item);
        if (cleaned.error) return send(res, 400, { error: cleaned.error === "ongeldige lijst" ? "ongeldige lijst" : cleaned.error });
        if (ids.has(cleaned.sub.id)) cleaned.sub.id = crypto.randomBytes(4).toString("hex");
        ids.add(cleaned.sub.id);
        list.push(cleaned.sub);
      }
      store.replaceSubs(user.id, list);
      return send(res, 200, { ok: true, count: list.length });
    }
    if (u.pathname === "/api/test") {
      try { await notifyUser(user, "🚆 Test melding", "NS treinalerts werkt! Je ontvangt hier meldingen bij vertraging, spoorwijziging of uitval.", "default", "test"); }
      catch (e) { return send(res, 502, { error: errStr(e) }); }
      return send(res, 200, { ok: true });
    }
    if (u.pathname === "/api/digest") {
      try { return send(res, 200, await runDigest(user, { force: true })); }
      catch (e) {
        if (e instanceof NoKey) return send(res, 503, { error: "NS_API_KEY missing" });
        return send(res, 502, { error: errStr(e) });
      }
    }
    if (u.pathname === "/api/topic") {
      const topic = makeTopic();
      store.updateSettings(user.id, { ntfy_topic: topic });
      return send(res, 200, { topic, server: await safeServer(store.getUser(user.id)) });
    }
    if (u.pathname === "/api/settings") return saveSettings(req, res, user);
    return send(res, 404, { error: "not found" });
  }

  async function login(req, res) {
    const ip = clientIp(req);
    if (loginFails.blocked(ip)) return send(res, 429, { error: "te veel pogingen" });
    const b = await readBody(req);
    const found = store.getUserByName(String(b.username || "").trim());
    const ok = await verifyPassword(String(b.password || ""), found ? found.password_hash : await passwordDummy());
    if (!found || !ok) {
      if (loginFails(ip)) return send(res, 429, { error: "te veel pogingen" });
      return send(res, 401, { error: "ongeldige combinatie" });
    }
    if (found.disabled) return send(res, 403, { error: "account uitgeschakeld" });
    setSession(res, found);
    return send(res, 200, { ok: true, username: found.username, role: found.role });
  }

  async function register(req, res) {
    const ip = clientIp(req);
    if (registerFails.blocked(ip)) return send(res, 429, { error: "te veel pogingen" });
    registerFails(ip);
    const b = await readBody(req);
    const username = String(b.username || "").trim();
    if (!validUsername(username)) return send(res, 400, { error: "gebruikersnaam: 3-32 tekens, letters, cijfers, . _ -" });
    if (!validPassword(b.password)) return send(res, 400, { error: "wachtwoord moet 8 tekens of langer zijn" });
    if (store.getUserByName(username)) return send(res, 400, { error: "gebruikersnaam bestaat al" });
    const code = String(b.invite || "").trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(code)) return send(res, 400, { error: "uitnodiging ongeldig" });
    const id = crypto.randomBytes(16).toString("hex");
    try { store.redeemInvite(code, id, username, new Date().toISOString()); }
    catch (e) {
      const msg = errStr(e) === "uitnodiging verlopen" ? "uitnodiging verlopen" : "uitnodiging ongeldig";
      return send(res, 400, { error: msg });
    }
    const user = store.insertUser({
      id,
      username,
      password_hash: await hashPassword(b.password, scryptCost(env)),
      role: "user",
      ...freshSettings(),
      created_at: new Date().toISOString(),
    });
    setSession(res, user);
    return send(res, 200, { ok: true, username: user.username });
  }

  async function resetPassword(req, res) {
    const b = await readBody(req);
    if (!validPassword(b.password)) return send(res, 400, { error: "wachtwoord moet 8 tekens of langer zijn" });
    const code = String(b.code || "");
    if (code.length < 16 || code.length > 200) return send(res, 400, { error: "code ongeldig" });
    const userId = store.takeReset(hashToken(code), Date.now());
    if (!userId) return send(res, 400, { error: "code ongeldig" });
    store.setPassword(userId, await hashPassword(b.password, scryptCost(env)));
    store.deleteUserSessions(userId);
    return send(res, 200, { ok: true });
  }

  async function saveSettings(req, res, user) {
    const b = await readBody(req);
    const patch = {};
    try {
      if (Object.prototype.hasOwnProperty.call(b, "threshold")) patch.delay_threshold = Math.max(1, pyInt(b.threshold));
      if (Object.prototype.hasOwnProperty.call(b, "window_min")) patch.window_min = Math.max(1, pyInt(b.window_min));
    } catch { return send(res, 400, { error: "ongeldig getal" }); }
    if (Object.prototype.hasOwnProperty.call(b, "digest_times")) {
      const times = parseDigestTimes(b.digest_times);
      if (!times) return send(res, 400, { error: "tijden moeten HH:MM zijn, gescheiden door komma's" });
      patch.digest_times = times;
    }
    if (Object.prototype.hasOwnProperty.call(b, "digest_enabled")) patch.digest_enabled = Boolean(b.digest_enabled);
    if (Object.prototype.hasOwnProperty.call(b, "digest_quiet")) patch.digest_quiet = Boolean(b.digest_quiet);
    if (Object.prototype.hasOwnProperty.call(b, "ntfy_server")) {
      const raw = String(b.ntfy_server || "").trim().replace(/\/+$/, "");
      if (!raw || raw === "https://ntfy.sh") patch.ntfy_server = "";
      else {
        if (!(await isAllowedNotifyUrl(`${raw}/`, { allowPrivate: allowPrivate() }))) return send(res, 400, { error: "ntfy-server niet toegestaan" });
        patch.ntfy_server = raw;
      }
    }
    const next = store.updateSettings(user.id, patch);
    return send(res, 200, { ok: true, server: await safeServer(next) });
  }

  async function adminPost(req, res, u, adminMatch) {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    if (u.pathname === "/api/admin/invites") {
      const b = await readBody(req);
      let maxUses = 1;
      try { maxUses = Math.min(1000, Math.max(1, pyInt(b.maxUses ?? 1))); }
      catch { return send(res, 400, { error: "ongeldig aantal" }); }
      let expires = null;
      if (b.expiresAt) {
        const t = Date.parse(String(b.expiresAt));
        if (!Number.isFinite(t)) return send(res, 400, { error: "ongeldige vervaldatum" });
        expires = new Date(t).toISOString();
      }
      const code = crypto.randomBytes(12).toString("base64url");
      store.createInvite({ code, max_uses: maxUses, expires_at: expires, created_by: admin.id, created_at: new Date().toISOString() });
      audit(admin, "invite.create", code, `max ${maxUses}`);
      return send(res, 200, { code, maxUses, expiresAt: expires });
    }
    const revoke = /^\/api\/admin\/invites\/([A-Za-z0-9_-]{8,64})\/revoke$/.exec(u.pathname);
    if (revoke) {
      if (!store.revokeInvite(revoke[1])) return send(res, 404, { error: "niet gevonden" });
      audit(admin, "invite.revoke", revoke[1], "");
      return send(res, 200, { ok: true });
    }
    const target = store.getUser(adminMatch[1]);
    if (!target) return send(res, 404, { error: "niet gevonden" });
    const action = adminMatch[2];
    if (action === "disable" || action === "enable") {
      const disabling = action === "disable";
      if (disabling && !guardLastAdmin(admin, target, res, "disable")) return;
      store.setDisabled(target.id, disabling);
      if (disabling) store.deleteUserSessions(target.id);
      audit(admin, disabling ? "user.disable" : "user.enable", target.username, "");
      return send(res, 200, { ok: true });
    }
    if (action === "reset") {
      const code = crypto.randomBytes(18).toString("base64url");
      store.createReset({
        id: crypto.randomBytes(16).toString("hex"),
        user_id: target.id,
        code_hash: hashToken(code),
        expires_at: Date.now() + 24 * 3600 * 1000,
      });
      audit(admin, "user.reset", target.username, "eenmalige code, 24 uur");
      return send(res, 200, { code, path: "/wachtwoord" });
    }
    if (action === "digest") {
      try {
        const out = await runDigest(target, { force: true });
        audit(admin, "user.digest", target.username, out.sent ? "verstuurd" : (out.reason || ""));
        return send(res, 200, out);
      } catch (e) {
        if (e instanceof NoKey) return send(res, 503, { error: "NS_API_KEY missing" });
        return send(res, 502, { error: errStr(e) });
      }
    }
    try { await notifyUser(target, "🚆 Test melding", "Test van de beheerder: NS treinalerts werkt.", "default", "test"); }
    catch (e) { return send(res, 502, { error: errStr(e) }); }
    audit(admin, "user.test", target.username, "");
    return send(res, 200, { ok: true });
  }

  async function handleDelete(req, res, u) {
    const adminDel = /^\/api\/admin\/users\/([0-9a-f]{32})$/.exec(u.pathname);
    if (adminDel) {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const target = store.getUser(adminDel[1]);
      if (!target) return send(res, 404, { error: "niet gevonden" });
      if (!guardLastAdmin(admin, target, res, "delete")) return;
      const name = target.username;
      store.deleteUser(target.id);
      audit(admin, "user.delete", name, "");
      return send(res, 200, { ok: true });
    }
    const user = requireUser(req, res);
    if (!user) return;
    if (u.pathname.startsWith("/api/subs/")) {
      const id = decodeURIComponent(u.pathname.slice("/api/subs/".length));
      if (!validSubId(id)) return send(res, 400, { error: "ongeldig id" });
      if (!store.deleteSub(user.id, id)) return send(res, 404, { error: "niet gevonden" });
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "not found" });
  }

  async function listen() {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
    port = server.address().port;
  }

  async function start() {
    fs.mkdirSync(dataDir, { recursive: true });
    store = openDb(path.join(dataDir, "app.sqlite"));
    copySeed();
    const admin = await ensureAdmin();
    await migrateLegacy(admin);
    if (!apiKey()) log("WARNING", "NS_API_KEY missing — UI draait, poller staat stil tot de key er is (zet in .env en herstart)");
    await listen();
    if (opts.poll !== false) startPoller();
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
    try { store?.close(); } catch { /* already closed */ }
    store = null;
  }

  const api = {
    start,
    close,
    pollOnce,
    runDigest,
    maybeDigest,
    activeWindow,
    get port() { return port; },
    dataDir,
    subsFile,
    get store() { return store; },
  };
  return api;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirect) {
  loadEnv(BASE, process.env);
  const app = createApp();
  app.start().catch((e) => { console.error(e); process.exit(1); });
}
