import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  amsterdamParts,
  buildDigest,
  digestTarget,
  dueSlots,
  markSlot,
  overlapsDay,
  parseDigestTimes,
} from "../digest.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disruptions = JSON.parse(readFileSync(path.join(root, "tests/fixtures/digest_disruptions.json"), "utf8"));
const weekly = [{ from: "UT", to: "ASD", time: "08:12", days: ["ma", "di", "wo", "do", "vr"] }];

function morning(extra = []) {
  return buildDigest({
    disruptions: disruptions.concat(extra),
    subs: weekly,
    ymd: "2026-10-14",
    weekday: "wo",
    label: "vandaag",
    previous: {},
    quiet: false,
  });
}

test("amsterdam clock, summer and winter, picks today or tomorrow", () => {
  const summer = amsterdamParts(new Date("2026-10-14T04:00:00Z"));
  assert.equal(summer.ymd, "2026-10-14");
  assert.equal(summer.hhmm, "06:00");
  assert.equal(summer.weekday, "wo");
  const winter = amsterdamParts(new Date("2026-01-15T05:00:00Z"));
  assert.equal(winter.ymd, "2026-01-15");
  assert.equal(winter.hhmm, "06:00");
  assert.equal(winter.weekday, "do");
  assert.equal(amsterdamParts(new Date("2026-10-14T19:00:00Z")).hhmm, "21:00");
  assert.deepEqual(digestTarget(new Date("2026-10-14T04:00:00Z"), "06:00"), {
    ymd: "2026-10-14", weekday: "wo", label: "vandaag",
  });
  assert.deepEqual(digestTarget(new Date("2026-10-14T19:00:00Z"), "21:00"), {
    ymd: "2026-10-15", weekday: "do", label: "morgen",
  });
});

test("parseDigestTimes normalizes and rejects bad tokens", () => {
  assert.deepEqual(parseDigestTimes("6:00, 21:00"), ["06:00", "21:00"]);
  assert.deepEqual(parseDigestTimes("06:00;06:00 21:05"), ["06:00", "21:05"]);
  assert.deepEqual(parseDigestTimes(["7:30", "22:05"]), ["07:30", "22:05"]);
  assert.equal(parseDigestTimes("25:00"), null);
  assert.equal(parseDigestTimes("06:60"), null);
  assert.equal(parseDigestTimes("zes"), null);
  assert.equal(parseDigestTimes(""), null);
  assert.equal(parseDigestTimes("06:00, nee"), null);
});

test("due slots stay inside a 15 minute grace and are not repeated", () => {
  const times = ["06:00", "21:00"];
  assert.deepEqual(dueSlots(new Date("2026-10-14T04:02:00Z"), times, []).map((s) => s.time), ["06:00"]);
  assert.deepEqual(dueSlots(new Date("2026-10-14T04:14:00Z"), times, []).map((s) => s.key), ["2026-10-14 06:00"]);
  assert.deepEqual(dueSlots(new Date("2026-10-14T04:15:00Z"), times, []), []);
  assert.deepEqual(dueSlots(new Date("2026-10-14T04:20:00Z"), times, []), []);
  assert.deepEqual(dueSlots(new Date("2026-10-14T19:00:00Z"), times, []).map((s) => s.key), ["2026-10-14 21:00"]);
  assert.deepEqual(dueSlots(new Date("2026-10-14T19:00:00Z"), times, ["2026-10-14 21:00"]), []);
  assert.deepEqual(markSlot(["2026-10-10 06:00", "2026-10-13 21:00"], new Date("2026-10-14T04:02:00Z"), "6:00"), [
    "2026-10-13 21:00",
    "2026-10-14 06:00",
  ]);
});

test("morning digest keeps national events and today's route, drops the rest", () => {
  const built = morning();
  assert.equal(built.sent, true);
  assert.equal(built.priority, "high");
  assert.equal(built.title, "⚠️ Storingen vandaag");
  assert.equal(built.count, 4);
  assert.match(built.body, /^Landelijk\n• Staking: Utrecht - Heerlen\n• Calamiteit: Groot alarm Amsterdam\n• Storing: Veel stations\n\nJouw traject\n• Storing: Seinbeeld Utrecht$/);
  assert.equal(built.body.includes("Zwolle"), false);
  assert.equal(built.body.includes("Amsterdam Zuid"), false);
  assert.equal(built.body.includes("Oude storing"), false);
  const route = built.body.split("Jouw traject")[1];
  assert.equal(route.includes("Staking"), false);
  assert.equal(route.includes("Utrecht - Heerlen"), false);
});

