/**
 * Zet data van de vorige versie om naar het bereik-schema.
 * Veilig om opnieuw te draaien: een tweede keer wijzigt niets.
 *
 *   npm run migrate -- --dry-run
 *   npm run migrate -- --to-range=15 --data-dir ./data
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DAYS, parseHHMM, shiftClock } from "../app.js";

const WEEKDAYS = DAYS.slice(0, 5);
const CONFIG_DEFAULTS = {
  ntfy_server: "https://ntfy.sh",
  delay_threshold: 3,
  delay_grow: 5,
  window_min: 30,
  poll_sec: 120,
  digest_enabled: true,
  digest_times: ["06:00", "21:00"],
  digest_quiet: false,
  range_margin: 15,
};
const NUMBER_KEYS = ["delay_threshold", "delay_grow", "window_min", "poll_sec", "range_margin"];

function validId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(id);
}

function validDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) return false;
  const dt = new Date(+m[1], +m[2] - 1, +m[3]);
  return dt.getFullYear() === +m[1] && dt.getMonth() === +m[2] - 1 && dt.getDate() === +m[3];
}

function text(v, max) {
  const s = v == null ? "" : String(v).trim();
  return s ? s.slice(0, max) : "";
}

function stableId(index, parts) {
  const hash = crypto.createHash("sha256").update(`${index}\n${parts.join("\n")}`).digest("hex");
  return hash.slice(0, 8);
}

function isRange(sub) {
  return Boolean(sub?.timeFrom && sub?.timeTo);
}

/** Maak één abonnement canoniek. Fout → { error }. */
export function normalizeSub(raw, { toRange = false, margin = 15, index = 0, usedIds = new Set() } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "abonnement is geen object" };
  const from = String(raw.from || "").trim().toUpperCase();
  const to = String(raw.to || "").trim().toUpperCase();
  const train = raw.train ? String(raw.train).replace(/\D/g, "").slice(0, 8) : "";
  const timeText = raw.time == null ? "" : String(raw.time).trim();
  const fromText = raw.timeFrom == null ? "" : String(raw.timeFrom).trim();
  const toText = raw.timeTo == null ? "" : String(raw.timeTo).trim();
  const time = timeText ? parseHHMM(timeText) : "";
  const timeFromIn = fromText ? parseHHMM(fromText) : "";
  const timeToIn = toText ? parseHHMM(toText) : "";
  if ((timeText && !time) || (fromText && !timeFromIn) || (toText && !timeToIn)) return { error: "tijd moet HH:MM zijn" };
  let ranged = Boolean(timeFromIn || timeToIn);
  if (ranged && (!timeFromIn || !timeToIn)) return { error: "van en tot zijn allebei verplicht" };
  if (ranged && timeFromIn > timeToIn) return { error: "tot moet later zijn dan van" };
  if (!ranged && !time) return { error: "tijd ontbreekt" };
  if (!from || !(to || train)) return { error: "van en naar (of een treinnummer) zijn verplicht" };
  if (!/^[A-Z0-9]{1,10}$/.test(from) || (to && !/^[A-Z0-9]{1,10}$/.test(to))) return { error: "ongeldig station" };
  let when = "depart";
  if (ranged) {
    if (raw.when != null && String(raw.when).trim() !== "") {
      when = String(raw.when).trim();
      if (when !== "depart" && when !== "arrive") return { error: "kies vertrek of aankomst" };
    }
    if (train) return { error: "treinnummer hoort bij één vertrektijd" };
    if (!to) return { error: "een bereik heeft een bestemming nodig" };
  }
  const date = typeof raw.date === "string" ? raw.date.trim() : "";
  if (date && !validDate(date)) return { error: "datum moet JJJJ-MM-DD zijn" };
  let days;
  let daysFilled = false;
  if (!date) {
    if (Array.isArray(raw.days) && raw.days.length) {
      if (raw.days.some((d) => !DAYS.includes(d))) return { error: "ongeldige dagen" };
      days = [];
      for (const d of raw.days) if (!days.includes(d)) days.push(d);
    } else {
      days = WEEKDAYS.slice();
      daysFilled = true;
    }
  }
  let timeFrom = timeFromIn;
  let timeTo = timeToIn;
  let converted = false;
  let keptTrain = false;
  if (toRange && !ranged) {
    if (!to || train) keptTrain = Boolean(train) || !to;
    else {
      timeFrom = shiftClock(time, -margin);
      timeTo = shiftClock(time, margin);
      if (!timeFrom || !timeTo || timeFrom > timeTo) return { error: "marge past niet op deze dag" };
      ranged = true;
      when = "depart";
      converted = true;
    }
  }
  let id = validId(raw.id) ? raw.id : "";
  const idMade = !id;
  if (!id) {
    id = stableId(index, [from, to, time, train, date, (days || []).join(",")]);
    while (usedIds.has(id)) id = stableId(index, [id, from, to, time]);
  }
  if (usedIds.has(id)) return { error: `dubbel id ${id}` };
  usedIds.add(id);
  const sub = { id, from, to, time: ranged ? timeFrom : time };
  const fromName = text(raw.fromName, 80);
  const toName = text(raw.toName, 80);
  const label = text(raw.label, 80);
  if (fromName) sub.fromName = fromName;
  if (toName) sub.toName = toName;
  if (label) sub.label = label;
  if (ranged) {
    sub.timeFrom = timeFrom;
    sub.timeTo = timeTo;
    sub.when = when;
  }
  if (train && !ranged) sub.train = train;
  if (date) sub.date = date;
  else sub.days = days;
  return { sub, notes: { converted, keptTrain, daysFilled, idMade, normalizedTime: timeText && timeText !== sub.time && !converted } };
}

