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
});

test("first notification format", () => {
  const ev = detect.diff(null, cur);
  const [t, b, p] = detect.formatMsg(SUB, cur, ev);
  assert.equal(t, "08:12 Utrecht → Amsterdam");
  assert.ok(b.includes("+7 min vertraging"));
  assert.ok(b.includes("spoor 18"));
  assert.equal(p, "high");
});

test("no repeat", () => {
  assert.deepEqual(detect.diff({ ...cur }, cur), []);
});

test("small growth ignored, big growth notified", () => {
  assert.deepEqual(detect.diff(cur, { ...cur, delay: 9 }), []);
  assert.ok(detect.diff(cur, { ...cur, delay: 13 })[0][1].includes("+13"));
});

test("resolved", () => {
  assert.ok(detect.diff(cur, { ...cur, delay: 0 })[0][1].includes("weer op tijd"));
});

test("below threshold silent", () => {
  const on = { ...cur, delay: 0, track: "5" };
  assert.deepEqual(detect.diff(on, { ...on, delay: 2 }), []);
});

test("cancel departure", () => {
  const dep = detect.stateFromDeparture(F("departures.json").payload.departures[0]);
  const ev = detect.diff(null, dep);
  assert.ok(ev[0][1].includes("geannuleerd"));
  assert.equal(detect.formatMsg({ ...SUB, train: "3014" }, dep, ev)[2], "urgent");
});

test("track change", () => {
  const ev = detect.diff({ ...cur, track: "5" }, cur);
  assert.ok(ev.some((e) => e[1].includes("spoor 18")));
});

test("disruptions", () => {
  const d = detect.relevantDisruptions(F("disruptions.json"), cur.stations);
  assert.deepEqual(d.map((x) => x.id), ["7_123"]);
  const ev = detect.diff({ ...cur }, { ...cur, disruptions: d });
  assert.ok(ev[0][1].includes("storing"));
});

test("alternative", () => {
  const c = detect.stateFromTrip({ ...trip, status: "ALTERNATIVE_TRANSPORT" });
  c.disruptions = [];
  assert.ok(detect.diff({ ...cur }, c).some((e) => e[1].includes("vervangend")));
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
  assert.ok(detect.diff({ ...c, partCancelled: false }, c).some((e) => e[1].includes("deels")));
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
