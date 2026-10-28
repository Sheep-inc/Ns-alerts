import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import Database from "better-sqlite3";
import { DAYS, activeWindow, createApp, decodeNsBody, isRangeSub, oneTimeFinished, outerWindow, shiftClock, tripInWindow } from "../app.js";
import { openDb } from "../db.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const open = [];
after(async () => { await Promise.all(open.splice(0).map((a) => a.close())); });

function tmp() { return mkdtempSync(path.join(tmpdir(), "ns-alerts-")); }

function env(extra = {}) {
  return {
    PORT: "0",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "admin-pass-1",
    SCRYPT_N: "1024",
    ...extra,
  };
}

async function boot(opts) {
  const app = createApp({ poll: false, ...opts });
  open.push(app);
  await app.start();
  return app;
}

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

function client(app) {
  const jar = {};
  async function req(urlPath, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
    if (cookie) headers.cookie = cookie;
    if (opts.method && opts.method !== "GET" && opts.csrf !== false) headers["x-csrf-token"] = jar.csrf || "";
    const res = await fetch(`http://127.0.0.1:${app.port}${urlPath}`, { method: opts.method || "GET", headers, body: opts.body });
    for (const raw of res.headers.getSetCookie()) {
      const pair = raw.split(";")[0];
      const i = pair.indexOf("=");
      jar[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
    }
    const text = await res.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* html or svg */ }
    return { status: res.status, body, text, headers: res.headers };
  };
  req.jar = jar;
  return req;
}