export function normalizeSubs(list, opts) {
  if (!Array.isArray(list)) return { error: "subscriptions.json moet een lijst zijn" };
  const usedIds = new Set();
  const subs = [];
  const notes = [];
  for (let i = 0; i < list.length; i++) {
    const out = normalizeSub(list[i], { ...opts, index: i, usedIds });
    if (out.error) return { error: `abonnement ${i + 1}: ${out.error}` };
    subs.push(out.sub);
    notes.push(out.notes);
  }
  return { subs, notes };
}

function coerceNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

export function mergeConfig(raw) {
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) return { error: "config.json moet een object zijn" };
  const cfg = {};
  const added = [];
  const kept = [];
  for (const [k, v] of Object.entries(raw || {})) cfg[k] = v;
  for (const key of NUMBER_KEYS) {
    if (cfg[key] == null || cfg[key] === "") continue;
    const n = coerceNumber(cfg[key]);
    if (n == null) return { error: `configuratie ${key} is geen getal` };
    if (key === "range_margin" && (n < 0 || n > 180)) return { error: "range_margin moet tussen 0 en 180 liggen" };
    if (key !== "range_margin" && n < 1) return { error: `configuratie ${key} moet minstens 1 zijn` };
    if (cfg[key] !== n) cfg[key] = n;
  }
  if (cfg.digest_times != null) {
    if (!Array.isArray(cfg.digest_times) || !cfg.digest_times.length || cfg.digest_times.some((t) => !parseHHMM(t))) {
      return { error: "digest_times moet een lijst HH:MM zijn" };
    }
  }
  for (const [k, def] of Object.entries(CONFIG_DEFAULTS)) {
    if (cfg[k] == null || cfg[k] === "") {
      cfg[k] = Array.isArray(def) ? def.slice() : def;
      added.push(k);
    } else kept.push(k);
  }
  const extra = Object.keys(cfg).filter((key) => !Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key));
  return { config: cfg, added, kept, extra };
}

function stateMatches(sub, key) {
  if (!key.startsWith(`${sub.id}@`)) return false;
  const rest = key.slice(sub.id.length + 1);
  if (isRange(sub)) return /^\d{4}-\d{2}-\d{2}@.+/.test(rest);
  return /^\d{4}-\d{2}-\d{2}$/.test(rest);
}

