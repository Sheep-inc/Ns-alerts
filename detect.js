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

function hhmm(iso) {
  const m = /T(\d{2}:\d{2})/.exec(String(iso || ""));
  return m ? m[1] : "";
}

function pad2(n) { return String(n).padStart(2, "0"); }

function addMinutes(time, mins) {
  if (!/^\d{2}:\d{2}$/.test(time || "")) return "";
  const [h, m] = time.split(":").map(Number);
  const total = ((h * 60 + m + mins) % 1440 + 1440) % 1440;
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

function minutesBetween(a, b) {
  if (!/^\d{2}:\d{2}$/.test(a || "") || !/^\d{2}:\d{2}$/.test(b || "")) return null;
  const [ah, am] = a.split(":").map(Number);
  const [bh, bm] = b.split(":").map(Number);
  return bh * 60 + bm - (ah * 60 + am);
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim();
}

function place(point) {
  if (!point) return "";
  return point.name || point.stationCode || "";
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
  const dest = legs[legs.length - 1]?.destination || {};
  const part = legs.find((l) => l.partCancelled);
  return {
    planned: o.plannedDateTime ?? null,
    arrival: dest.actualDateTime || dest.plannedDateTime || null,
    delay: delayMin(o.plannedDateTime, o.actualDateTime),
    departurePlanned: hhmm(o.plannedDateTime),
    departureActual: hhmm(o.actualDateTime || o.plannedDateTime),
    arrivalPlanned: hhmm(dest.plannedDateTime),
    arrivalActual: hhmm(dest.actualDateTime || dest.plannedDateTime),
    arrivalDelay: delayMin(dest.plannedDateTime, dest.actualDateTime || dest.plannedDateTime),
    plannedTrack: o.plannedTrack ?? null,
    track: o.actualTrack || o.plannedTrack || null,
    cancelled: Boolean(cancelled),
    alternative: Boolean(alt),
    partCancelled: Boolean(part) && !cancelled,
    partFrom: part ? place(part.origin) : "",
    partTo: part ? place(part.destination) : "",
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
    departurePlanned: hhmm(dep.plannedDateTime),
    departureActual: hhmm(dep.actualDateTime || dep.plannedDateTime),
    arrivalPlanned: "",
    arrivalActual: "",
    arrivalDelay: 0,
    plannedTrack: dep.plannedTrack ?? null,
    track: dep.actualTrack || dep.plannedTrack || null,
    cancelled: Boolean(dep.cancelled) || dep.departureStatus === "CANCELLED",
    alternative: false,
    partCancelled: false,
    partFrom: "",
    partTo: "",
    changeNotPossible: false,
    trainNumber: dep.product?.number || dep.name || null,
    direction: dep.direction || "",
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

function adviceOf(span) {
  const bits = [];
  for (const a of span?.advices || []) {
    if (typeof a === "string") bits.push(a);
    else if (a && typeof a === "object") bits.push(a.text || a.title || a.description || "");
  }
  return bits.filter(Boolean).join(" ");
}

function shorten(s, max = 140) {
  const t = cleanText(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 40 ? cut.slice(0, sp) : cut).trim()}…`;
}

/** Cause, end and advice from a disruptions-v3 item, without a trailing period on the title. */
export function describeDisruption(d) {
  const spans = Array.isArray(d?.timespans) ? d.timespans : [];
  const span = spans.find((s) => s?.cause || s?.situation || (s?.advices || []).length) || spans[0] || {};
  const cause = cleanText(span.cause?.label || d.cause?.label || "");
  const end = hhmm(d.expectedDuration?.endTime || d.end || span.end);
  const duration = cleanText(d.expectedDuration?.description || "");
  let advice = shorten(adviceOf(span));
  if (!advice) advice = shorten(span.situation?.label || "");
  return {
    id: d.id ?? null,
    title: cleanText(d.title) || "storing",
    type: d.type ?? null,
    cause,
    end,
    duration: end ? "" : duration,
    advice,
  };
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
    if (hit) out.push(describeDisruption(d));
  }
  return out;
}

function shownDeparture(cur) {
  const planned = cur.departurePlanned || hhmm(cur.planned);
  if (!planned) return { planned: "", actual: "" };
  const actual = cur.departureActual || "";
  if (actual && minutesBetween(planned, actual) === (cur.delay || 0)) return { planned, actual };
  return { planned, actual: addMinutes(planned, cur.delay || 0) };
}

function departurePhrase(cur, prevDelay) {
  const { planned, actual } = shownDeparture(cur);
  const was = prevDelay > 0 ? `, was +${prevDelay}` : "";
  if (planned && actual && actual !== planned) return `Vertrek ${planned} → ${actual} (+${cur.delay} min${was})`;
  if (planned) return `Vertrek ${planned} (+${cur.delay} min${was})`;
  return `+${cur.delay} min vertraging${was}`;
}

function trainEffect(cur) {
  if (cur.cancelled) return "Jouw trein: rijdt niet";
  if (cur.alternative) return "Jouw trein: vervangend vervoer";
  if (cur.partCancelled) return "Jouw trein: deels uitgevallen";
  if ((cur.delay || 0) > 0) return `Jouw trein: +${cur.delay} min vertraging`;
  return "Jouw trein: op tijd";
}

function disruptionPhrase(x) {
  const bits = [`Storing: ${x.title || "onbekend traject"}`];
  if (x.cause) bits.push(x.cause);
  if (x.end) bits.push(`tot ${x.end}`);
  else if (x.duration) bits.push(x.duration);
  const lines = [bits.join(", ")];
  if (x.advice) lines.push(`Advies: ${x.advice}`);
  return lines.join("\n");
}

function altLine(list) {
  if (!list?.length) return "";
  const bits = list.slice(0, 2).map((a) => {
    const track = a.track ? ` spoor ${a.track}` : "";
    const delay = a.delay ? ` (+${a.delay} min)` : "";
    return `${a.time}${track}${delay}`;
  });
  return `Alternatief: ${bits.join("; ")}`;
}

/** Later trains on the same route, skipping the watched departure. */
export function alternativeTrains(trips, { after = "", skipNumber = "", limit = 2 } = {}) {
  const rows = [];
  for (const t of trips || []) {
    const legs = (t.legs || []).filter((l) => (l.travelType ?? "PUBLIC_TRANSIT") !== "WALK");
    if (!legs.length) continue;
    const o = legs[0].origin || {};
    const when = hhmm(o.plannedDateTime);
    if (!when || (after && when <= after)) continue;
    const num = legs[0].product?.number ?? "";
    if (skipNumber && String(num) === String(skipNumber)) continue;
    if (t.status === "CANCELLED" || legs.some((l) => l.cancelled)) continue;
    rows.push({
      time: when,
      track: o.actualTrack || o.plannedTrack || "",
      delay: delayMin(o.plannedDateTime, o.actualDateTime || o.plannedDateTime),
      train: num ? String(num) : "",
    });
  }
  rows.sort((a, b) => a.time.localeCompare(b.time));
  return rows.slice(0, limit);
}

/** Later departures from the same station, optionally the same direction. */
export function alternativeDepartures(departures, { after = "", skipNumber = "", direction = "", limit = 2 } = {}) {
  const dir = String(direction || "").trim().toLowerCase();
  const rows = [];
  for (const dep of departures || []) {
    const when = hhmm(dep.plannedDateTime);
    if (!when || (after && when <= after)) continue;
    const num = dep.product?.number || "";
    if (skipNumber && String(num) === String(skipNumber)) continue;
    if (dep.cancelled || dep.departureStatus === "CANCELLED") continue;
    if (dir && String(dep.direction || "").trim().toLowerCase() !== dir) continue;
    rows.push({
      time: when,
      track: dep.actualTrack || dep.plannedTrack || "",
      delay: delayMin(dep.plannedDateTime, dep.actualDateTime || dep.plannedDateTime),
      train: num ? String(num) : "",
    });
  }
  rows.sort((a, b) => a.time.localeCompare(b.time));
  return rows.slice(0, limit);
}

export function plannerUrl(sub, cur = {}) {
  const from = sub?.fromName || sub?.from || "";
  const to = sub?.toName || sub?.to || "";
  const date = String(cur.planned || "").slice(0, 10);
  const time = hhmm(cur.planned) || sub?.time || "";
  if (from && to) {
    const q = new URLSearchParams();
    q.set("vertrek", from);
    q.set("vertrektype", "station");
    q.set("aankomst", to);
    q.set("aankomsttype", "station");
    q.set("type", "vertrek");
    if (date && time) q.set("tijd", `${date}T${time}`);
    return `https://www.ns.nl/reisplanner#/?${q.toString()}`;
  }
  if (sub?.from) return `https://www.ns.nl/reisinfo/vertrektijden?station=${encodeURIComponent(sub.from)}`;
  return "";
}

function freshDisruptions(prev, cur) {
  const seen = new Set((prev?.disruptions || []).map((x) => x.id));
  const out = [];
  for (const x of cur.disruptions || []) {
    if (!seen.has(x.id)) out.push(["default", disruptionPhrase(x)]);
  }
  return out;
}

export function diff(prev, cur, threshold = 3, grow = 5) {
  const p = prev || {
    delay: 0,
    cancelled: false,
    track: cur.plannedTrack,
    alternative: false,
    partCancelled: false,
    changeNotPossible: false,
    disruptions: [],
    arrivalDelay: 0,
  };
  const ev = [];
  if (cur.cancelled && !p.cancelled) {
    const planned = cur.departurePlanned || hhmm(cur.planned) || "onbekend";
    ev.push(["high", `Rijdt niet meer (was gepland ${planned})`]);
  } else if (p.cancelled && !cur.cancelled) {
    ev.push(["default", "Rijdt weer (was geannuleerd)"]);
  }
  if (cur.cancelled) return ev.concat(freshDisruptions(p, cur));

  const d = cur.delay || 0;
  const pd = p.delay ?? 0;
  if (d >= threshold && pd < threshold) ev.push(["high", departurePhrase(cur, pd)]);
  else if (d >= threshold && Math.abs(d - pd) >= grow) ev.push([d > pd ? "high" : "default", departurePhrase(cur, pd)]);
  else if (d < threshold && pd >= threshold) {
    ev.push(["default", d === 0 ? `Weer op tijd (was +${pd} min)` : `Vertraging nu +${d} min (was +${pd})`]);
  }
  if (cur.track && p.track && String(cur.track) !== String(p.track)) ev.push(["high", `Spoor ${p.track} → ${cur.track}`]);
  if (cur.alternative && !p.alternative) ev.push(["high", "Vervangend vervoer"]);
  if (cur.partCancelled && !p.partCancelled) {
    const span = cur.partFrom && cur.partTo ? `: rijdt niet tussen ${cur.partFrom} en ${cur.partTo}` : "";
    ev.push(["high", `Deels uitgevallen${span}`]);
  }
  if (cur.changeNotPossible && !p.changeNotPossible) ev.push(["high", "Overstap niet mogelijk"]);

  const ap = cur.arrivalPlanned || "";
  const aa = cur.arrivalActual || "";
  const ad = cur.arrivalDelay || 0;
  const prevArrival = p.arrivalDelay ?? 0;
  const arrivalNotable = ap && aa && aa !== ap && (
    (ad >= threshold && prevArrival < threshold)
    || (ad >= threshold && Math.abs(ad - prevArrival) >= grow)
    || (ad < threshold && prevArrival >= threshold)
    || (ev.length > 0 && ad !== prevArrival)
  );
  if (arrivalNotable) ev.push([ad > prevArrival && ad >= threshold ? "high" : "default", `Aankomst ${ap} → ${aa}`]);
  return ev.concat(freshDisruptions(p, cur));
}

function stripChars(s, chars) {
  const set = new Set(chars);
  let a = 0;
  let b = s.length;
  while (a < b && set.has(s[a])) a++;
  while (a < b && set.has(s[b - 1])) b--;
  return s.slice(a, b);
}

function hasPlatformLine(lines) {
  return lines.some((line) => /^Spoor /.test(line) || /^vertrekt van spoor /.test(line));
}

function insertAfterMovement(lines, extra) {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^(Vertrek |Weer op tijd|Vertraging )/.test(lines[i])) idx = i;
  }
  if (idx === -1) lines.push(extra);
  else lines.splice(idx + 1, 0, extra);
}

