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
      assert.equal((await admin("/api/import", { method: "POST", body: JSON.stringify(example) })).body.count, 2);
      const exp = await admin("/api/export");
      assert.equal(exp.body[0].from, "UT");
      assert.deepEqual(exp.body[1].days, ["ma", "wo"]);
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
});
