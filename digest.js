/**
 * Dagelijkse storingscheck (geen I/O). Tijden zijn Europe/Amsterdam,
 * onafhankelijk van de tijdzone van het proces.
 */

const TZ = "Europe/Amsterdam";
const DAYS = ["ma", "di", "wo", "do", "vr", "za", "zo"];
const WEEKDAY = { Mon: "ma", Tue: "di", Wed: "wo", Thu: "do", Fri: "vr", Sat: "za", Sun: "zo" };
const MANY_STATIONS = 12;
const GRACE_MIN = 15;

function pad(n) { return String(n).padStart(2, "0"); }

export function amsterdamParts(date) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== "literal") parts[p.type] = p.value;
  const weekday = WEEKDAY[String(parts.weekday || "").replace(/\./g, "")] || "";
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${pad(parts.hour)}:${pad(parts.minute)}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function zonedToUtc(y, mo, d, h, mi, s) {
  let utc = Date.UTC(y, mo - 1, d, h, mi, s);
  const want = utc;
  for (let i = 0; i < 4; i++) {
    const p = amsterdamParts(new Date(utc));
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = want - got;
    if (diff === 0) return new Date(utc);
    utc += diff;
  }
  return new Date(utc);
}

export function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function dayBounds(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const start = zonedToUtc(y, m, d, 0, 0, 0).getTime();
  const end = zonedToUtc(...addDays(ymd, 1).split("-").map(Number), 0, 0, 0).getTime();
  return [start, end];
}

function takeDigits(str, i, n) {
  const slice = str.slice(i, i + n);
  if (slice.length !== n || !/^\d+$/.test(slice)) return null;
  return Number(slice);
}

function parseInstant(s) {
  if (s == null || s === "") return null;
  const str = String(s).trim();
  if (str.length < 16 || str[4] !== "-" || str[7] !== "-" || str[10] !== "T" || str[13] !== ":") return null;
  const y = takeDigits(str, 0, 4);
  const mo = takeDigits(str, 5, 2);
  const d = takeDigits(str, 8, 2);
  const h = takeDigits(str, 11, 2);
  const mi = takeDigits(str, 14, 2);
  if ([y, mo, d, h, mi].some((n) => n == null)) return null;
  let i = 16;
  let sec = 0;
  if (str[i] === ":") {
    const got = takeDigits(str, i + 1, 2);
    if (got == null) return null;
    sec = got;
    i += 3;
  }
  if (str[i] === ".") {
    i += 1;
    const frac = i;
    while (i < str.length && str[i] >= "0" && str[i] <= "9") i += 1;
    if (i === frac) return null;
  }
  if (i >= str.length) return zonedToUtc(y, mo, d, h, mi, sec).getTime();
  const rest = str.slice(i);
  let ms = Date.UTC(y, mo - 1, d, h, mi, sec);
  if (rest === "Z") return ms;
  if (!/^[+-]\d{2}:?\d{2}$/.test(rest)) return null;
  const sign = rest[0] === "-" ? -1 : 1;
  const hh = Number(rest.slice(1, 3));
  const mm = Number(rest.slice(rest.length - 2));
  ms -= sign * (hh * 60 + mm) * 60000;
  return ms;
}

function periods(item) {
  const spans = Array.isArray(item.timespans) ? item.timespans : [];
  if (spans.length) return spans.map((ts) => [parseInstant(ts?.start), parseInstant(ts?.end)]);
  if (item.start || item.end) return [[parseInstant(item.start), parseInstant(item.end)]];
  return [];
}

export function overlapsDay(item, ymd) {
  const [dayStart, dayEnd] = dayBounds(ymd);
  const spans = periods(item);
  if (!spans.length) return item.isActive !== false;
  return spans.some(([start, end]) => {
    const s = start == null ? -Infinity : start;
    const e = end == null ? Infinity : end;
    return s < dayEnd && e > dayStart;
  });
}