function reasonLine(cur, body) {
  const have = body.toLowerCase();
  const out = [];
  for (const raw of cur.messages || []) {
    const text = cleanText(raw);
    if (!text || have.includes(text.toLowerCase())) continue;
    if (/rijdt niet/i.test(text) && /rijdt niet/i.test(body)) continue;
    out.push(text);
    if (out.length >= 2) break;
  }
  return out.length ? `Reden: ${out.join("; ")}` : "";
}

export function formatMsg(sub, cur, events) {
  const t = (cur.planned || "").slice(11, 16) || sub.time || "";
  let route = stripChars(`${sub.fromName || sub.from} → ${sub.toName || sub.to || ""}`, " →");
  if (sub.train) route += ` (trein ${sub.train})`;
  const lines = events.map((e) => e[1]).filter(Boolean);
  const onlyDisruption = lines.length > 0 && lines.every((line) => line.startsWith("Storing:"));
  if (onlyDisruption) lines.push(trainEffect(cur));
  const moved = lines.some((line) => /^(Vertrek |Weer op tijd|Vertraging )/.test(line));
  if (moved && !cur.cancelled && cur.track && !hasPlatformLine(lines)) insertAfterMovement(lines, `vertrekt van spoor ${cur.track}`);
  const reason = reasonLine(cur, lines.join("\n"));
  if (reason) lines.push(reason);
  if ((cur.alternatives || []).length && (cur.cancelled || (cur.delay || 0) >= 10 || cur.partCancelled)) {
    const alt = altLine(cur.alternatives);
    if (alt) lines.push(alt);
  }
  let prio = events.some((e) => e[0] === "high") ? "high" : "default";
  const body = lines.join("\n");
  if (cur.cancelled || /rijdt niet meer/i.test(body)) prio = "urgent";
  return [`${t} ${route}`, body, prio, plannerUrl(sub, cur)];
}