test("evening digest looks at tomorrow and keeps planned works that overlap that day", () => {
  const built = buildDigest({
    disruptions,
    subs: weekly,
    ymd: "2026-10-15",
    weekday: "do",
    label: "morgen",
    previous: {},
    quiet: false,
  });
  assert.equal(built.priority, "high");
  assert.equal(built.title, "⚠️ Storingen morgen");
  assert.match(built.body, /Landelijk\n• Calamiteit: Groot alarm Amsterdam\n\nJouw traject\n• Werkzaamheden: Amsterdam Zuid/);
  assert.equal(built.body.includes("Staking"), false);
  assert.equal(built.body.includes("Seinbeeld"), false);
  assert.equal(built.body.includes("Veel stations"), false);
  assert.equal(overlapsDay(disruptions.find((d) => d.id === "works-asd"), "2026-10-15"), true);
  assert.equal(overlapsDay(disruptions.find((d) => d.id === "works-asd"), "2026-10-14"), false);
});

test("weekday and one-time subscriptions decide the route bucket", () => {
  const mondayOnly = buildDigest({
    disruptions,
    subs: [{ from: "UT", to: "ASD", time: "08:12", days: ["ma"] }],
    ymd: "2026-10-14",
    weekday: "wo",
    label: "vandaag",
    previous: {},
    quiet: false,
  });
  assert.equal(mondayOnly.sent, false);
  assert.equal(mondayOnly.reason, "geen reis");
  assert.equal(mondayOnly.body.includes("Staking"), false);

  const once = buildDigest({
    disruptions,
    subs: [{ from: "UT", to: "ASD", time: "08:12", date: "2026-10-14" }],
    ymd: "2026-10-14",
    weekday: "wo",
    label: "vandaag",
    previous: {},
    quiet: false,
  });
  assert.ok(once.body.includes("Seinbeeld"));
  const nextDay = buildDigest({
    disruptions,
    subs: [{ from: "UT", to: "ASD", time: "08:12", date: "2026-10-14" }],
    ymd: "2026-10-15",
    weekday: "do",
    label: "morgen",
    previous: {},
    quiet: false,
  });
  assert.equal(nextDay.sent, false);
  assert.equal(nextDay.reason, "geen reis");
  assert.equal(nextDay.body.includes("Amsterdam Zuid"), false);
  assert.equal(nextDay.body.includes("Calamiteit"), false);
});

test("no digest on a rest day, even for national events or quiet all-clear", () => {
  const sunday = buildDigest({
    disruptions,
    subs: weekly,
    ymd: "2026-10-18",
    weekday: "zo",
    label: "vandaag",
    previous: {},
    quiet: true,
  });
  assert.equal(sunday.sent, false);
  assert.equal(sunday.reason, "geen reis");
  assert.equal(sunday.body, "");
});

test("unchanged events are skipped unless the text changed, and quiet is optional", () => {
  const first = morning();
  const same = buildDigest({
    disruptions,
    subs: weekly,
    ymd: "2026-10-14",
    weekday: "wo",
    label: "vandaag",
    previous: first.next,
    quiet: true,
  });
  assert.equal(same.sent, true);
  assert.equal(same.reason, "herinnering");
  assert.equal(same.quiet, false);
  assert.equal(same.title, "⚠️ Niets nieuws — storingen vandaag");
  assert.match(same.body, /^Er is niets nieuws — nog steeds:\n\nLandelijk\n• Staking:/);
  assert.ok(same.body.includes("Jouw traject"));
  assert.equal(same.priority, "high");

  const changed = disruptions.map((d) => d.id === "local-ut" ? { ...d, title: "Seinbeeld Utrecht gewijzigd" } : d);
  const again = buildDigest({
    disruptions: changed,
    subs: weekly,
    ymd: "2026-10-14",
    weekday: "wo",
    label: "vandaag",
    previous: first.next,
    quiet: false,
  });
  assert.equal(again.sent, true);
  assert.equal(again.count, 1);
  assert.equal(again.body.includes("Landelijk"), false);
  assert.ok(again.body.includes("Seinbeeld Utrecht gewijzigd"));

  const empty = buildDigest({
    disruptions: [], subs: weekly, ymd: "2026-10-14", weekday: "wo", label: "vandaag", previous: {}, quiet: false,
  });
  assert.equal(empty.sent, false);
  assert.equal(empty.reason, "niets");
  const quiet = buildDigest({
    disruptions: [], subs: weekly, ymd: "2026-10-14", weekday: "wo", label: "vandaag", previous: {}, quiet: true,
  });
  assert.equal(quiet.sent, true);
  assert.equal(quiet.title, "Dagelijkse check");
  assert.equal(quiet.body, "Alles rustig — geen relevante storingen of werkzaamheden.");
  assert.equal(quiet.priority, "default");
});