/** "6:00, 21:00" / array → ["06:00","21:00"]. Ongeldig of leeg → null. */
export function parseDigestTimes(raw) {
  if (raw == null) return null;
  const parts = Array.isArray(raw) ? raw : String(raw).split(/[,;\s]+/);
  const out = [];
  for (const p of parts) {
    const s = String(p).trim();
    if (!s) continue;
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    const norm = `${pad(h)}:${m[2]}`;
    if (!out.includes(norm)) out.push(norm);
  }
  return out.length ? out : null;
}

export function dueSlots(now, times, doneSlots, graceMin = GRACE_MIN) {
  const p = amsterdamParts(now);
  const nowMin = p.hour * 60 + p.minute;
  const done = new Set(doneSlots || []);
  const due = [];
  for (const t of times || []) {
    const norm = parseDigestTimes(t);
    if (!norm) continue;
    const [h, m] = norm[0].split(":").map(Number);
    const slotMin = h * 60 + m;
    const key = `${p.ymd} ${norm[0]}`;
    if (done.has(key)) continue;
    if (nowMin >= slotMin && nowMin < slotMin + graceMin) due.push({ key, time: norm[0], ymd: p.ymd });
  }
  return due;
}

export function digestTarget(now, hhmm) {
  const p = amsterdamParts(now);
  const hour = Number(String(hhmm).slice(0, 2));
  const ymd = hour >= 12 ? addDays(p.ymd, 1) : p.ymd;
  const noon = zonedToUtc(...ymd.split("-").map(Number), 12, 0, 0);
  return { ymd, weekday: amsterdamParts(noon).weekday, label: hour >= 12 ? "morgen" : "vandaag" };
}

export function digestTargetFromNow(now) {
  const p = amsterdamParts(now);
  return digestTarget(now, p.hhmm);
}

function activeOnDay(sub, ymd, weekday) {
  if (sub?.date) return sub.date === ymd;
  const days = Array.isArray(sub?.days) && sub.days.length ? sub.days : DAYS;
  return days.includes(weekday);
}

export function stationsForDay(subs, ymd, weekday) {
  const set = new Set();
  for (const sub of subs || []) {
    if (!activeOnDay(sub, ymd, weekday)) continue;
    if (sub.from) set.add(String(sub.from).toUpperCase());
    if (sub.to) set.add(String(sub.to).toUpperCase());
  }
  return set;
}

function stationCodes(item) {
  const set = new Set();
  for (const pub of item.publicationSections || []) {
    for (const s of pub?.section?.stations || []) if (s?.stationCode) set.add(String(s.stationCode).toUpperCase());
    for (const s of pub?.consequence?.section?.stations || []) if (s?.stationCode) set.add(String(s.stationCode).toUpperCase());
  }
  return set;
}

function blob(item) {
  const bits = [item.title, item.expectedDuration?.description];
  for (const ts of item.timespans || []) bits.push(ts?.situation?.label, ts?.cause?.label);
  for (const pub of item.publicationSections || []) bits.push(pub?.consequence?.description);
  return bits.filter(Boolean).join("\n");
}

function isStrike(item) { return /staking|strike/i.test(blob(item)); }

function isCalamity(item) { return String(item.type || "").toUpperCase() === "CALAMITY"; }

function impactHigh(item) {
  const imp = item.impact;
  if (imp == null) return false;
  if (typeof imp === "number") return imp >= 3;
  if (typeof imp === "string") return /high/i.test(imp) || Number(imp) >= 3;
  if (typeof imp.value === "number" && imp.value >= 3) return true;
  if (typeof imp.value === "string" && (/high/i.test(imp.value) || Number(imp.value) >= 3)) return true;
  if (typeof imp.level === "string" && /high/i.test(imp.level)) return true;
  return false;
}

function isLarge(item) {
  return isCalamity(item) || isStrike(item) || impactHigh(item) || stationCodes(item).size >= MANY_STATIONS;
}

function isRouteType(item) {
  const t = String(item.type || "DISRUPTION").toUpperCase();
  return t === "DISRUPTION" || t === "MAINTENANCE";
}

