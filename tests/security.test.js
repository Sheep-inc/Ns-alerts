import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../app.js";
import { isAllowedNotifyUrl, isPrivateAddress } from "../security.js";

const open = [];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
after(async () => { await Promise.all(open.splice(0).map((a) => a.close())); });

function tmp() { return mkdtempSync(path.join(tmpdir(), "ns-sec-")); }

async function boot() {
  const base = tmp();
  const app = createApp({ base: root, dataDir: path.join(base, "data"), port: 0, env: { PORT: "0", UI_PASSWORD: "" } });
  open.push(app);
  await app.start();
  app._base = base;
  return app;
}

test("private and loopback addresses are blocked unless explicitly allowed", async () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("10.1.2.3"), true);
  assert.equal(isPrivateAddress("192.168.1.9"), true);
  assert.equal(isPrivateAddress("172.16.0.1"), true);
  assert.equal(isPrivateAddress("169.254.169.254"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(await isAllowedNotifyUrl("http://127.0.0.1/"), false);
  assert.equal(await isAllowedNotifyUrl("http://127.0.0.1/", { allowPrivate: true }), true);
  assert.equal(await isAllowedNotifyUrl("http://localhost/ns"), false);
  assert.equal(await isAllowedNotifyUrl("http://user:pass@example.com/"), false);
  assert.equal(await isAllowedNotifyUrl("file:///etc/passwd"), false);
  assert.equal(await isAllowedNotifyUrl("http://169.254.169.254/"), false);
});

test("responses carry a strict CSP and oversized or cross-site writes are refused", async () => {
  const app = await boot();
  try {
    const health = await fetch(`http://127.0.0.1:${app.port}/healthz`);
    assert.equal(health.status, 200);
    assert.match(health.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(health.headers.get("content-security-policy").includes("unsafe-inline"), false);
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.equal(health.headers.get("x-frame-options"), "DENY");
    const page = await fetch(`http://127.0.0.1:${app.port}/`);
    const html = await page.text();
    assert.equal(html.includes("<script>"), false);
    assert.ok(html.includes('src="/app.js"'));
    const js = await fetch(`http://127.0.0.1:${app.port}/app.js`);
    assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(js.headers.get("x-content-type-options"), "nosniff");

    const blocked = await fetch(`http://127.0.0.1:${app.port}/api/settings`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(blocked.status, 403);

    const tooBig = await new Promise((resolve) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: app.port,
        path: "/api/settings",
        method: "POST",
        headers: { "content-length": String(2_000_000), "content-type": "application/json" },
      }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.end();
    });
    assert.equal(tooBig, 413);
  } finally {
    await app.close();
    rmSync(app._base, { recursive: true, force: true });
  }
});