export function pruneState(state, subs) {
  if (state == null) return { state: null, kept: [], dropped: [] };
  if (typeof state !== "object" || Array.isArray(state)) return { error: "state.json moet een object zijn" };
  const next = {};
  const kept = [];
  const dropped = [];
  const keys = Object.keys(state).sort();
  for (const key of keys) {
    const value = state[key];
    const sub = subs.find((s) => stateMatches(s, key));
    if (!sub || !value || typeof value !== "object" || Array.isArray(value)) {
      const why = !subs.some((s) => key.startsWith(`${s.id}@`)) ? "onbekend abonnement" : "past niet meer bij dit abonnement";
      dropped.push({ key, why });
      continue;
    }
    next[key] = value;
    kept.push(key);
  }
  return { state: next, kept, dropped };
}

export function planMigration({ subscriptions, config, state, toRange = false, margin = 15 }) {
  const subsOut = normalizeSubs(subscriptions ?? [], { toRange, margin });
  if (subsOut.error) return { error: subsOut.error };
  const cfgOut = mergeConfig(config ?? {});
  if (cfgOut.error) return { error: cfgOut.error };
  const stateOut = pruneState(state, subsOut.subs);
  if (stateOut.error) return { error: stateOut.error };
  return {
    subscriptions: subsOut.subs,
    notes: subsOut.notes,
    config: cfgOut.config,
    configAdded: cfgOut.added,
    configKept: cfgOut.kept,
    configExtra: cfgOut.extra,
    state: stateOut.state,
    stateKept: stateOut.kept,
    stateDropped: stateOut.dropped,
  };
}

function subLine(sub, note) {
  const who = `${sub.from}${sub.to ? ` → ${sub.to}` : ""}${sub.train ? ` trein ${sub.train}` : ""}`;
  const bits = [];
  let head;
  if (note.converted) {
    head = `${sub.timeFrom}–${sub.timeTo} ${who}`;
    bits.push("was vaste tijd, nu vertrekbereik");
  } else if (note.keptTrain) head = `${sub.time} ${who} blijft een vaste tijd`;
  else if (isRange(sub)) head = `${sub.timeFrom}–${sub.timeTo} ${who}${sub.when === "arrive" ? " aankomst" : ""}`;
  else head = `${sub.time} ${who}`;
  if (note.daysFilled) bits.push("dagen ma–vr aangevuld");
  if (note.idMade) bits.push("id aangevuld");
  if (note.normalizedTime) bits.push("tijd genormaliseerd");
  return bits.length ? `${head} (${bits.join("; ")})` : head;
}