function kind(item) {
  if (isStrike(item)) return "Staking";
  if (isCalamity(item)) return "Calamiteit";
  if (String(item.type || "").toUpperCase() === "MAINTENANCE") return "Werkzaamheden";
  return "Storing";
}

function signature(item) {
  const cause = (item.timespans || []).map((t) => t?.cause?.label || "").join("|");
  const situation = (item.timespans || []).map((t) => t?.situation?.label || "").join("|");
  return JSON.stringify({
    id: item.id ?? null,
    type: item.type || "",
    title: item.title || "",
    start: item.start || "",
    end: item.end || "",
    cause,
    situation,
    impact: item.impact && typeof item.impact === "object" ? (item.impact.value ?? item.impact.level ?? null) : (item.impact ?? null),
    stations: [...stationCodes(item)].sort(),
  });
}

function line(item) { return `• ${kind(item)}: ${item.title || "storing"}`; }

function isSevere(rows) {
  return rows.some((r) => isCalamity(r.item) || isStrike(r.item));
}

function digestSections(rows) {
  const large = rows.filter((r) => r.bucket === "large").slice(0, 6);
  const route = rows.filter((r) => r.bucket === "route").slice(0, 8);
  const lines = [];
  if (large.length) {
    lines.push("Landelijk");
    for (const r of large) lines.push(line(r.item));
  }
  if (route.length) {
    if (lines.length) lines.push("");
    lines.push("Jouw traject");
    for (const r of route) lines.push(line(r.item));
  }
  return lines;
}

export function buildDigest({ disruptions, subs, ymd, weekday, label, previous, quiet }) {
  const stations = stationsForDay(subs, ymd, weekday);
  const relevant = [];
  for (const item of disruptions || []) {
    if (!item || typeof item !== "object" || !overlapsDay(item, ymd)) continue;
    const codes = stationCodes(item);
    const hits = [...codes].some((c) => stations.has(c));
    if (isLarge(item)) relevant.push({ item, bucket: "large" });
    else if (isRouteType(item) && hits) relevant.push({ item, bucket: "route" });
  }
  const prev = previous?.events || {};
  const nextEvents = {};
  const fresh = [];
  for (const row of relevant) {
    const sig = signature(row.item);
    const id = row.item.id != null && row.item.id !== "" ? String(row.item.id) : sig;
    nextEvents[id] = sig;
    if (prev[id] !== sig) fresh.push(row);
  }
  const next = { events: nextEvents };
  if (!relevant.length) {
    if (!quiet) return { sent: false, quiet: false, title: "", body: "", priority: "default", next, count: 0, reason: "niets" };
    return {
      sent: true,
      quiet: true,
      title: "Dagelijkse check",
      body: "Alles rustig — geen relevante storingen of werkzaamheden.",
      priority: "default",
      next,
      count: 0,
    };
  }
  if (!fresh.length) {
    const severe = isSevere(relevant);
    return {
      sent: true,
      quiet: false,
      title: `${severe ? "⚠️" : "ℹ️"} Niets nieuws — storingen ${label}`,
      body: ["Er is niets nieuws — nog steeds:", "", ...digestSections(relevant)].join("\n"),
      priority: severe ? "high" : "default",
      next,
      count: relevant.length,
      reason: "herinnering",
    };
  }
  const severe = isSevere(fresh);
  return {
    sent: true,
    quiet: false,
    title: `${severe ? "⚠️" : "🚧"} Storingen ${label}`,
    body: digestSections(fresh).join("\n"),
    priority: severe ? "high" : "default",
    next,
    count: fresh.length,
  };
}

export function markSlot(slots, now, slotTime) {
  const p = amsterdamParts(now);
  const cutoff = addDays(p.ymd, -2);
  const kept = (slots || []).filter((s) => String(s).slice(0, 10) >= cutoff);
  const norm = slotTime ? parseDigestTimes(slotTime) : null;
  if (norm) {
    const key = `${p.ymd} ${norm[0]}`;
    if (!kept.includes(key)) kept.push(key);
  }
  return kept;
}
