import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as detect from "../detect.js";

const dir = dirname(fileURLToPath(import.meta.url));
const F = (n) => JSON.parse(readFileSync(join(dir, "fixtures", n), "utf8"));
const SUB = { from: "UT", fromName: "Utrecht", to: "ASD", toName: "Amsterdam", time: "08:12" };

const trip = detect.pickTrip(F("trips.json").trips, "08:12");
const cur = detect.stateFromTrip(trip);
cur.disruptions = [];

test("parse trip", () => {
  assert.equal(cur.delay, 7);
  assert.equal(cur.track, "18");
  assert.equal(cur.trainNumber, "3014");
  assert.equal(cur.arrival, "2026-10-15T08:39:00+0200");
});

test("first notification format", () => {
  const ev = detect.diff(null, cur);
  const [t, b, p, click] = detect.formatMsg(SUB, cur, ev);
  assert.equal(t, "08:12 Utrecht → Amsterdam");
  assert.match(b, /Vertrek 08:12 → 08:19 \(\+7 min\)/);
  assert.match(b, /Spoor 5 → 18/);
  assert.match(b, /Reden: Later vertrek door een defecte trein/);
  assert.equal(b.includes("spoor 18"), false);
  assert.equal(p, "high");
  assert.match(click, /^https:\/\/www\.ns\.nl\/reisplanner#\/\?/);
  assert.ok(click.includes("vertrek=Utrecht"));
  assert.ok(click.includes("aankomst=Amsterdam"));
  assert.ok(click.includes("2026-10-15T08"));
});

test("no repeat", () => {
  assert.deepEqual(detect.diff({ ...cur }, cur), []);
});

test("small growth ignored, big growth notified", () => {
  assert.deepEqual(detect.diff(cur, { ...cur, delay: 9 }), []);
  assert.ok(detect.diff(cur, { ...cur, delay: 13 })[0][1].includes("+13"));
});

test("resolved", () => {
  assert.match(detect.diff(cur, { ...cur, delay: 0 })[0][1], /Weer op tijd \(was \+7 min\)/);
});

test("below threshold silent", () => {
  const on = { ...cur, delay: 0, track: "5" };
  assert.deepEqual(detect.diff(on, { ...on, delay: 2 }), []);
});

test("cancel departure", () => {
  const dep = detect.stateFromDeparture(F("departures.json").payload.departures[0]);
  const ev = detect.diff(null, dep);
  assert.match(ev[0][1], /Rijdt niet meer \(was gepland 08:12\)/);
  const [title, body, prio, click] = detect.formatMsg({ ...SUB, train: "3014" }, dep, ev);
  assert.equal(prio, "urgent");
  assert.match(title, /trein 3014/);
  assert.equal(body.includes("spoor"), false);
  assert.equal(body.includes("Reden"), false);
  assert.match(click, /reisplanner/);
  const trainOnly = detect.formatMsg({ from: "UT", fromName: "Utrecht", to: "", time: "08:12", train: "3014" }, dep, ev);
  assert.match(trainOnly[3], /vertrektijden\?station=UT/);
});

test("track change", () => {
  const ev = detect.diff({ ...cur, track: "5" }, cur);
  assert.ok(ev.some((e) => e[1] === "Spoor 5 → 18"));
});

test("disruptions", () => {
  const d = detect.relevantDisruptions(F("disruptions.json"), cur.stations);
  assert.deepEqual(d.map((x) => x.id), ["7_123"]);
  const ev = detect.diff({ ...cur }, { ...cur, disruptions: d });
  assert.match(ev[0][1], /^Storing: Utrecht Centraal - Amsterdam Centraal$/);
});

test("alternative", () => {
  const c = detect.stateFromTrip({ ...trip, status: "ALTERNATIVE_TRANSPORT" });
  c.disruptions = [];
  assert.ok(detect.diff({ ...cur }, c).some((e) => /vervangend/i.test(e[1])));
});

test("live trip", () => {
  const tr = F("live_trips.json").trips[0];
  const c = detect.stateFromTrip(tr);
  assert.ok(c.planned);
  assert.ok(c.track);
  assert.ok(c.stations.includes("UT"));
  assert.ok(detect.pickTrip(F("live_trips.json").trips, c.planned.slice(11, 16)));
});

test("live departure", () => {
  const c = detect.stateFromDeparture(F("live_departures.json").payload.departures[0]);
  assert.ok(c.trainNumber);
  assert.ok(c.delay >= 0);
});

test("live disruptions", () => {
  const d = F("live_disruptions.json");
  const code = d[0].publicationSections[0].section.stations[0].stationCode;
  assert.ok(detect.relevantDisruptions(d, [code]).length);
});

test("part cancelled", () => {
  const tr = structuredClone(F("live_trips.json").trips[0]);
  tr.legs[0].partCancelled = true;
  const c = detect.stateFromTrip(tr);
  c.disruptions = [];
  assert.ok(detect.diff({ ...c, partCancelled: false }, c).some((e) => /deels uitgevallen/i.test(e[1])));
});

test("notes lists skip ATTRIBUTE and keep other note types", () => {
  const t = {
    status: "NORMAL",
    legs: [{
      travelType: "PUBLIC_TRANSIT",
      origin: {
        stationCode: "UT",
        plannedDateTime: "2026-10-15T08:12:00+0200",
        actualDateTime: "2026-10-15T08:12:00+0200",
        plannedTrack: "5",
        actualTrack: "5",
        notes: null,
      },
      destination: { stationCode: "ASD" },
      product: { number: "1", notes: [[{ value: "NS Intercity", noteType: "ATTRIBUTE" }]] },
      notes: [[{ value: "Let op", noteType: "HINT" }], { value: "plat", noteType: "INFO" }],
    }],
  };
  assert.deepEqual(detect.stateFromTrip(t).messages, ["Let op", "plat"]);
});

test("change not possible ignores the last leg", () => {
  const leg = (changePossible) => ({
    travelType: "PUBLIC_TRANSIT",
    changePossible,
    origin: { stationCode: "UT", plannedDateTime: "2026-10-15T08:12:00+0200", plannedTrack: "5" },
    destination: { stationCode: "ASD" },
    product: { number: "1" },
  });
  assert.equal(detect.stateFromTrip({ status: "NORMAL", legs: [leg(false)] }).changeNotPossible, false);
  assert.equal(detect.stateFromTrip({ status: "NORMAL", legs: [leg(false), leg(true)] }).changeNotPossible, true);
});

function onTime(track = "2") {
  return {
    planned: "2026-10-15T08:12:00+0200",
    delay: 0,
    departurePlanned: "08:12",
    departureActual: "08:12",
    arrivalPlanned: "08:40",
    arrivalActual: "08:40",
    arrivalDelay: 0,
    plannedTrack: track,
    track,
    cancelled: false,
    alternative: false,
    partCancelled: false,
    partFrom: "",
    partTo: "",
    changeNotPossible: false,
    disruptions: [],
    messages: [],
    alternatives: [],
  };
}

test("Amersfoort disruption states cause, end, advice and this train", () => {
  const info = detect.relevantDisruptions(F("disruption_amersfoort.json"), ["AMF"]);
  assert.equal(info.length, 1);
  assert.equal(info[0].title, "Amersfoort - Ede-Wageningen");
  assert.equal(info[0].cause, "seinstoring");
  assert.equal(info[0].end, "18:00");
  const base = onTime("2");
  const next = { ...base, disruptions: info };
  const ev = detect.diff(base, next);
  const sub = { from: "AMF", fromName: "Amersfoort", to: "ED", toName: "Ede-Wageningen", time: "08:12" };
  const [title, body] = detect.formatMsg(sub, next, ev);
  assert.equal(title, "08:12 Amersfoort → Ede-Wageningen");
  assert.match(body, /Storing: Amersfoort - Ede-Wageningen, seinstoring, tot 18:00/);
  assert.match(body, /Advies: Reis via Utrecht of kies een later tijdstip/);
  assert.match(body, /Jouw trein: op tijd/);
  assert.equal(body.includes("Wageningen."), false);
  assert.equal(body.includes("spoor"), false);
});

test("old to new delay, platform, arrival, cancel, recovery and partial", () => {
  const was = { ...onTime("5"), delay: 3, departureActual: "08:15" };
  const now = {
    ...cur,
    delay: 7,
    arrivalPlanned: "08:39",
    arrivalActual: "08:48",
    arrivalDelay: 9,
  };
  const ev = detect.diff(was, now, 3, 4);
  const texts = ev.map((e) => e[1]);
  assert.ok(texts.some((t) => t === "Vertrek 08:12 → 08:19 (+7 min, was +3)"));
  assert.ok(texts.some((t) => t === "Spoor 5 → 18"));
  assert.ok(texts.some((t) => t === "Aankomst 08:39 → 08:48"));

  const cancelled = { ...onTime("2"), cancelled: true, messages: ["Rijdt niet"] };
  assert.match(detect.diff(onTime("2"), cancelled)[0][1], /Rijdt niet meer \(was gepland 08:12\)/);
  assert.match(detect.diff(cancelled, onTime("2"))[0][1], /Rijdt weer \(was geannuleerd\)/);

  const partial = {
    ...onTime("4"),
    partCancelled: true,
    partFrom: "Amersfoort",
    partTo: "Ede-Wageningen",
  };
  assert.equal(
    detect.diff(onTime("4"), partial)[0][1],
    "Deels uitgevallen: rijdt niet tussen Amersfoort en Ede-Wageningen",
  );
});

test("platform is context when the train moves and stays off a disruption-only alert", () => {
  const base = onTime("2");
  const moved = { ...base, delay: 7, departureActual: "08:19" };
  const [, delayedBody] = detect.formatMsg(SUB, moved, detect.diff(base, moved));
  assert.match(delayedBody, /Vertrek 08:12 → 08:19 \(\+7 min\)/);
  assert.match(delayedBody, /vertrekt van spoor 2/);
  assert.equal(/(^|\n)spoor 2(\n|$)/.test(delayedBody), false);

  const info = detect.relevantDisruptions(F("disruption_amersfoort.json"), ["ED"]);
  const both = { ...moved, disruptions: info };
  const [, withDisruption] = detect.formatMsg(SUB, both, detect.diff(base, both));
  assert.match(withDisruption, /vertrekt van spoor 2/);
  assert.match(withDisruption, /seinstoring/);
  assert.equal(withDisruption.includes("Jouw trein"), false);
});

test("cancelled or large delay lists the next trains and a small delay does not", () => {
  const alts = [
    { time: "08:42", track: "4", delay: 2 },
    { time: "09:12", track: "5", delay: 0 },
  ];
  const cancelled = { ...onTime("2"), cancelled: true, alternatives: alts };
  const [, cancelBody] = detect.formatMsg(SUB, cancelled, detect.diff(onTime("2"), cancelled));
  assert.match(cancelBody, /Alternatief: 08:42 spoor 4 \(\+2 min\); 09:12 spoor 5/);

  const small = { ...onTime("2"), delay: 7, departureActual: "08:19", alternatives: alts };
  const [, smallBody] = detect.formatMsg(SUB, small, detect.diff(onTime("2"), small));
  assert.equal(smallBody.includes("Alternatief"), false);

  const big = { ...small, delay: 12, departureActual: "08:24" };
  const [, bigBody] = detect.formatMsg(SUB, big, detect.diff(onTime("2"), big));
  assert.match(bigBody, /Alternatief: 08:42 spoor 4 \(\+2 min\); 09:12 spoor 5/);
});

test("duration text is used when NS gives no end time", () => {
  const described = detect.describeDisruption({
    id: "x",
    title: "Utrecht - Amsterdam.",
    isActive: true,
    expectedDuration: { description: "ongeveer 2 uur." },
    timespans: [{ cause: { label: "aanrijding" }, advices: [] }],
  });
  assert.equal(described.cause, "aanrijding");
  assert.equal(described.duration, "ongeveer 2 uur");
  assert.match(detect.diff(onTime("1"), { ...onTime("1"), disruptions: [described] })[0][1], /aanrijding, ongeveer 2 uur/);
});

test("later trains skip the watched departure and cancelled journeys", () => {
  const trips = F("trips.json").trips;
  assert.equal(detect.alternativeTrains(trips, { after: "08:12", skipNumber: "3014" }).length, 0);
  const next = detect.alternativeTrains(trips, { after: "07:00", skipNumber: "3012" });
  assert.equal(next[0].time, "08:12");
  assert.equal(next[0].track, "18");
  assert.equal(next[0].delay, 7);
  const deps = [
    { plannedDateTime: "2026-10-15T08:12:00+0200", cancelled: true, direction: "Amsterdam Centraal", product: { number: "3014" }, plannedTrack: "5" },
    { plannedDateTime: "2026-10-15T08:42:00+0200", direction: "Amsterdam Centraal", product: { number: "3016" }, plannedTrack: "4", actualTrack: "4" },
    { plannedDateTime: "2026-10-15T08:55:00+0200", direction: "Rotterdam Centraal", product: { number: "3018" }, plannedTrack: "7" },
  ];
  const found = detect.alternativeDepartures(deps, { after: "08:12", skipNumber: "3014", direction: "Amsterdam Centraal" });
  assert.deepEqual(found, [{ time: "08:42", track: "4", delay: 0, train: "3016" }]);
});