test("high impact, open-ended active items and station count", () => {
  const high = morning([{
    id: "impact-ut",
    type: "DISRUPTION",
    title: "Hoge impact Utrecht",
    isActive: true,
    impact: { value: 3 },
    start: "2026-10-14T08:00:00+0200",
    end: "2026-10-14T10:00:00+0200",
    publicationSections: [{ section: { stations: [{ stationCode: "UT" }, { stationCode: "ASD" }] } }],
    timespans: [{ start: "2026-10-14T08:00:00+0200", end: "2026-10-14T10:00:00+0200", cause: { label: "seinbeeld" } }],
  }]);
  assert.ok(high.body.includes("Landelijk"));
  assert.ok(high.body.includes("• Storing: Hoge impact Utrecht"));
  const route = high.body.split("Jouw traject")[1];
  assert.equal(route.includes("Hoge impact"), false);

  const level = buildDigest({
    disruptions: [{
      id: "lvl",
      type: "DISRUPTION",
      title: "Level high",
      isActive: true,
      impact: { level: "HIGH", value: 1 },
      publicationSections: [{ section: { stations: [{ stationCode: "UT" }] } }],
    }],
    subs: weekly,
    ymd: "2026-10-14",
    weekday: "wo",
    label: "vandaag",
    previous: {},
    quiet: false,
  });
  assert.ok(level.body.startsWith("Landelijk"));
  assert.equal(level.priority, "default");

  const open = {
    id: "open",
    type: "DISRUPTION",
    title: "Nog bezig",
    isActive: true,
    impact: { value: 1 },
    publicationSections: [{ section: { stations: [{ stationCode: "UT" }] } }],
  };
  assert.equal(overlapsDay(open, "2026-10-14"), true);
  assert.equal(overlapsDay({ ...open, isActive: false }, "2026-10-14"), false);
  const eleven = Array.from({ length: 11 }, (_, i) => ({ stationCode: `T${i}` }));
  const small = buildDigest({
    disruptions: [{
      id: "eleven", type: "DISRUPTION", title: "Elf stations", isActive: true, impact: { value: 1 },
      publicationSections: [{ section: { stations: eleven } }],
    }],
    subs: [],
    ymd: "2026-10-14",
    weekday: "wo",
    label: "vandaag",
    previous: {},
    quiet: false,
  });
  assert.equal(small.sent, false);
});

test("live staking snapshot is a high-priority national digest on a travel day", () => {
  const live = JSON.parse(readFileSync(path.join(root, "tests/fixtures/live_disruptions.json"), "utf8"));
  const built = buildDigest({
    disruptions: live,
    subs: weekly,
    ymd: "2026-10-14",
    weekday: "wo",
    label: "vandaag",
    previous: {},
    quiet: false,
  });
  assert.equal(built.sent, true);
  assert.equal(built.priority, "high");
  assert.ok(built.count >= 1);
  assert.ok(built.body.includes("Staking"));
  assert.ok(built.body.includes("Heerlen"));
  const rest = buildDigest({
    disruptions: live,
    subs: weekly,
    ymd: "2026-10-18",
    weekday: "zo",
    label: "vandaag",
    previous: {},
    quiet: false,
  });
  assert.equal(rest.sent, false);
  assert.equal(rest.reason, "geen reis");
});