async function login(app, username = "admin", password = "admin-pass-1") {
  const req = client(app);
  await req("/login");
  const r = await req("/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return req;
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
    const range = { timeFrom: "16:15", timeTo: "17:30", when: "depart", days: ["do"] };
    assert.equal(isRangeSub(range), true);
    assert.equal(isRangeSub({ time: "16:15" }), false);
    assert.equal(outerWindow(range, thu(15, 44), 30), null);
    assert.ok(outerWindow(range, thu(15, 45), 30));
    assert.ok(outerWindow(range, thu(17, 35), 30));
    assert.equal(outerWindow(range, thu(17, 35, 1), 30), null);
    assert.equal(outerWindow(range, new Date(2026, 9, 16, 16, 30), 30), null);
    assert.equal(outerWindow({ ...range, when: "arrive", timeFrom: "09:00", timeTo: "09:30" }, thu(5, 29), 30, 180), null);
    assert.ok(outerWindow({ ...range, when: "arrive", timeFrom: "09:00", timeTo: "09:30" }, thu(5, 30), 30, 180));
    assert.equal(tripInWindow("2026-10-15T16:22:00+0200", thu(15, 52), 30), true);
    assert.equal(tripInWindow("2026-10-15T16:22:00+0200", thu(15, 51, 59), 30), false);
    assert.equal(tripInWindow("2026-10-15T16:22:00+0200", thu(16, 27), 30), true);
    assert.equal(tripInWindow("2026-10-15T16:22:00+0200", thu(16, 27, 1), 30), false);
    const onceRange = { timeFrom: "16:15", timeTo: "17:30", date: "2026-10-15" };
    assert.equal(oneTimeFinished(onceRange, thu(17, 35), null), false);
    assert.equal(oneTimeFinished(onceRange, thu(17, 35, 1), "2026-10-15T17:20:00+0200"), true);
    assert.equal(shiftClock("08:12", -15), "07:57");
    assert.equal(shiftClock("08:12", 15), "08:27");
    assert.equal(shiftClock("00:05", -30), "00:00");
    assert.equal(shiftClock("23:50", 20), "23:59");
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
    const app = await boot({ base, dataDir, env: { UI_PASSWORD: "", PORT: "0", SCRYPT_N: "1024" }, port: 0 });
    try {
      assert.deepEqual(JSON.parse(readFileSync(app.subsFile, "utf8")), payload);
      writeFileSync(seedFile, "[]");
      const again = await boot({ base, dataDir, env: { UI_PASSWORD: "", PORT: "0", SEED_FILE: seedFile, SCRYPT_N: "1024" }, port: 0 });
      assert.deepEqual(JSON.parse(readFileSync(again.subsFile, "utf8")), payload);
      await again.close();
    } finally { await app.close(); rmSync(base, { recursive: true, force: true }); }
  });

  test("missing seed leaves subscriptions empty and the api closed", async () => {
    const base = tmp();
    const app = await boot({ base, dataDir: path.join(base, "data"), env: { PORT: "0", SCRYPT_N: "1024" }, port: 0 });
    try {
      assert.equal(existsSync(app.subsFile), false);
      const anon = client(app);
      assert.equal((await anon("/api/subs")).status, 401);
      assert.equal((await anon("/healthz")).body.ok, true);
    } finally { await app.close(); rmSync(base, { recursive: true, force: true }); }
  });

  test("accounts, invites, isolation, csrf and settings", async () => {
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
      env: env({ NTFY_SERVER: ntfy.url, NTFY_ALLOW_PRIVATE: "1", NS_API_KEY: "test-key" }),
    });
    try {
      const anon = client(app);
      assert.equal((await anon("/healthz")).body.ok, true);
      const page = await anon("/");
      assert.equal(page.status, 200);
      assert.ok(page.text.includes("NS treinalerts"));
      assert.ok(page.text.includes("Eenmalig"));
      assert.ok(page.text.includes("Dagelijkse check"));
      assert.ok(page.text.includes("Nu checken"));
      assert.ok(page.text.includes("Minuten vóór vertrek"));
      assert.ok(page.text.includes("Vertrek tussen"));
      assert.ok(page.text.includes("Aankomst tussen"));
      assert.ok(page.text.includes("Laatste meldingen"));
      assert.ok(page.text.includes("Nu onderweg"));
      assert.ok(page.text.includes('src="/app.js"'));
      assert.equal((await anon("/api/subs")).status, 401);
      assert.equal((await anon("/.env")).status, 404);
      assert.equal((await anon("/api/subs", { method: "POST", csrf: false, body: "{}" })).status, 403);

      const admin = await login(app);
      const st = await admin("/api/status");
      assert.equal(st.body.key, true);
      assert.equal(st.body.server, ntfy.url);
      assert.equal(st.body.threshold, 3);
      assert.equal(st.body.window_min, 30);
      assert.equal(st.body.range_margin, 15);
      assert.equal(st.body.role, "admin");
      assert.equal(st.body.digest_enabled, true);
      assert.deepEqual(st.body.digest_times, ["06:00", "21:00"]);
      assert.ok(Array.isArray(st.body.alerts));
      assert.ok(Array.isArray(st.body.notifications));
      const fullTopic = st.body.topic;
      assert.match(fullTopic, /^ns-alerts-/);

      const badLogin = client(app);
      await badLogin("/login");
      const unknown = await badLogin("/api/login", { method: "POST", body: JSON.stringify({ username: "niemand", password: "verkeerd1" }) });
      const wrong = await badLogin("/api/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "verkeerd1" }) });
      assert.equal(unknown.status, 401);
      assert.equal(wrong.status, 401);
      assert.equal(unknown.body.error, wrong.body.error);

      const noCsrf = client(app);
      await noCsrf("/login");
      const blocked = await noCsrf("/api/settings", { method: "POST", csrf: false, body: "{}" });
      assert.equal(blocked.status, 403);

      const created = await admin("/api/subs", {
        method: "POST",
        body: JSON.stringify({ from: "ut", fromName: "Utrecht Centraal", to: "asd", toName: "Amsterdam Centraal", time: "08:12", label: "Naar werk", days: ["ma", "di"] }),
      });
      assert.equal(created.status, 200);
      assert.equal(created.body.from, "UT");
      assert.deepEqual(created.body.days, ["ma", "di"]);
      assert.match(created.body.id, /^[0-9a-f]{8}$/);
      const invite = await admin("/api/admin/invites", { method: "POST", body: JSON.stringify({ maxUses: 1 }) });
      assert.equal(invite.status, 200);
      const bobReq = client(app);
      await bobReq("/registreren");
      const bob = await bobReq("/api/register", { method: "POST", body: JSON.stringify({ username: "bob", password: "bob-pass-1", invite: invite.body.code }) });
      assert.equal(bob.status, 200);
      assert.equal((await bobReq("/api/subs")).body.length, 0);
      assert.equal((await bobReq(`/api/subs/${created.body.id}`, { method: "DELETE" })).status, 404);
      const bobStatus = await bobReq("/api/status");
      assert.notEqual(bobStatus.body.topic, fullTopic);
      await bobReq("/api/settings", { method: "POST", body: JSON.stringify({ threshold: 9 }) });
      assert.equal((await admin("/api/status")).body.threshold, 3);
      assert.equal((await bobReq("/api/admin/overview")).status, 403);
      const again = await client(app);
      await again("/registreren");
      assert.equal((await again("/api/register", { method: "POST", body: JSON.stringify({ username: "cara", password: "cara-pass-1", invite: invite.body.code }) })).body.error, "uitnodiging ongeldig");

      const expired = await admin("/api/admin/invites", { method: "POST", body: JSON.stringify({ maxUses: 2, expiresAt: "2020-01-01T00:00:00.000Z" }) });
      const late = client(app);
      await late("/registreren");
      assert.equal((await late("/api/register", { method: "POST", body: JSON.stringify({ username: "laat", password: "laat-pass-1", invite: expired.body.code }) })).body.error, "uitnodiging verlopen");
      assert.equal((await admin(`/api/admin/invites/${encodeURIComponent(expired.body.code)}/revoke`, { method: "POST", body: "{}" })).body.ok, true);

      const overview = await admin("/api/admin/overview");
      const dumped = JSON.stringify(overview.body);
      assert.equal(dumped.includes(fullTopic), false);
      assert.equal(dumped.includes("scrypt$"), false);
      assert.equal(dumped.includes("test-key"), false);
      const adminRow = overview.body.users.find((u) => u.username === "admin");
      assert.equal(adminRow.subs, 1);
      assert.match(adminRow.topic, /…/);
      const used = overview.body.invites.find((i) => i.code === invite.body.code);
      assert.equal(used.used_by[0].username, "bob");
      assert.equal(used.left, 0);

      const sent = await bobReq("/api/test", { method: "POST", body: "{}" });
      assert.equal(sent.status, 200);
      assert.equal(ntfyHits.at(-1).topic, bobStatus.body.topic);
      assert.notEqual(ntfyHits.at(-1).topic, fullTopic);
      const notes = await admin("/api/admin/overview");
      assert.equal(JSON.stringify(notes.body.notifications).includes(bobStatus.body.topic), false);
      assert.ok(notes.body.notifications.some((n) => n.username === "bob" && n.kind === "test"));

      const reset = await admin(`/api/admin/users/${bobStatus.body && app.store.getUserByName("bob").id}/reset`, { method: "POST", body: "{}" });
      assert.equal(reset.body.path, "/wachtwoord");
      assert.equal(JSON.stringify((await admin("/api/admin/overview")).body.audit).includes(reset.body.code), false);
      const fresh = client(app);
      await fresh("/wachtwoord");
      assert.equal((await fresh("/api/reset", { method: "POST", body: JSON.stringify({ code: reset.body.code, password: "bob-pass-2" }) })).body.ok, true);
      assert.equal((await fresh("/api/reset", { method: "POST", body: JSON.stringify({ code: reset.body.code, password: "bob-pass-3" }) })).status, 400);
      const bob2 = await login(app, "bob", "bob-pass-2");
      assert.equal((await bob2("/api/status")).body.username, "bob");
      const oldSid = bob2.jar.sid;
      await bob2("/api/logout", { method: "POST", body: "{}" });
      const bob3 = await login(app, "bob", "bob-pass-2");
      assert.notEqual(bob3.jar.sid, oldSid);
      assert.equal((await bob2("/api/status")).status, 401);

      assert.equal((await admin(`/api/admin/users/${app.store.getUserByName("admin").id}/disable`, { method: "POST", body: "{}" })).status, 400);
      assert.equal((await admin(`/api/admin/users/${app.store.getUserByName("bob").id}`, { method: "DELETE" })).body.ok, true);
      assert.equal(app.store.getUserByName("bob"), null);

      assert.equal((await admin("/api/settings", { method: "POST", body: JSON.stringify({ ntfy_server: "http://user:pass@example.com" }) })).status, 400);
      assert.equal((await admin("/api/settings", { method: "POST", body: JSON.stringify({ window_min: "45", threshold: "4" }) })).body.ok, true);
      const after = await admin("/api/status");
      assert.equal(after.body.window_min, 45);
      assert.equal(after.body.threshold, 4);
    } finally {
      await app.close();
      await new Promise((r) => ntfy.srv.close(r));
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("login rate limit and legacy migration", async () => {
    const base = tmp();
    const dataDir = path.join(base, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, "subscriptions.json"), JSON.stringify([
      { id: "a1b2c3d4", from: "UT", to: "ASD", time: "08:12", days: ["ma"] },
    ]));
    writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ ntfy_topic: "legacy-topic-value", delay_threshold: 4, window_min: 30 }));
    const app = await boot({ base: root, dataDir, port: 0, env: env() });
    try {
      const admin = await login(app);
      const st = await admin("/api/status");
      assert.equal(st.body.topic, "legacy-topic-value");
      assert.equal(st.body.threshold, 4);
      assert.equal((await admin("/api/subs")).body[0].from, "UT");
      const req = client(app);
      await req("/login");
      for (let i = 0; i < 8; i++) {
        const r = await req("/api/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "fout-wacht" }) });
        assert.equal(r.status, 401);
      }
      assert.equal((await req("/api/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "fout-wacht" }) })).status, 429);
    } finally { await app.close(); rmSync(base, { recursive: true, force: true }); }
  });

  test("http api import and settings", async () => {
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
      env: env({ NTFY_TOPIC: "topic-vast", NTFY_SERVER: ntfy.url, NTFY_ALLOW_PRIVATE: "1" }),
    });
    try {
      const admin = await login(app);
      const st = await admin("/api/status");
      assert.equal(st.body.key, false);
      assert.equal(st.body.topic, "topic-vast");
      assert.equal(st.body.window_min, 30);
      assert.equal((await admin("/api/digest", { method: "POST", body: "{}" })).status, 503);
      assert.equal((await admin("/api/stations?q=ut")).status, 503);
      assert.equal((await admin("/api/subs", { method: "POST", body: "{}" })).body.error, "van, naar/treinnummer en tijd verplicht");
      const once = await admin("/api/subs", { method: "POST", body: JSON.stringify({ from: "UT", to: "ASD", time: "09:00", date: "2026-10-20" }) });
      assert.equal(once.body.date, "2026-10-20");
      assert.equal(once.body.days, undefined);
      assert.equal((await admin("/api/subs", { method: "POST", body: JSON.stringify({ from: "UT", to: "ASD", time: "09:00", date: "2026-13-40" }) })).status, 400);
      assert.equal((await admin(`/api/subs/${once.body.id}`, { method: "DELETE" })).body.ok, true);
      const example = JSON.parse(readFileSync(path.join(root, "subs.example.json"), "utf8"));
      assert.equal((await admin("/api/import", { method: "POST", body: JSON.stringify(example) })).body.count, 3);
      const exp = await admin("/api/export");
      assert.equal(exp.body[0].from, "UT");
      assert.equal(exp.body[0].timeFrom, undefined);
      assert.deepEqual(exp.body[1].days, ["ma", "wo"]);
      assert.equal(exp.body[2].timeFrom, "16:15");
      assert.equal(exp.body[2].timeTo, "17:30");
      assert.equal(exp.body[2].when, "depart");
      const dated = await admin("/api/import", { method: "POST", body: JSON.stringify([{ from: "UT", time: "07:00", date: "2026-11-01", to: "ASD" }]) });
      assert.equal(dated.body.count, 1);
      assert.equal((await admin("/api/export")).body[0].date, "2026-11-01");
      assert.equal((await admin("/api/import", { method: "POST", body: "{}" })).status, 400);
      assert.equal((await admin("/api/settings", { method: "POST", body: JSON.stringify({ threshold: 0 }) })).status, 200);
      assert.equal((await admin("/api/status")).body.threshold, 1);
      assert.equal((await admin("/api/test", { method: "POST", body: "{}" })).status, 200);
      assert.equal(ntfyHits[0].topic, "topic-vast");
      assert.equal(ntfyHits[0].priority, 3);
      const qr = await admin("/api/topic/qr");
      assert.equal(qr.status, 200);
      assert.match(qr.headers.get("content-type"), /image\/svg\+xml/);
      assert.ok(qr.text.includes("<svg"));
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
    const app = await boot({ base: root, dataDir, port: 0, env: env() });
    try {
      await app.pollOnce(new Date(2026, 9, 15, 8, 0, 0));
      let ids = app.store.listSubs(app.store.getUserByName("admin").id).map((s) => s.id).sort();
      assert.deepEqual(ids, ["once0001", "week0001"]);
      await app.pollOnce(new Date(2026, 9, 15, 8, 18, 0));
      ids = app.store.listSubs(app.store.getUserByName("admin").id).map((s) => s.id);
      assert.deepEqual(ids, ["week0001"]);
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
      env: env({ NS_API_KEY: "test-key", NTFY_SERVER: "http://127.0.0.1:9", NTFY_TOPIC: "t", NTFY_ALLOW_PRIVATE: "1", DIGEST_ENABLED: "0" }),
    });
    try {
      await app.pollOnce(new Date(2026, 9, 15, 8, 14, 0));
      assert.deepEqual(app.store.listSubs(app.store.getUserByName("admin").id), []);
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
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, "subscriptions.json"), JSON.stringify([
      { id: "route0001", from: "UT", fromName: "Utrecht", to: "ASD", toName: "Amsterdam", time: "08:12", days: ["do"], train: null },
      { id: "train0001", from: "UT", fromName: "Utrecht", to: "", time: "08:12", train: "3014", days: ["do"] },
    ]));
    const app = await boot({
      base: root,
      dataDir,
      port: 0,
      env: env({ NS_API_KEY: "test-key", NTFY_SERVER: ntfy.url, NTFY_TOPIC: "poll-topic", NTFY_ALLOW_PRIVATE: "1", DIGEST_ENABLED: "0" }),
    });
    try {
      await app.pollOnce(new Date(2026, 9, 15, 8, 0, 0));
      const titles = ntfyHits.map((h) => h.title);
      assert.ok(titles.some((t) => t.includes("Utrecht → Amsterdam")));
      assert.ok(ntfyHits.some((h) => h.message.includes("(+7 min)") && h.priority === 4 && h.tags.includes("warning")));
      assert.ok(ntfyHits.some((h) => h.message.includes("Rijdt niet meer") && h.priority === 5 && h.tags.includes("rotating_light")));
      assert.ok(ntfyHits.every((h) => h.click.includes("ns.nl") && h.tags.includes("train")));
      assert.equal(seen.filter((s) => s.url.includes("/api/v3/trips")).length, 1);
      assert.ok(ntfyHits.every((h) => h.topic === "poll-topic"));
      assert.ok(seen.some((s) => s.url.includes("/api/v3/trips") && s.url.includes("fromStation=UT") && s.url.includes("toStation=ASD") && s.url.includes("previousAdvices=1") && s.url.includes("nextAdvices=2") && s.url.includes("dateTime=") && s.key === "test-key"));
      assert.ok(seen.some((s) => s.url.includes("/api/v2/departures") && s.url.includes("station=UT") && s.url.includes("maxJourneys=40")));
      assert.ok(seen.some((s) => s.url.includes("/disruptions/v3") && s.url.includes("isActive=true")));
      const admin = await login(app);
      const found = await admin("/api/stations?q=utrecht");
      assert.equal(found.body[0].code, "UT");
      const state = app.store.readState(app.store.getUserByName("admin").id);
      assert.equal(state["route0001@2026-10-15"].delay, 7);
      assert.ok(state["train0001@2026-10-15"].cancelled);
      const overview = await admin("/api/admin/overview");
      assert.ok(overview.body.system.ns_today >= 1);
      assert.equal(JSON.stringify(overview.body).includes("test-key"), false);
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
      env: env({ NS_API_KEY: "test-key", NTFY_SERVER: ntfy.url, NTFY_TOPIC: "digest-topic", NTFY_ALLOW_PRIVATE: "1" }),
    });
    try {
      const adminUser = () => app.store.getUserByName("admin");
      await assert.rejects(() => app.runDigest(adminUser(), { now: morning, slot: "06:00" }), /HTTP Error 500/);
      assert.deepEqual(app.store.readDigest(adminUser().id).slots, []);
      failNtfy = false;
      const sent = await app.runDigest(adminUser(), { now: morning, slot: "06:00" });
      assert.equal(sent.sent, true);
      assert.equal(sent.count, 4);
      assert.equal(hits[0].topic, "digest-topic");
      assert.equal(hits[0].priority, 4);
      assert.equal(hits[0].title, "⚠️ Storingen vandaag");
      assert.ok(hits[0].message.includes("Staking"));
      assert.ok(hits[0].message.includes("Jouw traject"));
      assert.equal(hits[0].message.includes("Zwolle"), false);
      const saved = app.store.readDigest(adminUser().id);
      assert.ok(saved.slots.includes("2026-10-14 06:00"));
      assert.ok(saved.events["strike-ut"]);
      const again = await app.runDigest(adminUser(), { now: morning, slot: "06:00" });
      assert.equal(again.sent, true);
      assert.equal(again.reason, "herinnering");
      assert.equal(hits[1].title, "⚠️ Niets nieuws — storingen vandaag");
      assert.ok(hits[1].message.includes("Er is niets nieuws — nog steeds:"));
      assert.ok(hits[1].message.includes("Staking"));
      const evening = await app.maybeDigest(new Date("2026-10-14T19:00:00Z"));
      assert.equal(evening.length, 1);
      assert.equal(evening[0].sent, true);
      assert.equal(hits[2].title, "🚧 Storingen morgen");
      assert.ok(hits[2].message.includes("Werkzaamheden: Amsterdam Zuid"));
      assert.deepEqual(await app.maybeDigest(new Date("2026-10-14T19:05:00Z")), []);
      const admin = await login(app);
      const st = await admin("/api/status");
      assert.equal(st.body.last_digest.label, "morgen");
      const bad = await admin("/api/settings", { method: "POST", body: JSON.stringify({ digest_times: "25:00" }) });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /HH:MM/);
      assert.equal((await admin("/api/settings", {
        method: "POST",
        body: JSON.stringify({ digest_times: "7:30, 22:05", digest_enabled: false, digest_quiet: true }),
      })).body.ok, true);
      const after = await admin("/api/status");
      assert.deepEqual(after.body.digest_times, ["07:30", "22:05"]);
      assert.equal(after.body.digest_enabled, false);
      assert.equal(after.body.digest_quiet, true);
      assert.equal(after.body.threshold, 3);
      assert.equal(after.body.window_min, 30);
      assert.deepEqual(await app.maybeDigest(new Date("2026-10-15T05:30:00Z")), []);
      const forced = await admin("/api/digest", { method: "POST", body: "{}" });
      assert.equal(forced.status, 200);
      assert.equal(typeof forced.body.sent, "boolean");
      assert.ok(seen.every((u) => u === "https://gateway.apiportal.ns.nl/disruptions/v3"));
    } finally {
      globalThis.fetch = realFetch;
      await app.close();
      await new Promise((r) => ntfy.srv.close(r));
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("range api keeps a fixed time and can widen it", async () => {
    const base = tmp();
    const dataDir = path.join(base, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, "subscriptions.json"), JSON.stringify([
      { id: "legacyrng", from: "UT", to: "ASD", timeFrom: "16:15", timeTo: "17:30", when: "arrive", days: ["ma"] },
    ]));
    const app = await boot({ base: root, dataDir, port: 0, env: env() });
    try {
      const admin = await login(app);
      const imported = (await admin("/api/subs")).body[0];
      assert.equal(imported.when, "arrive");
      assert.equal(imported.timeFrom, "16:15");
      assert.equal(imported.time, "16:15");
      const created = await admin("/api/subs", {
        method: "POST",
        body: JSON.stringify({ from: "ut", to: "asd", timeFrom: "16:15", timeTo: "17:30", when: "depart", days: ["do"], label: "Naar huis" }),
      });
      assert.equal(created.status, 200);
      assert.equal(created.body.timeFrom, "16:15");
      assert.equal(created.body.timeTo, "17:30");
      assert.equal(created.body.when, "depart");
      assert.equal(created.body.time, "16:15");
      assert.equal((await admin("/api/subs", { method: "POST", body: JSON.stringify({ from: "UT", to: "ASD", timeFrom: "16:15", days: ["do"] }) })).body.error, "van en tot zijn allebei verplicht");
      assert.equal((await admin("/api/subs", { method: "POST", body: JSON.stringify({ from: "UT", to: "ASD", timeFrom: "18:00", timeTo: "16:00", days: ["do"] }) })).body.error, "tot moet later zijn dan van");
      assert.equal((await admin("/api/subs", { method: "POST", body: JSON.stringify({ from: "UT", to: "ASD", timeFrom: "16:15", timeTo: "17:30", train: "1", days: ["do"] }) })).body.error, "treinnummer hoort bij één vertrektijd");
      assert.equal((await admin("/api/subs", { method: "POST", body: JSON.stringify({ from: "UT", to: "ASD", timeFrom: "16:15", timeTo: "17:30", when: "noon", days: ["do"] }) })).body.error, "kies vertrek of aankomst");
      const byArrival = await admin("/api/subs", { method: "POST", body: JSON.stringify({ from: "UT", to: "ASD", timeFrom: "17:10", timeTo: "17:25", arriveBy: true, days: ["do"] }) });
      assert.equal(byArrival.body.when, "arrive");
      const fixed = await admin("/api/subs", { method: "POST", body: JSON.stringify({ from: "UT", to: "ASD", time: "08:12", days: ["do"] }) });
      assert.equal(fixed.body.time, "08:12");
      assert.equal(fixed.body.timeFrom, undefined);
      const widened = await admin(`/api/subs/${fixed.body.id}`, { method: "POST", body: JSON.stringify({ convert: true, margin: 15 }) });
      assert.equal(widened.status, 200);
      assert.equal(widened.body.id, fixed.body.id);
      assert.equal(widened.body.timeFrom, "07:57");
      assert.equal(widened.body.timeTo, "08:27");
      assert.equal(widened.body.when, "depart");
      assert.equal((await admin(`/api/subs/${fixed.body.id}`, { method: "POST", body: JSON.stringify({ convert: true }) })).body.error, "dit is al een bereik");
      const train = await admin("/api/subs", { method: "POST", body: JSON.stringify({ from: "UT", time: "08:12", train: "3014", days: ["do"] }) });
      assert.equal((await admin(`/api/subs/${train.body.id}`, { method: "POST", body: JSON.stringify({ convert: true, margin: 10 }) })).body.error, "een bereik heeft een bestemming nodig");
      const edge = await admin("/api/subs", { method: "POST", body: JSON.stringify({ from: "UT", to: "ASD", time: "23:50", days: ["do"] }) });
      const clamped = await admin(`/api/subs/${edge.body.id}`, { method: "POST", body: JSON.stringify({ convert: true, margin: 30 }) });
      assert.equal(clamped.body.timeFrom, "23:20");
      assert.equal(clamped.body.timeTo, "23:59");
      assert.equal((await admin("/api/settings", { method: "POST", body: JSON.stringify({ range_margin: 20 }) })).body.ok, true);
      assert.equal((await admin("/api/status")).body.range_margin, 20);
      assert.equal((await admin("/api/settings", { method: "POST", body: JSON.stringify({ range_margin: 200 }) })).status, 400);
      assert.equal((await admin("/api/settings", { method: "POST", body: JSON.stringify({ range_margin: -1 }) })).status, 400);
    } finally { await app.close(); rmSync(base, { recursive: true, force: true }); }
  });

  test("old databases gain range columns", () => {
    const base = tmp();
    const file = path.join(base, "old.sqlite");
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
        disabled INTEGER NOT NULL DEFAULT 0, ntfy_topic TEXT NOT NULL, ntfy_server TEXT,
        delay_threshold INTEGER NOT NULL DEFAULT 3, delay_grow INTEGER NOT NULL DEFAULT 5, window_min INTEGER NOT NULL DEFAULT 30,
        digest_enabled INTEGER NOT NULL DEFAULT 1, digest_times TEXT NOT NULL DEFAULT '["06:00","21:00"]', digest_quiet INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, last_login_at TEXT
      );
      CREATE TABLE subscriptions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, from_code TEXT NOT NULL, from_name TEXT, to_code TEXT, to_name TEXT,
        time TEXT NOT NULL, label TEXT, train TEXT, days TEXT, date TEXT
      );
    `);
    raw.prepare("INSERT INTO users (id, username, password_hash, role, ntfy_topic, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("u1", "oud", "x", "user", "topic", "2026-01-01T00:00:00Z");
    raw.prepare("INSERT INTO subscriptions (id, user_id, from_code, to_code, time, days) VALUES (?, ?, ?, ?, ?, ?)").run("fixed001", "u1", "UT", "ASD", "08:12", '["ma"]');
    raw.close();
    const store = openDb(file);
    try {
      assert.equal(store.getUser("u1").range_margin, 15);
      assert.equal(store.getSub("u1", "fixed001").timeFrom, undefined);
      store.insertSub("u1", { id: "range001", from: "UT", to: "ASD", time: "16:15", timeFrom: "16:15", timeTo: "17:30", when: "depart", days: ["ma"] });
      const saved = store.getSub("u1", "range001");
      assert.equal(saved.timeFrom, "16:15");
      assert.equal(saved.timeTo, "17:30");
      assert.equal(saved.when, "depart");
    } finally { store.close(); rmSync(base, { recursive: true, force: true }); }
  });

  test("one-time range is removed after timeTo plus five minutes", async () => {
    const base = tmp();
    const app = await boot({ base: root, dataDir: path.join(base, "data"), port: 0, env: env() });
    try {
      const admin = await login(app);
      await admin("/api/subs", { method: "POST", body: JSON.stringify({ id: "once0002", from: "UT", to: "ASD", timeFrom: "16:15", timeTo: "16:30", date: "2026-10-15" }) });
      await admin("/api/subs", { method: "POST", body: JSON.stringify({ id: "week0002", from: "UT", to: "ASD", timeFrom: "16:15", timeTo: "16:30", days: ["do"] }) });
      await app.pollOnce(new Date(2026, 9, 15, 16, 20, 0));
      assert.deepEqual((await admin("/api/subs")).body.map((s) => s.id).sort(), ["once0002", "week0002"]);
      await app.pollOnce(new Date(2026, 9, 15, 16, 36, 0));
      assert.deepEqual((await admin("/api/subs")).body.map((s) => s.id), ["week0002"]);
    } finally { await app.close(); rmSync(base, { recursive: true, force: true }); }
  });

  test("a departure range monitors each trip and survives a timetable change", async () => {
    const base = tmp();
    const dataDir = path.join(base, "data");
    const baseTrips = JSON.parse(readFileSync(path.join(root, "tests/fixtures/trips_range.json"), "utf8"));
    const changed = JSON.parse(readFileSync(path.join(root, "tests/fixtures/trips_range_changed.json"), "utf8"));
    const track = structuredClone(changed);
    const moved = track.trips.find((t) => (t.legs || []).some((l) => l.product?.number === "3040"));
    moved.legs[0].origin.actualTrack = "12";
    let phase = "base";
    const seen = [];
    const realFetch = globalThis.fetch;
    const disruption = [{
      id: "d-ut", type: "DISRUPTION", title: "Utrecht Centraal - Amsterdam Centraal", isActive: true,
      publicationSections: [{ section: { stations: [{ stationCode: "UT" }, { stationCode: "ASD" }] } }],
    }];
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.startsWith("https://gateway.apiportal.ns.nl")) {
        seen.push(u);
        const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
        if (u.includes("/api/v3/trips")) return json(phase === "base" ? baseTrips : (phase === "changed" ? changed : track));
        if (u.includes("/disruptions/v3")) return json(disruption);
        if (u.includes("/api/v2/stations")) return json({ payload: [] });
        return new Response("missing", { status: 500 });
      }
      return realFetch(url, opts);
    };
    const hits = [];
    const ntfy = await listen((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { hits.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); res.writeHead(200); res.end(); });
    });
    const app = await boot({
      base: root,
      dataDir,
      port: 0,
      env: env({ NS_API_KEY: "test-key", NTFY_SERVER: ntfy.url, NTFY_TOPIC: "range-topic", NTFY_ALLOW_PRIVATE: "1", DIGEST_ENABLED: "0", RANGE_REFRESH_SEC: "0" }),
    });
    try {
      const admin = await login(app);
      assert.equal((await admin("/api/subs", { method: "POST", body: JSON.stringify({ id: "range0001", from: "UT", fromName: "Utrecht", to: "ASD", toName: "Amsterdam", timeFrom: "16:15", timeTo: "17:30", days: ["do"] }) })).status, 200);
      await admin("/api/subs", { method: "POST", body: JSON.stringify({ id: "early0001", from: "UT", to: "ASD", timeFrom: "08:00", timeTo: "08:20", days: ["do"] }) });
      await admin("/api/subs", { method: "POST", body: JSON.stringify({ id: "monday001", from: "HT", to: "ASD", timeFrom: "16:15", timeTo: "17:30", days: ["ma"] }) });
      const userId = app.store.getUserByName("admin").id;
      await app.pollOnce(new Date(2026, 9, 15, 16, 20, 0));
      const titles = hits.map((h) => h.title);
      assert.deepEqual(titles.sort(), ["16:22 Utrecht → Amsterdam", "16:28 Utrecht → Amsterdam"]);
      const cancel = hits.find((h) => h.title.startsWith("16:22"));
      assert.equal(cancel.priority, 5);
      assert.match(cancel.message, /Rijdt niet meer \(was gepland 16:22\)/);
      assert.match(cancel.message, /Alternatief: 16:28 spoor 4; 16:52 spoor 7/);
      assert.match(cancel.message, /Storing: Utrecht Centraal - Amsterdam Centraal/);
      const transfer = hits.find((h) => h.title.startsWith("16:28"));
      assert.match(transfer.message, /^Vertrek 16:28/);
      assert.match(transfer.message, /Aankomst 17:18 → 17:26/);
      assert.equal(transfer.message.includes("Storing:"), false);
      assert.equal(transfer.message.includes("16:18"), false);
      assert.equal(hits.filter((h) => h.message.includes("Storing:")).length, 1);
      assert.ok(hits.every((h) => h.topic === "range-topic"));
      const state = app.store.readState(userId);
      assert.equal(state["range0001@2026-10-15@16:22@3022"].cancelled, true);
      assert.equal(state["range0001@2026-10-15@16:28@5600"].arrivalDelay, 8);
      assert.equal(state["range0001@2026-10-15@16:52@3040"], undefined);
      const tripUrls = seen.filter((u) => u.includes("/api/v3/trips"));
      assert.equal(tripUrls.length, 1);
      const q = new URL(tripUrls[0]).searchParams;
      assert.equal(q.get("fromStation"), "UT");
      assert.equal(q.get("toStation"), "ASD");
      assert.equal(q.get("previousAdvices"), "0");
      assert.equal(q.get("nextAdvices"), "5");
      assert.equal(q.get("searchForArrival"), null);
      assert.match(q.get("dateTime"), /T16:15:00/);
      assert.equal(seen.some((u) => u.includes("fromStation=HT")), false);
      assert.equal(seen.some((u) => u.includes("/api/v2/departures")), false);
      assert.equal(seen.filter((u) => u.includes("/disruptions/v3")).length, 1);
      await app.pollOnce(new Date(2026, 9, 15, 16, 21, 0));
      assert.equal(hits.length, 2);
      phase = "changed";
      await app.pollOnce(new Date(2026, 9, 15, 16, 25, 0));
      assert.equal(hits.length, 3);
      const added = hits[2];
      assert.match(added.title, /^16:40 /);
      assert.match(added.message, /Vertrek 16:40 → 16:51 \(\+11 min\)/);
      assert.match(added.message, /Spoor 3 → 9/);
      assert.match(added.message, /Reden: Later vertrek door een defecte trein/);
      assert.equal(hits.slice(2).some((h) => h.title.includes("16:22") || h.message.includes("16:22")), false);
      const after = app.store.readState(userId);
      assert.equal(after["range0001@2026-10-15@16:40@3060"].delay, 11);
      assert.equal(after["range0001@2026-10-15@16:52@3040"].delay, 0);
      assert.equal(after["range0001@2026-10-15@16:28@5600"].arrivalDelay, 8);
      phase = "track";
      await app.pollOnce(new Date(2026, 9, 15, 16, 26, 0));
      assert.equal(hits.length, 4);
      assert.match(hits[3].title, /^16:52 /);
      assert.match(hits[3].message, /Vertrek 16:52/);
      assert.match(hits[3].message, /Spoor 7 → 12/);
      assert.equal(hits[3].message.includes("16:40"), false);
      await app.pollOnce(new Date(2026, 9, 15, 16, 26, 30));
      assert.equal(hits.length, 4);
    } finally {
      globalThis.fetch = realFetch;
      await app.close();
      await new Promise((r) => ntfy.srv.close(r));
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("arrive-by range uses the final arrival and searchForArrival", async () => {
    const base = tmp();
    const trips = JSON.parse(readFileSync(path.join(root, "tests/fixtures/trips_range.json"), "utf8"));
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith("https://gateway.apiportal.ns.nl")) {
        seen.push(u);
        const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
        if (u.includes("/api/v3/trips")) return json(trips);
        if (u.includes("/disruptions/v3")) return json([]);
        return new Response("missing", { status: 500 });
      }
      return realFetch(url, opts);
    };
    const hits = [];
    const ntfy = await listen((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { hits.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); res.writeHead(200); res.end(); });
    });
    const app = await boot({
      base: root,
      dataDir: path.join(base, "data"),
      port: 0,
      env: env({ NS_API_KEY: "test-key", NTFY_SERVER: ntfy.url, NTFY_ALLOW_PRIVATE: "1", DIGEST_ENABLED: "0", RANGE_REFRESH_SEC: "0" }),
    });
    try {
      const admin = await login(app);
      await admin("/api/subs", { method: "POST", body: JSON.stringify({ id: "arrive001", from: "UT", fromName: "Utrecht", to: "ASD", toName: "Amsterdam", timeFrom: "17:10", timeTo: "17:25", when: "arrive", days: ["do"] }) });
      await app.pollOnce(new Date(2026, 9, 15, 16, 20, 0));
      assert.equal(hits.length, 1);
      assert.match(hits[0].title, /^16:28 /);
      assert.match(hits[0].message, /Aankomst 17:18 → 17:26/);
      assert.equal(hits.some((h) => h.title.includes("16:22")), false);
      const q = new URL(seen.find((u) => u.includes("/api/v3/trips"))).searchParams;
      assert.equal(q.get("searchForArrival"), "true");
      assert.match(q.get("dateTime"), /T17:10:00/);
      assert.equal(seen.filter((u) => u.includes("/api/v3/trips")).length, 1);
    } finally {
      globalThis.fetch = realFetch;
      await app.close();
      await new Promise((r) => ntfy.srv.close(r));
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("range paging stops after four trip pages", async () => {
    const base = tmp();
    const seen = [];
    const realFetch = globalThis.fetch;
    const pad2 = (n) => String(n).padStart(2, "0");
    const plus = (hhmm, mins) => {
      const [h, m] = hhmm.split(":").map(Number);
      const total = h * 60 + m + mins;
      return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
    };
    const all = [];
    for (let i = 0; i < 40; i++) {
      const hhmm = plus("08:00", i * 5);
      all.push({
        status: "NORMAL",
        legs: [{
          cancelled: false,
          product: { number: String(4000 + i) },
          origin: { stationCode: "UT", plannedDateTime: `2026-10-15T${hhmm}:00+0200`, plannedTrack: "1", actualTrack: "1" },
          destination: { stationCode: "ASD", plannedDateTime: `2026-10-15T${plus(hhmm, 20)}:00+0200` },
        }],
      });
    }
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (!u.startsWith("https://gateway.apiportal.ns.nl")) return realFetch(url, opts);
      seen.push(u);
      if (u.includes("/disruptions/v3")) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      if (!u.includes("/api/v3/trips")) return new Response("missing", { status: 500 });
      const clock = new URL(u).searchParams.get("dateTime").slice(11, 16);
      const from = all.findIndex((t) => t.legs[0].origin.plannedDateTime.slice(11, 16) >= clock);
      const trips = from < 0 ? [] : all.slice(from, from + 5);
      return new Response(JSON.stringify({ trips }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const hits = [];
    const ntfy = await listen((req, res) => {
      req.on("data", () => {});
      req.on("end", () => { hits.push(1); res.writeHead(200); res.end(); });
    });
    const app = await boot({
      base: root,
      dataDir: path.join(base, "data"),
      port: 0,
      env: env({ NS_API_KEY: "test-key", NTFY_SERVER: ntfy.url, NTFY_ALLOW_PRIVATE: "1", DIGEST_ENABLED: "0", RANGE_REFRESH_SEC: "0" }),
    });
    try {
      const admin = await login(app);
      await admin("/api/subs", { method: "POST", body: JSON.stringify({ id: "page0001", from: "UT", to: "ASD", timeFrom: "08:00", timeTo: "12:00", days: ["do"] }) });
      await app.pollOnce(new Date(2026, 9, 15, 8, 0, 0));
      const tripUrls = seen.filter((u) => u.includes("/api/v3/trips"));
      assert.equal(tripUrls.length, 4);
      assert.ok(tripUrls.every((u) => new URL(u).searchParams.get("nextAdvices") === "5" && new URL(u).searchParams.get("searchForArrival") == null));
      const keys = Object.keys(app.store.readState(app.store.getUserByName("admin").id)).filter((k) => !k.endsWith("@disruptions"));
      assert.equal(keys.length, 7);
      assert.equal(hits.length, 0);
    } finally {
      globalThis.fetch = realFetch;
      await app.close();
      await new Promise((r) => ntfy.srv.close(r));
      rmSync(base, { recursive: true, force: true });
    }
  });
});