export function formatReport(report) {
  const lines = ["NS-alerts migratie", `Datamap: ${report.dataDir}`];
  if (report.dryRun) lines.push("Modus: proefdraai. Er wordt niets geschreven.");
  else lines.push("Modus: uitvoeren.");
  if (report.toRange) lines.push(`Vaste tijden naar vertrekbereik: ±${report.margin} minuten.`);
  else lines.push("Vaste tijden blijven een vaste tijd.");
  if (report.aborted && !report.subscriptions) {
    lines.push(`Afgebroken: ${report.error}`);
    lines.push("Er is niets gewijzigd.");
    return lines.join("\n");
  }
  lines.push("", "Abonnementen:");
  if (!report.subscriptions?.length) lines.push("- geen");
  report.subscriptions?.forEach((sub, i) => {
    lines.push(`- ${subLine(sub, report.notes?.[i] || {})}`);
  });
  lines.push("", "Configuratie:");
  lines.push(report.configAdded?.length ? `- toegevoegd: ${report.configAdded.join(", ")}` : "- niets toegevoegd");
  lines.push(report.configKept?.length ? `- ongewijzigd gelaten: ${report.configKept.join(", ")}` : "- geen bestaande standaardwaarden");
  if (report.configExtra?.length) lines.push(`- bewaard: ${report.configExtra.join(", ")}`);
  if (report.state) {
    lines.push("", "Status:");
    lines.push(`- ${report.stateKept.length} bewaard`);
    lines.push(`- ${report.stateDropped.length} verwijderd`);
    for (const item of report.stateDropped.slice(0, 20)) lines.push(`  - ${item.key}: ${item.why}`);
    if (report.stateDropped.length > 20) lines.push(`  - en nog ${report.stateDropped.length - 20}`);
  } else lines.push("", "Status: geen state.json");
  if (report.database) {
    lines.push("", "Database:");
    lines.push(`- ${report.database.users} gebruiker(s), ${report.database.changedSubs} abonnement(en) bijgewerkt, ${report.database.dropped} statusregels verwijderd`);
  }
  if (report.backup) lines.push("", `Backup: ${report.backup}`);
  if (report.aborted) lines.push("", `Afgebroken: ${report.error}`, "Er is niets gewijzigd.");
  else if (report.dryRun) lines.push("", "Er is niets geschreven.");
  else if (report.restored) lines.push("", `Controle mislukt: ${report.error}`, "Backup teruggezet.");
  else if (report.error) lines.push("", `Mislukt: ${report.error}`);
  else if (!report.changed) lines.push("", "Niets te wijzigen.");
  else lines.push("", "Controle gelukt.");
  return lines.join("\n");
}

function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return { missing: true, value: fallback };
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (e) {
    return { error: `${path.basename(file)} is geen geldige json (${e instanceof Error ? e.message : e})` };
  }
}

