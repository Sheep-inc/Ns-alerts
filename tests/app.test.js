import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { DAYS, activeWindow, createApp, decodeNsBody, oneTimeFinished } from "../app.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const open = [];
after(async () => { await Promise.all(open.splice(0).map((a) => a.close())); });

function tmp() { return mkdtempSync(path.join(tmpdir(), "ns-alerts-")); }

async function boot(opts) {
  const app = createApp(opts);
  open.push(app);
  await app.start();
  return app;
}

function authHeader(pw) {
  return { Authorization: `Basic ${Buffer.from(`x:${pw}`).toString("base64")}` };
}

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

async function call(app, urlPath, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.auth !== false) Object.assign(headers, authHeader(opts.password ?? "geheim"));
  const res = await fetch(`http://127.0.0.1:${app.port}${urlPath}`, { method: opts.method || "GET", headers, body: opts.body });
  const text = await res.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* html */ }
  return { status: res.status, body, text, headers: res.headers };
}

describe("ns-alerts http", { concurrency: 1 }, () => {
  test("active window follows weekday and the 60/5 minute bounds", () => {
    const sub = { time: "08:12", days: DAYS.slice(0, 5) };
    const thu = (h, m, s = 0) => new Date(2026, 9, 15, h, m, s);
    assert.ok(activeWindow(sub, thu(8, 0), 60));
    assert.ok(activeWindow(sub, thu(7, 12), 60));
    assert.equal(activeWindow(sub, thu(7, 11, 59), 60), null);
    assert.ok(activeWindow(sub, thu(8, 17), 60));
    assert.equal(activeWindow(sub, thu(8, 17, 1), 60), null);
    assert.equal(activeWindow(sub, new Date(2026, 9, 17, 8, 0), 60), null);
    assert.ok(activeWindow({ time: "08:12" }, new Date(2026, 9, 17, 8, 0), 60));
    const once = { time: "08:12", date: "2026-10-15" };
    assert.ok(activeWindow(once, new Date(2026, 9, 15, 8, 0), 60));
    assert.equal(activeWindow(once, new Date(2026, 9, 16, 8, 0), 60), null);
    assert.equal(activeWindow(once, new Date(2026, 9, 14, 23, 30), 60), null);
    assert.equal(oneTimeFinished({ time: "08:12", days: ["do"] }, new Date(2026, 9, 16, 12, 0)), false);
    assert.equal(oneTimeFinished(once, new Date(2026, 9, 15, 8, 17), null), false);
    assert.equal(oneTimeFinished(once, new Date(2026, 9, 15, 8, 17, 1), null), true);
    assert.equal(oneTimeFinished(once, new Date(2026, 9, 15, 7, 0), null), false);
    assert.equal(oneTimeFinished(once, new Date(2026, 9, 16, 9, 0), null), true);
    assert.equal(oneTimeFinished(once, new Date(2026, 9, 15, 8, 14), "2026-10-15T08:15:00+0200"), false);
    assert.equal(oneTimeFinished(once, new Date(2026, 9, 15, 8, 15), "2026-10-15T08:15:00+0200"), true);
  });

  test("decodeNsBody gunzips disruptions payloads and parses plain JSON", () => {
    const obj = [{ id: "1", title: "x" }];
    assert.deepEqual(decodeNsBody(Buffer.from(JSON.stringify(obj))), obj);
    assert.deepEqual(decodeNsBody(zlib.gzipSync(Buffer.from(JSON.stringify(obj)))), obj);
  });

  test("seed copies subscriptions only when the data file is absent", async () => {
    const base = tmp();
    const dataDir = path.join(base, "data");
    const seedDir = path.join(base, "seed");
    const seedFile = path.join(seedDir, "subscriptions.json");
    mkdirSync(seedDir, { recursive: true });
    const payload = [{ from: "UT", fromName: "Utrecht Centraal", time: "08:12", to: "ASD", days: ["ma"], id: "a1b2c3d4" }];
    writeFileSync(seedFile, JSON.stringify(payload));
    const app = await boot({ base, dataDir, env: { UI_PASSWORD: "", PORT: "0" }, port: 0 });
    try {
      assert.deepEqual(JSON.parse(readFileSync(app.subsFile, "utf8")), payload);
      writeFileSync(seedFile, "[]");
      const again = await boot({ base, dataDir, env: { UI_PASSWORD: "", PORT: "0", SEED_FILE: seedFile }, port: 0 });
      assert.deepEqual(JSON.parse(readFileSync(again.subsFile, "utf8")), payload);
      await again.close();
    } finally { await app.close(); rmSync(base, { recursive: true, force: true }); }
  });

  test("missing seed leaves subscriptions empty", async () => {
    const base = tmp();
    const app = await boot({ base, dataDir: path.join(base, "data"), env: { PORT: "0" }, port: 0 });
    try {
      assert.equal(existsSync(app.subsFile), false);
      const r = await call(app, "/api/subs", { auth: false });
      assert.deepEqual(r.body, []);
    } finally { await app.close(); rmSync(base, { recursive: true, force: true }); }
  });

  test("http api, auth, import and settings", async () => {
    const base = tmp();
    const dataDir = path.join(base, "data");
    const ntfyHits = [];
    const ntfy = await listen((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        ntfyHits.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
        res.writeHead(200); res.end("ok");
      });
    });
    const app = await boot({
      base: root,
      dataDir,
      port: 0,
      env: { UI_PASSWORD: "geheim", NTFY_TOPIC: "topic-vast", NTFY_SERVER: ntfy.url, PORT: "0" },
    });
    try {
      assert.equal((await call(app, "/healthz", { auth: false })).body.ok, true);
      assert.equal((await call(app, "/", { auth: false })).status, 401);
      const page = await call(app, "/");
      assert.equal(page.status, 200);
      assert.ok(page.text.includes("NS treinalerts"));
      assert.ok(page.text.includes("Eenmalig"));
      assert.ok(page.text.includes("Dagelijkse check"));
      assert.ok(page.text.includes("Nu checken"));
      assert.ok(page.text.includes("Minuten vóór vertrek"));
      assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");

      const st = await call(app, "/api/status");
      assert.equal(st.body.key, false);
      assert.equal(st.body.topic, "topic-vast");
      assert.equal(st.body.server, ntfy.url);
      assert.equal(st.body.threshold, 3);
      assert.equal(st.body.window_min, 30);
      assert.equal(st.body.digest_enabled, true);
      assert.deepEqual(st.body.digest_times, ["06:00", "21:00"]);
      assert.equal(st.body.digest_quiet, false);
      assert.equal(st.body.last_digest, null);
      assert.equal((await call(app, "/api/digest", { method: "POST" })).status, 503);
      assert.equal((await call(app, "/api/status", { password: "fout" })).status, 401);
      assert.equal((await call(app, "/api/stations?q=ut")).status, 503);

      const bad = await call(app, "/api/subs", { method: "POST", body: "{}" });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, "van, naar/treinnummer en tijd verplicht");

      const created = await call(app, "/api/subs", {
        method: "POST",
        body: JSON.stringify({ from: "ut", fromName: "Utrecht Centraal", to: "asd", toName: "Amsterdam Centraal", time: "08:12", label: "Naar werk", days: ["ma", "di"] }),
      });
      assert.equal(created.status, 200);
      assert.equal(created.body.from, "UT");
      assert.equal(created.body.to, "ASD");
      assert.equal(created.body.date, undefined);
      assert.deepEqual(created.body.days, ["ma", "di"]);
      assert.match(created.body.id, /^[0-9a-f]{8}$/);
      const once = await call(app, "/api/subs", {
        method: "POST",
        body: JSON.stringify({ from: "ut", to: "asd", time: "09:00", date: "2026-10-20", label: "Een keer" }),
      });
      assert.equal(once.status, 200);
      assert.equal(once.body.date, "2026-10-20");
      assert.equal(once.body.days, undefined);
      assert.equal((await call(app, "/api/subs", { method: "POST", body: JSON.stringify({ from: "UT", to: "ASD", time: "09:00", date: "2026-13-40" }) })).status, 400);
      const listed = await call(app, "/api/subs");
      assert.equal(listed.body.length, 2);
      assert.equal(listed.body[1].date, "2026-10-20");
      assert.equal(listed.body[0].date, undefined);
      assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, "subscriptions.json"), "utf8")), listed.body);

      assert.equal((await call(app, `/api/subs/${created.body.id}`, { method: "DELETE" })).body.ok, true);
      assert.equal((await call(app, `/api/subs/${once.body.id}`, { method: "DELETE" })).body.ok, true);
      assert.deepEqual((await call(app, "/api/export")).body, []);

      const example = JSON.parse(readFileSync(path.join(root, "subs.example.json"), "utf8"));
      const imported = await call(app, "/api/import", { method: "POST", body: JSON.stringify(example) });
      assert.equal(imported.body.count, 2);
      const exp = await call(app, "/api/export");
      assert.equal(exp.body[0].from, "UT");
      assert.ok(exp.body[0].id);
      assert.deepEqual(exp.body[1].days, ["ma", "wo"]);
      const dated = await call(app, "/api/import", {
        method: "POST",
        body: JSON.stringify([{ from: "UT", time: "07:00", date: "2026-11-01", to: "ASD" }]),
      });
      assert.equal(dated.body.count, 1);
      const datedList = await call(app, "/api/export");
      assert.equal(datedList.body[0].date, "2026-11-01");
      assert.equal(datedList.body[0].days, undefined);
      assert.equal((await call(app, "/api/import", { method: "POST", body: "{}" })).status, 400);

      assert.equal((await call(app, "/api/settings", { method: "POST", body: JSON.stringify({ threshold: "4" }) })).body.ok, true);
      assert.equal((await call(app, "/api/status")).body.threshold, 4);
      assert.equal((await call(app, "/api/settings", { method: "POST", body: JSON.stringify({ threshold: 0 }) })).status, 200);
      assert.equal((await call(app, "/api/status")).body.threshold, 1);
      assert.equal((await call(app, "/api/status")).body.window_min, 30);
      assert.equal((await call(app, "/api/settings", { method: "POST", body: JSON.stringify({ window_min: "45" }) })).body.ok, true);
      const afterWin = await call(app, "/api/status");
      assert.equal(afterWin.body.window_min, 45);
      assert.equal(afterWin.body.threshold, 1);

      const sent = await call(app, "/api/test", { method: "POST" });
      assert.equal(sent.status, 200);
      assert.equal(ntfyHits[0].topic, "topic-vast");
      assert.equal(ntfyHits[0].title, "🚆 Test melding");
      assert.equal(ntfyHits[0].priority, 3);

      const down = await boot({
        base: root,
        dataDir: path.join(base, "other"),
        port: 0,
        env: { NTFY_SERVER: "http://127.0.0.1:9", NTFY_TOPIC: "x", PORT: "0" },
      });
      assert.equal((await call(down, "/api/test", { method: "POST", auth: false })).status, 502);
      await down.close();
    } finally {
      await app.close();
      await new Promise((r) => ntfy.srv.close(r));
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("one-time subs are removed after the window and recurring subs stay", async () => {
    const base = tmp();
    const dataDir = path.join(base, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, "subscriptions.json"), JSON.stringify([
      { id: "once0001", from: "UT", to: "ASD", time: "08:12", date: "2026-10-15" },
      { id: "week0001", from: "UT", to: "ASD", time: "08:12", days: ["ma", "di", "wo", "do", "vr"] },
    ]));
    const app = await boot({ base: root, dataDir, port: 0, env: { PORT: "0" } });
    try {
      await app.pollOnce(new Date(2026, 9, 15, 8, 0, 0));
      let saved = JSON.parse(readFileSync(app.subsFile, "utf8"));
      assert.deepEqual(saved.map((s) => s.id).sort(), ["once0001", "week0001"]);
      await app.pollOnce(new Date(2026, 9, 15, 8, 18, 0));
      saved = JSON.parse(readFileSync(app.subsFile, "utf8"));
      assert.deepEqual(saved.map((s) => s.id), ["week0001"]);
    } finally { await app.close(); rmSync(base, { recursive: true, force: true }); }
  });

  test("one-time sub is removed after arrival inside the departure window", async () => {
    const base = tmp();
    const dataDir = path.join(base, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, "subscriptions.json"), JSON.stringify([
      { id: "oncearr1", from: "UT", fromName: "Utrecht", to: "ASD", toName: "Amsterdam", time: "08:12", date: "2026-10-15" },
    ]));
    const realFetch = globalThis.fetch;
    const trip = {
      trips: [{
        status: "NORMAL",
        legs: [{
          travelType: "PUBLIC_TRANSIT",
          product: { number: "1" },
          origin: { stationCode: "UT", plannedDateTime: "2026-10-15T08:12:00+0200", actualDateTime: "2026-10-15T08:12:00+0200", plannedTrack: "5", actualTrack: "5" },
          destination: { stationCode: "ASD", plannedDateTime: "2026-10-15T08:20:00+0200", actualDateTime: "2026-10-15T08:14:00+0200" },
        }],
      }],
    };
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.startsWith("https://gateway.apiportal.ns.nl")) {
        if (u.includes("/disruptions/")) return new Response("down", { status: 500 });
        return new Response(JSON.stringify(trip), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(url, opts);
    };
    const app = await boot({
      base: root,
      dataDir,
      port: 0,
      env: { NS_API_KEY: "test-key", NTFY_SERVER: "http://127.0.0.1:9", NTFY_TOPIC: "t", PORT: "0", DIGEST_ENABLED: "0" },
    });
    try {
      await app.pollOnce(new Date(2026, 9, 15, 8, 14, 0));
      const saved = JSON.parse(readFileSync(app.subsFile, "utf8"));
      assert.deepEqual(saved, []);
    } finally {
      globalThis.fetch = realFetch;
      await app.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("poller uses trips, gzip disruptions and departures", async () => {
    const base = tmp();
    const dataDir = path.join(base, "data");
    const seen = [];
    const realFetch = globalThis.fetch;
    const trips = JSON.parse(readFileSync(path.join(root, "tests/fixtures/trips.json"), "utf8"));
    const departures = JSON.parse(readFileSync(path.join(root, "tests/fixtures/departures.json"), "utf8"));
    const disruptions = JSON.parse(readFileSync(path.join(root, "tests/fixtures/disruptions.json"), "utf8"));
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(disruptions)));
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.startsWith("https://gateway.apiportal.ns.nl")) {
        seen.push({ url: u, key: opts.headers?.["Ocp-Apim-Subscription-Key"] });
        const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
        if (u.includes("/api/v3/trips")) return json(trips);
        if (u.includes("/api/v2/departures")) return json(departures);
        if (u.includes("/disruptions/v3")) return new Response(gz, { status: 200, headers: { "content-type": "application/json" } });
        if (u.includes("/api/v2/stations")) {
          return json({ payload: [{ code: "UT", namen: { lang: "Utrecht Centraal" }, land: "NL" }, { code: "ASD", namen: { lang: "Amsterdam Centraal" }, land: "NL" }] });
        }
        return new Response("missing", { status: 500 });
      }
      return realFetch(url, opts);
    };
    const ntfyHits = [];
    const ntfy = await listen((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { ntfyHits.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); res.writeHead(200); res.end(); });
    });
    const subs = [
      { id: "route0001", from: "UT", fromName: "Utrecht", to: "ASD", toName: "Amsterdam", time: "08:12", days: ["do"], train: null },
      { id: "train0001", from: "UT", fromName: "Utrecht", to: "", time: "08:12", train: "3014", days: ["do"] },
    ];
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, "subscriptions.json"), JSON.stringify(subs));
    const app = await boot({
      base: root,
      dataDir,
      port: 0,
      env: { NS_API_KEY: "test-key", NTFY_SERVER: ntfy.url, NTFY_TOPIC: "poll-topic", PORT: "0", UI_PASSWORD: "", DIGEST_ENABLED: "0" },
    });
    try {
      await app.pollOnce(new Date(2026, 9, 15, 8, 0, 0));
      const titles = ntfyHits.map((h) => h.title);
      assert.ok(titles.some((t) => t.includes("Utrecht → Amsterdam")));
      assert.ok(ntfyHits.some((h) => h.message.includes("+7 min vertraging") && h.priority === 4));
      assert.ok(ntfyHits.some((h) => h.message.includes("geannuleerd") && h.priority === 5));
      assert.ok(seen.some((s) => s.url.includes("/api/v3/trips") && s.url.includes("fromStation=UT") && s.url.includes("toStation=ASD") && s.url.includes("previousAdvices=1") && s.url.includes("nextAdvices=2") && s.url.includes("dateTime=") && s.key === "test-key"));
      assert.ok(seen.some((s) => s.url.includes("/api/v2/departures") && s.url.includes("station=UT") && s.url.includes("maxJourneys=40")));
      assert.ok(seen.some((s) => s.url.includes("/disruptions/v3") && s.url.includes("isActive=true")));
      const found = await call(app, "/api/stations?q=utrecht", { auth: false });
      assert.equal(found.status, 200);
      assert.equal(found.body[0].code, "UT");
      assert.equal(found.body[0].name, "Utrecht Centraal");
      const state = JSON.parse(readFileSync(path.join(dataDir, "state.json"), "utf8"));
      assert.ok(state["route0001@2026-10-15"]);
      assert.equal(state["route0001@2026-10-15"].delay, 7);
      assert.ok(state["train0001@2026-10-15"].cancelled);
    } finally {
      globalThis.fetch = realFetch;
      await app.close();
      await new Promise((r) => ntfy.srv.close(r));
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("daily digest fetches all disruptions, dedupes and can be triggered now", async () => {
    const base = tmp();
    const dataDir = path.join(base, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, "subscriptions.json"), JSON.stringify([
      { id: "route0001", from: "UT", to: "ASD", time: "08:12", days: ["ma", "di", "wo", "do", "vr"] },
    ]));
    const disruptions = JSON.parse(readFileSync(path.join(root, "tests/fixtures/digest_disruptions.json"), "utf8"));
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.startsWith("https://gateway.apiportal.ns.nl")) {
        seen.push(u);
        if (u === "https://gateway.apiportal.ns.nl/disruptions/v3") {
          return new Response(JSON.stringify(disruptions), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("missing", { status: 500 });
      }
      return realFetch(url, opts);
    };
    const hits = [];
    let failNtfy = true;
    const ntfy = await listen((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (failNtfy) { res.writeHead(500); res.end("no"); return; }
        hits.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200); res.end("ok");
      });
    });
    const morning = new Date("2026-10-14T04:00:00Z");
    const app = await boot({
      base: root,
      dataDir,
      port: 0,
      poll: false,
      env: { NS_API_KEY: "test-key", NTFY_SERVER: ntfy.url, NTFY_TOPIC: "digest-topic", PORT: "0", UI_PASSWORD: "" },
    });
    try {
      await assert.rejects(() => app.runDigest({ now: morning, slot: "06:00" }), /HTTP Error 500/);
      assert.equal(existsSync(path.join(dataDir, "digest.json")), false);
      failNtfy = false;
      const sent = await app.runDigest({ now: morning, slot: "06:00" });
      assert.equal(sent.sent, true);
      assert.equal(sent.count, 4);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].topic, "digest-topic");
      assert.equal(hits[0].priority, 4);
      assert.equal(hits[0].title, "⚠️ Storingen vandaag");
      assert.ok(hits[0].message.includes("Staking"));
      assert.ok(hits[0].message.includes("Jouw traject"));
      assert.ok(hits[0].message.includes("Seinbeeld"));
      assert.equal(hits[0].message.includes("Zwolle"), false);
      assert.equal(hits[0].message.includes("Amsterdam Zuid"), false);
      assert.ok(seen.every((u) => u === "https://gateway.apiportal.ns.nl/disruptions/v3"));
      const saved = JSON.parse(readFileSync(path.join(dataDir, "digest.json"), "utf8"));
      assert.ok(saved.slots.includes("2026-10-14 06:00"));
      assert.ok(saved.events["strike-ut"]);
      assert.equal(saved.events["works-asd"], undefined);
      const again = await app.runDigest({ now: morning, slot: "06:00" });
      assert.equal(again.sent, false);
      assert.equal(again.reason, "ongewijzigd");
      assert.equal(hits.length, 1);
      const evening = await app.maybeDigest(new Date("2026-10-14T19:00:00Z"));
      assert.equal(evening.length, 1);
      assert.equal(evening[0].sent, true);
      assert.equal(hits.length, 2);
      assert.equal(hits[1].priority, 3);
      assert.equal(hits[1].title, "🚧 Storingen morgen");
      assert.ok(hits[1].message.includes("Werkzaamheden: Amsterdam Zuid"));
      assert.equal(hits[1].message.includes("Calamiteit"), false);
      assert.deepEqual(await app.maybeDigest(new Date("2026-10-14T19:05:00Z")), []);
      assert.equal(hits.length, 2);
      const st = await call(app, "/api/status", { auth: false });
      assert.equal(st.body.last_digest.label, "morgen");
      assert.equal(st.body.last_digest.sent, true);
      const bad = await call(app, "/api/settings", { method: "POST", auth: false, body: JSON.stringify({ digest_times: "25:00" }) });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /HH:MM/);
      assert.deepEqual((await call(app, "/api/status", { auth: false })).body.digest_times, ["06:00", "21:00"]);
      const savedSettings = await call(app, "/api/settings", {
        method: "POST",
        auth: false,
        body: JSON.stringify({ digest_times: "7:30, 22:05", digest_enabled: false, digest_quiet: true }),
      });
      assert.equal(savedSettings.body.ok, true);
      const after = await call(app, "/api/status", { auth: false });
      assert.deepEqual(after.body.digest_times, ["07:30", "22:05"]);
      assert.equal(after.body.digest_enabled, false);
      assert.equal(after.body.digest_quiet, true);
      assert.equal(after.body.threshold, 3);
      assert.equal(after.body.window_min, 30);
      assert.deepEqual(await app.maybeDigest(new Date("2026-10-15T05:30:00Z")), []);
      assert.equal(hits.length, 2);
      const forced = await call(app, "/api/digest", { method: "POST", auth: false });
      assert.equal(forced.status, 200);
      assert.equal(typeof forced.body.sent, "boolean");
      assert.equal(typeof forced.body.count, "number");
      assert.ok("reason" in forced.body);
    } finally {
      globalThis.fetch = realFetch;
      await app.close();
      await new Promise((r) => ntfy.srv.close(r));
      rmSync(base, { recursive: true, force: true });
    }
  });
});
