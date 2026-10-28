import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../app.js";
import { openDb } from "../db.js";
import { parseArgs, runMigration } from "../scripts/migrate.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "tests/fixtures/legacy");
const script = path.join(root, "scripts/migrate.js");

function stage() {
  const dir = mkdtempSync(path.join(tmpdir(), "ns-migrate-"));
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

function read(dir, name) {
  return JSON.parse(readFileSync(path.join(dir, name), "utf8"));
}

describe("migrate old json", () => {
  test("parseArgs accepts dry-run, data-dir and a margin", () => {
    assert.equal(parseArgs(["--dry-run", "--data-dir", "data"], {}).dryRun, true);
    assert.equal(parseArgs(["--data-dir=./data", "--to-range"], {}).margin, 15);
    assert.equal(parseArgs(["--to-range=0"], {}).margin, 0);
    assert.match(parseArgs(["--to-range=200"], {}).error, /0 tot 180/);
    assert.match(parseArgs(["--to-range="], {}).error, /0 tot 180/);
    assert.match(parseArgs(["--nope"], {}).error, /onbekend argument/);
  });

  test("dry-run prints a Dutch summary and does not touch the files", async () => {
    const dir = stage();
    const before = readFileSync(path.join(dir, "subscriptions.json"));
    const result = await runMigration({ dataDir: dir, dryRun: true });
    assert.equal(result.ok, true);
    assert.match(result.text, /proefdraai/);
    assert.match(result.text, /Er is niets geschreven/);
    assert.match(result.text, /07:24/);
    assert.match(result.text, /dagen ma–vr aangevuld/);
    assert.match(result.text, /window_min/);
    assert.match(result.text, /verwijderd/);
    assert.equal(readFileSync(path.join(dir, "subscriptions.json")).equals(before), true);
    assert.equal(read(dir, "config.json").window_min, undefined);
  });

  test("upgrades fixed times, fills config and prunes stale state", async () => {
    const dir = stage();
    const result = await runMigration({ dataDir: dir, now: new Date("2026-10-28T06:52:00.123Z") });
    assert.equal(result.ok, true, result.text);
    assert.match(result.text, /Controle gelukt/);
    assert.match(result.backup, /20261028T065200123$/);
    const subs = read(dir, "subscriptions.json");
    assert.equal(subs[0].from, "UT");
    assert.equal(subs[0].to, "ASD");
    assert.equal(subs[0].time, "07:24");
    assert.equal(subs[0].timeFrom, undefined);
    assert.deepEqual(subs[0].days, ["ma", "di", "wo", "do", "vr"]);
    assert.match(subs[0].id, /^[0-9a-f]{8}$/);
    assert.equal(subs[1].train, "3014");
    assert.equal(subs[1].timeFrom, undefined);
    assert.equal(subs[2].timeFrom, "16:15");
    assert.equal(subs[2].when, "depart");
    const cfg = read(dir, "config.json");
    assert.equal(cfg.delay_threshold, 4);
    assert.equal(cfg.ntfy_topic, "legacy-topic-value");
    assert.equal(cfg.extra_note, "bewaren");
    assert.equal(cfg.window_min, 30);
    assert.equal(cfg.range_margin, 15);
    assert.deepEqual(cfg.digest_times, ["06:00", "21:00"]);
    const state = read(dir, "state.json");
    assert.deepEqual(Object.keys(state).sort(), [
      "b9c0d1e2@2026-10-15@16:22@3022",
      "b9c0d1e2@2026-10-15@disruptions",
      "e5f60718@2026-10-15",
      "werk0001@2026-10-15",
    ]);
    assert.equal(state["werk0001@2026-10-15"].delay, 4);
    assert.equal(state.junk, undefined);
    const again = await runMigration({ dataDir: dir });
    assert.equal(again.ok, true, again.text);
    assert.equal(again.changed, false);
    assert.match(again.text, /Niets te wijzigen/);
    assert.equal(again.backup, undefined);
  });

  test("to-range converts routes once and drops state that would no longer match", async () => {
    const dir = stage();
    const result = await runMigration({ dataDir: dir, toRange: true, margin: 15 });
    assert.equal(result.ok, true, result.text);
    const subs = read(dir, "subscriptions.json");
    const home = subs.find((s) => s.label === "Naar werk");
    assert.equal(home.timeFrom, "07:09");
    assert.equal(home.timeTo, "07:39");
    assert.equal(home.when, "depart");
    assert.equal(home.time, "07:09");
    const office = subs.find((s) => s.id === "werk0001");
    assert.equal(office.timeFrom, "07:57");
    assert.equal(office.timeTo, "08:27");
    const train = subs.find((s) => s.train === "3014");
    assert.equal(train.time, "08:12");
    assert.equal(train.timeFrom, undefined);
    assert.match(result.text, /blijft een vaste tijd/);
    const state = read(dir, "state.json");
    assert.equal(state["werk0001@2026-10-15"], undefined);
    assert.equal(state["e5f60718@2026-10-15"].delay, 7);
    assert.ok(state["b9c0d1e2@2026-10-15@16:22@3022"]);
    const second = await runMigration({ dataDir: dir, toRange: true, margin: 15 });
    assert.equal(second.changed, false, second.text);
    assert.equal(read(dir, "subscriptions.json").find((s) => s.id === "werk0001").timeFrom, "07:57");
  });

  test("a bad subscription or margin fails before anything is written", async () => {
    const dir = stage();
    const original = readFileSync(path.join(dir, "subscriptions.json"));
    writeFileSync(path.join(dir, "subscriptions.json"), JSON.stringify([{ from: "UT", time: "25:99" }]));
    const bad = await runMigration({ dataDir: dir, toRange: true });
    assert.equal(bad.ok, false);
    assert.match(bad.text, /Afgebroken/);
    assert.match(bad.text, /niets gewijzigd/i);
    assert.equal(read(dir, "config.json").window_min, undefined);
    writeFileSync(path.join(dir, "subscriptions.json"), original);
    const margin = await runMigration({ dataDir: dir, toRange: true, margin: 200 });
    assert.equal(margin.ok, false);
    assert.match(margin.text, /0 en 180|0 tot 180|marge/);
  });

  test("validation failure restores the backup", async () => {
    const dir = stage();
    writeFileSync(path.join(dir, "note.txt"), "bewaar-mij");
    const beforeSubs = readFileSync(path.join(dir, "subscriptions.json"));
    const beforeCfg = readFileSync(path.join(dir, "config.json"));
    const result = await runMigration({
      dataDir: dir,
      now: new Date("2026-10-28T07:00:00.000Z"),
      validate: () => { throw new Error("controle mislukt expres"); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.restored, true);
    assert.match(result.text, /Backup teruggezet/);
    assert.equal(readFileSync(path.join(dir, "subscriptions.json")).equals(beforeSubs), true);
    assert.equal(readFileSync(path.join(dir, "config.json")).equals(beforeCfg), true);
    assert.equal(readFileSync(path.join(dir, "note.txt"), "utf8"), "bewaar-mij");
    assert.match(readFileSync(path.join(dir, "backups/20261028T070000000/subscriptions.json"), "utf8"), /7:24/);
  });

  test("sqlite fixed times become ranges and stale state is cleared", async () => {
    const dir = stage();
    const store = openDb(path.join(dir, "app.sqlite"));
    store.insertUser({
      id: "u1",
      username: "admin",
      password_hash: "x",
      role: "admin",
      ntfy_topic: "t",
      delay_threshold: 3,
      delay_grow: 5,
      window_min: 45,
      digest_enabled: true,
      digest_times: ["06:00", "21:00"],
      digest_quiet: false,
      created_at: "2026-10-01T00:00:00.000Z",
    });
    store.insertSub("u1", { id: "werk0001", from: "UT", to: "ASD", time: "08:12", days: ["ma", "di", "wo", "do", "vr"], label: "Naar kantoor" });
    store.writeState("u1", { "werk0001@2026-10-15": { delay: 4, cancelled: false } });
    store.close();
    const result = await runMigration({ dataDir: dir, toRange: true, margin: 10 });
    assert.equal(result.ok, true, result.text);
    assert.match(result.text, /Database:/);
    const again = openDb(path.join(dir, "app.sqlite"));
    const sub = again.getSub("u1", "werk0001");
    assert.equal(sub.timeFrom, "08:02");
    assert.equal(sub.timeTo, "08:22");
    assert.equal(sub.when, "depart");
    assert.equal(again.getUser("u1").window_min, 45);
    assert.deepEqual(again.readState("u1"), {});
    again.close();
    const second = await runMigration({ dataDir: dir, toRange: true, margin: 10 });
    assert.equal(second.changed, false, second.text);
  });

  test("the app imports the migrated files", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ns-migrate-app-"));
    const dir = path.join(base, "data");
    mkdirSync(dir);
    cpSync(fixture, dir, { recursive: true });
    const migrated = await runMigration({ dataDir: dir });
    assert.equal(migrated.ok, true, migrated.text);
    const app = createApp({
      poll: false,
      base: root,
      dataDir: dir,
      port: 0,
      env: { PORT: "0", ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "admin-pass-1", SCRYPT_N: "1024" },
    });
    await app.start();
    try {
      const user = app.store.getUserByName("admin");
      assert.equal(user.delay_threshold, 4);
      assert.equal(user.window_min, 30);
      assert.equal(user.ntfy_topic, "legacy-topic-value");
      const subs = app.store.listSubs(user.id);
      assert.equal(subs.find((s) => s.label === "Naar werk").time, "07:24");
      assert.equal(subs.find((s) => s.train === "3014").timeFrom, undefined);
      const state = app.store.readState(user.id);
      assert.equal(state["werk0001@2026-10-15"].delay, 4);
      assert.equal(state["gone9999@2026-10-15"], undefined);
    } finally {
      await app.close();
    }
  });

  test("cli dry-run and a rejected margin exit with the right codes", () => {
    const dir = stage();
    const ok = spawnSync(process.execPath, [script, "--dry-run", "--data-dir", dir], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr || ok.stdout);
    assert.match(ok.stdout, /proefdraai/);
    assert.match(ok.stdout, /Er is niets geschreven/);
    const bad = spawnSync(process.execPath, [script, "--to-range=999", "--data-dir", dir], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /0 tot 180/);
    const missing = spawnSync(process.execPath, [script, "--data-dir", path.join(dir, "nope")], { encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /datamap bestaat niet/);
  });
});