function writeJson(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function stamp(date) {
  const d = date || new Date();
  const p = (n, len = 2) => String(n).padStart(len, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds(), 3)}`;
}

function listDataNames(dataDir) {
  return fs.readdirSync(dataDir).filter((name) => name !== "backups");
}

function copyBackup(dataDir, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  for (const name of listDataNames(dataDir)) {
    fs.cpSync(path.join(dataDir, name), path.join(backupDir, name), { recursive: true });
  }
}

function restoreBackup(dataDir, backupDir, names) {
  for (const name of fs.readdirSync(dataDir)) {
    if (name === "backups") continue;
    if (!names.includes(name)) fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
  }
  for (const name of names) {
    const dest = path.join(dataDir, name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(path.join(backupDir, name), dest, { recursive: true });
  }
}

async function loadBetterSqlite() {
  const mod = await import("better-sqlite3");
  return mod.default;
}

async function readSqliteAsync(file) {
  if (!fs.existsSync(file)) return null;
  let Database;
  try { Database = await loadBetterSqlite(); }
  catch { return { error: "better-sqlite3 ontbreekt, database niet gelezen" }; }
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const hasSubs = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subscriptions'").get();
    if (!hasSubs) return { users: [], rows: [], states: [], cols: [] };
    const cols = db.prepare("PRAGMA table_info(subscriptions)").all().map((c) => c.name);
    const users = db.prepare("SELECT id, username FROM users").all();
    const rows = db.prepare("SELECT * FROM subscriptions").all();
    const hasState = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trip_state'").get();
    const states = hasState ? db.prepare("SELECT user_id, key, json FROM trip_state").all() : [];
    return { users, rows, states, cols };
  } finally {
    db.close();
  }
}

function rowToSub(row, cols) {
  const has = (name) => cols.includes(name);
  const sub = {
    id: row.id,
    from: row.from_code,
    to: row.to_code || "",
    time: row.time,
  };
  if (row.from_name) sub.fromName = row.from_name;
  if (row.to_name) sub.toName = row.to_name;
  if (row.label) sub.label = row.label;
  if (row.train) sub.train = row.train;
  if (has("time_from") && row.time_from && has("time_to") && row.time_to) {
    sub.timeFrom = row.time_from;
    sub.timeTo = row.time_to;
    sub.when = row.when_mode === "arrive" ? "arrive" : "depart";
  }
  if (row.date) sub.date = row.date;
  else {
    try { sub.days = JSON.parse(row.days || "[]"); }
    catch { sub.days = []; }
  }
  return sub;
}

function planSqlite(snapshot, opts) {
  if (!snapshot) return { users: [], changedSubs: 0, dropped: 0, plans: [] };
  if (snapshot.error) return { error: snapshot.error };
  const plans = [];
  let changedSubs = 0;
  let dropped = 0;
  for (const user of snapshot.users) {
    const rows = snapshot.rows.filter((r) => r.user_id === user.id);
    const current = rows.map((r) => rowToSub(r, snapshot.cols));
    const planned = normalizeSubs(current, opts);
    if (planned.error) return { error: `database ${user.username || user.id}: ${planned.error}` };
    const stateObj = {};
    for (const row of snapshot.states.filter((s) => s.user_id === user.id)) {
      try { stateObj[row.key] = JSON.parse(row.json); }
      catch { return { error: `database-status van ${user.username || user.id} is geen json` }; }
    }
    const pruned = pruneState(stateObj, planned.subs);
    if (pruned.error) return { error: pruned.error };
    const changedIdx = planned.subs.filter((sub, i) => differentSub(sub, current[i]));
    const stateChanged = !stateEqual(pruned.state, stateObj);
    changedSubs += changedIdx.length;
    dropped += pruned.dropped.length;
    plans.push({
      userId: user.id,
      subs: planned.subs,
      state: pruned.state,
      subsChanged: changedIdx.length > 0,
      stateChanged,
    });
  }
  return { users: snapshot.users.length, changedSubs, dropped, plans };
}

async function writeSqlite(file, plans) {
  const { openDb } = await import("../db.js");
  const store = openDb(file);
  try {
    for (const plan of plans) {
      if (!plan.subsChanged && !plan.stateChanged) continue;
      if (plan.subsChanged) {
        for (const sub of plan.subs) store.updateSub(plan.userId, sub);
      }
      if (plan.stateChanged) store.writeState(plan.userId, plan.state);
    }
  } finally {
    store.close();
  }
}

function differentSub(next, prev) {
  const keys = ["id", "from", "to", "time", "timeFrom", "timeTo", "when", "train", "date", "label", "fromName", "toName"];
  if (keys.some((key) => (next[key] || "") !== (prev[key] || ""))) return true;
  return JSON.stringify(next.days || null) !== JSON.stringify(prev.days || null);
}

function stateEqual(a, b) {
  const left = Object.keys(a || {}).sort();
  const right = Object.keys(b || {}).sort();
  if (left.join("\n") !== right.join("\n")) return false;
  return left.every((key) => jsonEqual(a[key], b[key]));
}

function samePlan(a, b) {
  return jsonEqual(a.subscriptions, b.subscriptions)
    && jsonEqual(a.config, b.config)
    && jsonEqual(a.state, b.state);
}

export function parseArgs(argv, env = process.env) {
  const out = { dryRun: false, toRange: false, margin: 15, dataDir: env.DATA_DIR || "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--to-range") out.toRange = true;
    else if (arg.startsWith("--to-range=")) {
      out.toRange = true;
      out.marginText = arg.slice("--to-range=".length);
    } else if (arg === "--data-dir") {
      out.dataDir = argv[++i] || "";
      if (!out.dataDir) return { error: "--data-dir verwacht een pad" };
    } else if (arg.startsWith("--data-dir=")) out.dataDir = arg.slice("--data-dir=".length);
    else return { error: `onbekend argument ${arg}` };
  }
  if (out.toRange) {
    const raw = out.marginText == null ? "15" : out.marginText;
    if (!/^\d+$/.test(raw)) return { error: "marge moet een geheel getal van 0 tot 180 zijn" };
    const n = Number(raw);
    if (n > 180) return { error: "marge moet een geheel getal van 0 tot 180 zijn" };
    out.margin = n;
  }
  return out;
}

export function helpText() {
  return [
    "Gebruik: npm run migrate -- [--dry-run] [--to-range[=MINUTEN]] [--data-dir PAD]",
    "  --dry-run          toon wat er zou veranderen, schrijf niets",
    "  --to-range[=15]    maak van een vaste tijd een vertrekbereik ± minuten (0–180)",
    "  --data-dir PAD     map met subscriptions.json, config.json en state.json",
  ].join("\n");
}

export async function runMigration(opts) {
  const dataDir = path.resolve(opts.dataDir || "data");
  if (opts.toRange && (!Number.isInteger(opts.margin) || opts.margin < 0 || opts.margin > 180)) {
    const error = "marge moet een geheel getal van 0 tot 180 zijn";
    const baseBad = { dataDir, dryRun: Boolean(opts.dryRun), toRange: true, margin: opts.margin };
    return { ...baseBad, ok: false, aborted: true, error, text: formatReport({ ...baseBad, aborted: true, error }) };
  }
  const base = {
    dataDir,
    dryRun: Boolean(opts.dryRun),
    toRange: Boolean(opts.toRange),
    margin: opts.margin ?? 15,
  };
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    return { ...base, ok: false, aborted: true, error: `datamap bestaat niet: ${dataDir}`, text: formatReport({ ...base, aborted: true, error: `datamap bestaat niet: ${dataDir}` }) };
  }
  const subsFile = path.join(dataDir, "subscriptions.json");
  const cfgFile = path.join(dataDir, "config.json");
  const stateFile = path.join(dataDir, "state.json");
  const dbFile = path.join(dataDir, "app.sqlite");
  const subsRead = readJsonFile(subsFile, []);
  const cfgRead = readJsonFile(cfgFile, {});
  const stateRead = readJsonFile(stateFile, null);
  const readError = subsRead.error || cfgRead.error || stateRead.error;
  if (readError) {
    return { ...base, ok: false, aborted: true, error: readError, text: formatReport({ ...base, aborted: true, error: readError }) };
  }
  let sqlite = null;
  try { sqlite = await readSqliteAsync(dbFile); }
  catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ...base, ok: false, aborted: true, error, text: formatReport({ ...base, aborted: true, error }) };
  }
  if (sqlite?.error) return { ...base, ok: false, aborted: true, error: sqlite.error, text: formatReport({ ...base, aborted: true, error: sqlite.error }) };

  const empty = subsRead.missing && cfgRead.missing && stateRead.missing && !sqlite;
  if (empty) {
    const text = `${formatReport({ ...base, subscriptions: [], notes: [], configAdded: [], configKept: [], state: null })}\nNiets te migreren.`;
    return { ...base, ok: true, changed: false, text };
  }

  const planned = planMigration({
    subscriptions: subsRead.missing ? [] : subsRead.value,
    config: cfgRead.missing ? {} : cfgRead.value,
    state: stateRead.missing ? null : stateRead.value,
    toRange: base.toRange,
    margin: base.margin,
  });
  if (planned.error) {
    return { ...base, ok: false, aborted: true, error: planned.error, text: formatReport({ ...base, aborted: true, error: planned.error }) };
  }
  const dbPlan = planSqlite(sqlite, { toRange: base.toRange, margin: base.margin });
  if (dbPlan.error) {
    return { ...base, ok: false, aborted: true, error: dbPlan.error, text: formatReport({ ...base, ...planned, aborted: true, error: dbPlan.error }) };
  }

  const subsChanged = !subsRead.missing && !jsonEqual(subsRead.value, planned.subscriptions);
  const cfgChanged = cfgRead.missing || !jsonEqual(cfgRead.value, planned.config);
  const stateChanged = !stateRead.missing && !jsonEqual(stateRead.value, planned.state);
  const dbChanged = dbPlan.changedSubs > 0 || dbPlan.dropped > 0 || dbPlan.plans.some((p) => p.subsChanged || p.stateChanged);
  const changed = subsChanged || cfgChanged || stateChanged || dbChanged;
  const report = {
    ...base,
    ...planned,
    database: sqlite ? dbPlan : null,
    changed,
  };
  if (!changed || opts.dryRun) {
    report.ok = true;
    report.text = formatReport(report);
    return report;
  }

  const names = listDataNames(dataDir);
  const backup = path.join(dataDir, "backups", stamp(opts.now));
  try {
    copyBackup(dataDir, backup);
    if (!subsRead.missing) writeJson(subsFile, planned.subscriptions);
    writeJson(cfgFile, planned.config);
    if (!stateRead.missing) writeJson(stateFile, planned.state);
    if (dbChanged) await writeSqlite(dbFile, dbPlan.plans);
    if (dbChanged) {
      const reread = await readSqliteAsync(dbFile);
      const againDb = planSqlite(reread, { toRange: base.toRange, margin: base.margin });
      if (againDb.error || againDb.plans.some((p) => p.subsChanged || p.stateChanged)) throw new Error(againDb.error || "database-migratie is niet idempotent");
    }
    const check = opts.validate ? opts.validate({ dataDir, planned, dbPlan }) : validateWritten({ dataDir, subsFile, cfgFile, stateFile, subsRead, stateRead, planned, toRange: base.toRange, margin: base.margin });
    if (!check.ok) throw new Error(check.error || "controle mislukt");
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    try { restoreBackup(dataDir, backup, names); }
    catch (restoreErr) {
      const both = `${error}; terugzetten mislukt (${restoreErr instanceof Error ? restoreErr.message : restoreErr}). Backup blijft in ${backup}`;
      return { ...report, ok: false, restored: false, backup, error: both, text: formatReport({ ...report, backup, restored: false, error: both }) };
    }
    return { ...report, ok: false, restored: true, backup, error, text: formatReport({ ...report, backup, restored: true, error }) };
  }
  report.ok = true;
  report.backup = backup;
  report.text = formatReport(report);
  return report;
}

function validateWritten({ dataDir, subsFile, cfgFile, stateFile, subsRead, stateRead, planned, toRange, margin }) {
  const againSubs = readJsonFile(subsFile, []);
  const againCfg = readJsonFile(cfgFile, {});
  const againState = readJsonFile(stateFile, null);
  const error = againSubs.error || againCfg.error || againState.error;
  if (error) return { ok: false, error };
  if (!jsonEqual(againSubs.value, planned.subscriptions)) return { ok: false, error: "subscriptions.json wijkt af na het schrijven" };
  if (!jsonEqual(againCfg.value, planned.config)) return { ok: false, error: "config.json wijkt af na het schrijven" };
  if (!stateRead.missing && !jsonEqual(againState.value, planned.state)) return { ok: false, error: "state.json wijkt af na het schrijven" };
  for (const key of Object.keys(CONFIG_DEFAULTS)) {
    if (againCfg.value[key] == null) return { ok: false, error: `configuratie mist ${key}` };
  }
  const second = planMigration({
    subscriptions: againSubs.value,
    config: againCfg.value,
    state: stateRead.missing ? null : againState.value,
    toRange,
    margin,
  });
  if (second.error) return { ok: false, error: second.error };
  if (!samePlan(planned, second)) return { ok: false, error: "migratie is niet idempotent" };
  if (!fs.existsSync(dataDir)) return { ok: false, error: "datamap verdwenen" };
  if (!subsRead.missing && !fs.existsSync(subsFile)) return { ok: false, error: "subscriptions.json verdwenen" };
  return { ok: true };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.log(args.error);
    console.log(helpText());
    return 1;
  }
  if (args.help) {
    console.log(helpText());
    return 0;
  }
  const result = await runMigration({
    dataDir: args.dataDir || path.resolve("data"),
    dryRun: args.dryRun,
    toRange: args.toRange,
    margin: args.margin,
  });
  console.log(result.text);
  return result.ok ? 0 : 1;
}

const self = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (self) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
