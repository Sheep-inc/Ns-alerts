/** Pure change-detection (no I/O). Port of the Python logic, including notes and partCancelled. */

function parseNaive(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(String(s));
  if (!m) throw new Error(`bad datetime ${s}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/** Python 3 round: half away from the odd neighbor (banker's rounding). */
function pyRound(n) {
  const sign = n < 0 ? -1 : 1;
  const x = Math.abs(n);
  const f = Math.floor(x);
  const diff = x - f;
  let r;
  if (diff > 0.5) r = f + 1;
  else if (diff < 0.5) r = f;
  else r = f % 2 === 0 ? f : f + 1;
  return sign * r;
}

function delayMin(planned, actual) {
  const p = parseNaive(planned);
  const a = parseNaive(actual);
  if (p == null || a == null) return 0;
  return Math.max(0, pyRound((a - p) / 60000));
}

function* flat(x) {
  if (!Array.isArray(x)) return;
  for (const i of x) {
    if (Array.isArray(i)) yield* flat(i);
    else yield i;
  }
}

function uniqMessages(msgs) {
  return [...new Set(msgs.filter((m) => m))].sort();
}

export function stateFromTrip(trip) {
  const all = trip.legs || [];
  let legs = all.filter((l) => (l.travelType ?? "PUBLIC_TRANSIT") !== "WALK");
  if (!legs.length) legs = all;
  const first = legs[0];
  const o = first.origin || {};
  const cancelled = trip.status === "CANCELLED" || legs.some((l) => l.cancelled);
  const alt = trip.status === "ALTERNATIVE_TRANSPORT" || legs.some((l) => l.alternativeTransport);
  const msgs = [];
  for (const m of trip.messages || []) msgs.push(m.text || m.message);
  for (const l of legs) {
    for (const m of l.messages || []) msgs.push(m.text || m.message);
    for (const group of [l.notes, l.origin?.notes, l.product?.notes]) {
      for (const n of flat(group)) {
        if (n && typeof n === "object" && n.noteType != null && n.noteType !== "ATTRIBUTE") msgs.push(n.value);
      }
    }
  }
  const stations = [];
  for (const l of legs) {
    const a = l.origin?.stationCode;
    const b = l.destination?.stationCode;
    if (a) stations.push(a);
    if (b) stations.push(b);
  }
  return {
    planned: o.plannedDateTime ?? null,
    delay: delayMin(o.plannedDateTime, o.actualDateTime),
    plannedTrack: o.plannedTrack ?? null,
    track: o.actualTrack || o.plannedTrack || null,
    cancelled: Boolean(cancelled),
    alternative: Boolean(alt),
    partCancelled: legs.some((l) => l.partCancelled) && !cancelled,
    changeNotPossible: trip.status === "CHANGE_NOT_POSSIBLE" || legs.slice(0, -1).some((l) => l.changePossible === false),
    trainNumber: first.product?.number ?? null,
    stations,
    messages: uniqMessages(msgs),
  };
}

export function stateFromDeparture(dep) {
  return {
    planned: dep.plannedDateTime ?? null,
    delay: delayMin(dep.plannedDateTime, dep.actualDateTime),
    plannedTrack: dep.plannedTrack ?? null,
    track: dep.actualTrack || dep.plannedTrack || null,
    cancelled: Boolean(dep.cancelled) || dep.departureStatus === "CANCELLED",
    alternative: false,
    changeNotPossible: false,
    trainNumber: dep.product?.number || dep.name || null,
    stations: [],
    messages: uniqMessages((dep.messages || []).map((m) => m.message)),
  };
}

export function pickTrip(trips, hhmm) {
  for (const t of trips || []) {
    const legs = t.legs || [];
    const planned = legs[0]?.origin?.plannedDateTime || "";
    if (legs.length && planned.slice(11, 16) === hhmm) return t;
  }
  return null;
}

export function relevantDisruptions(disruptions, stationCodes) {
  const codes = new Set([...stationCodes].filter(Boolean).map((c) => String(c).toUpperCase()));
  const out = [];
  for (const d of disruptions || []) {
    if (d.isActive === false) continue;
    const found = new Set();
    for (const ps of d.publicationSections || []) {
      for (const s of ps.section?.stations || []) found.add(String(s.stationCode || "").toUpperCase());
    }
    let hit = false;
    for (const c of found) if (c && codes.has(c)) hit = true;
    if (hit) out.push({ id: d.id ?? null, title: d.title ?? null, type: d.type ?? null });
  }
  return out;
}

export function diff(prev, cur, threshold = 3, grow = 5) {
  const p = prev || {
    delay: 0,
    cancelled: false,
    track: cur.plannedTrack,
    alternative: false,
    changeNotPossible: false,
    disruptions: [],
  };
  const ev = [];
  if (cur.cancelled && !p.cancelled) return [["high", "❌ RIJDT NIET (geannuleerd)"]];
  if (p.cancelled && !cur.cancelled) ev.push(["default", "✅ rijdt toch weer"]);
  if (cur.cancelled) return ev;
  const d = cur.delay;
  const pd = p.delay ?? 0;
  if (d >= threshold && pd < threshold) ev.push(["high", `⚠️ +${d} min vertraging`]);
  else if (d >= threshold && Math.abs(d - pd) >= grow) ev.push([d > pd ? "high" : "default", `⚠️ vertraging nu +${d} min (was +${pd})`]);
  else if (d < threshold && pd >= threshold) ev.push(["default", d === 0 ? "✅ weer op tijd" : `✅ vertraging opgelost (+${d} min)`]);
  if (cur.track && p.track && cur.track !== p.track) ev.push(["high", `🔀 spoorwijziging: nu spoor ${cur.track} (was ${p.track})`]);
  else if (prev == null && cur.track && cur.plannedTrack && cur.track !== cur.plannedTrack) ev.push(["high", `🔀 spoorwijziging: nu spoor ${cur.track} (gepland ${cur.plannedTrack})`]);
  if (cur.alternative && !p.alternative) ev.push(["high", "🚌 vervangend vervoer"]);
  if (cur.partCancelled && !p.partCancelled) ev.push(["high", "⚠️ rijdt deels niet (deel van de rit vervalt)"]);
  if (cur.changeNotPossible && !p.changeNotPossible) ev.push(["high", "⛔ overstap niet mogelijk"]);
  const old = new Set((p.disruptions || []).map((x) => x.id));
  for (const x of cur.disruptions || []) {
    if (!old.has(x.id)) ev.push(["default", `🚧 storing: ${x.title}`]);
  }
  return ev;
}

function stripChars(s, chars) {
  const set = new Set(chars);
  let a = 0;
  let b = s.length;
  while (a < b && set.has(s[a])) a++;
  while (a < b && set.has(s[b - 1])) b--;
  return s.slice(a, b);
}

export function formatMsg(sub, cur, events) {
  const t = (cur.planned || "").slice(11, 16) || sub.time || "";
  let route = stripChars(`${sub.fromName || sub.from} → ${sub.toName || sub.to || ""}`, " →");
  if (sub.train) route += ` (trein ${sub.train})`;
  const parts = events.map((e) => e[1]);
  if (cur.track && !cur.cancelled && !parts.some((x) => x.includes("spoor"))) parts.push(`spoor ${cur.track}`);
  let prio = events.some((e) => e[0] === "high") ? "high" : "default";
  if (parts.some((x) => x.includes("geannuleerd"))) prio = "urgent";
  return [`${t} ${route}`, parts.join(", "), prio];
}
