/** Per-user storage via better-sqlite3. */
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  disabled INTEGER NOT NULL DEFAULT 0,
  ntfy_topic TEXT NOT NULL,
  ntfy_server TEXT,
  delay_threshold INTEGER NOT NULL DEFAULT 3,
  delay_grow INTEGER NOT NULL DEFAULT 5,
  window_min INTEGER NOT NULL DEFAULT 30,
  range_margin INTEGER NOT NULL DEFAULT 15,
  digest_enabled INTEGER NOT NULL DEFAULT 1,
  digest_times TEXT NOT NULL DEFAULT '["06:00","21:00"]',
  digest_quiet INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invite_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  used_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_code TEXT NOT NULL,
  from_name TEXT,
  to_code TEXT,
  to_name TEXT,
  time TEXT NOT NULL,
  time_from TEXT,
  time_to TEXT,
  when_mode TEXT,
  label TEXT,
  train TEXT,
  days TEXT,
  date TEXT
);
CREATE TABLE IF NOT EXISTS trip_state (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS digest_state (
  user_id TEXT PRIMARY KEY,
  events TEXT NOT NULL,
  slots TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  username TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  priority INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS digest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  username TEXT,
  sent INTEGER NOT NULL,
  count INTEGER NOT NULL,
  reason TEXT,
  label TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT,
  admin_name TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ns_daily (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
`;

function subFromRow(r) {
  if (!r) return null;
  const sub = {
    id: r.id,
    from: r.from_code,
    fromName: r.from_name,
    to: r.to_code || "",
    toName: r.to_name,
    time: r.time,
    label: r.label,
    train: r.train,
  };
  if (r.time_from && r.time_to) {
    sub.timeFrom = r.time_from;
    sub.timeTo = r.time_to;
    sub.when = r.when_mode === "arrive" ? "arrive" : "depart";
  }
  if (r.date) sub.date = r.date;
  else sub.days = JSON.parse(r.days || "[]");
  return sub;
}

function userFromRow(r) {
  if (!r) return null;
  let times = ["06:00", "21:00"];
  try { times = JSON.parse(r.digest_times); } catch { /* keep default */ }
  return {
    id: r.id,
    username: r.username,
    password_hash: r.password_hash,
    role: r.role,
    disabled: Boolean(r.disabled),
    ntfy_topic: r.ntfy_topic,
    ntfy_server: r.ntfy_server || "",
    delay_threshold: r.delay_threshold,
    delay_grow: r.delay_grow,
    window_min: r.window_min,
    range_margin: Number.isFinite(r.range_margin) ? r.range_margin : 15,
    digest_enabled: Boolean(r.digest_enabled),
    digest_times: times,
    digest_quiet: Boolean(r.digest_quiet),
    created_at: r.created_at,
    last_login_at: r.last_login_at,
  };
}

export function openDb(file) {
  const db = new Database(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  const userCols = db.prepare("PRAGMA table_info(users)").all();
  if (!userCols.some((c) => c.name === "range_margin")) db.exec("ALTER TABLE users ADD COLUMN range_margin INTEGER NOT NULL DEFAULT 15");
  const subCols = db.prepare("PRAGMA table_info(subscriptions)").all();
  if (!subCols.some((c) => c.name === "time_from")) db.exec("ALTER TABLE subscriptions ADD COLUMN time_from TEXT");
  if (!subCols.some((c) => c.name === "time_to")) db.exec("ALTER TABLE subscriptions ADD COLUMN time_to TEXT");
  if (!subCols.some((c) => c.name === "when_mode")) db.exec("ALTER TABLE subscriptions ADD COLUMN when_mode TEXT");
  const q = (sql) => db.prepare(sql);

  function meta(k) {
    const row = q("SELECT v FROM meta WHERE k = ?").get(k);
    return row ? row.v : null;
  }
  function metaSet(k, v) {
    q("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, String(v));
  }

  return {
    db,
    meta,
    metaSet,
    close() { db.close(); },
    countUsers() { return q("SELECT COUNT(*) AS n FROM users").get().n; },
    countAdmins() { return q("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n; },
    getUser(id) { return userFromRow(q("SELECT * FROM users WHERE id = ?").get(id)); },
    getUserByName(name) { return userFromRow(q("SELECT * FROM users WHERE username = ?").get(name)); },
    insertUser(u) {
      q(`INSERT INTO users (id, username, password_hash, role, disabled, ntfy_topic, ntfy_server, delay_threshold, delay_grow, window_min, digest_enabled, digest_times, digest_quiet, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        u.id, u.username, u.password_hash, u.role, u.ntfy_topic, u.ntfy_server || null,
        u.delay_threshold, u.delay_grow, u.window_min, u.digest_enabled ? 1 : 0,
        JSON.stringify(u.digest_times), u.digest_quiet ? 1 : 0, u.created_at,
      );
      return this.getUser(u.id);
    },
    setPassword(id, hash) { q("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, id); },
    setDisabled(id, disabled) { q("UPDATE users SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, id); },
    touchLogin(id, at) { q("UPDATE users SET last_login_at = ? WHERE id = ?").run(at, id); },
    updateSettings(id, patch) {
      const cur = this.getUser(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      q(`UPDATE users SET ntfy_topic = ?, ntfy_server = ?, delay_threshold = ?, delay_grow = ?, window_min = ?, range_margin = ?, digest_enabled = ?, digest_times = ?, digest_quiet = ? WHERE id = ?`).run(
        next.ntfy_topic, next.ntfy_server || null, next.delay_threshold, next.delay_grow, next.window_min, next.range_margin ?? 15,
        next.digest_enabled ? 1 : 0, JSON.stringify(next.digest_times), next.digest_quiet ? 1 : 0, id,
      );
      return this.getUser(id);
    },
    deleteUser(id) {
      q("DELETE FROM trip_state WHERE user_id = ?").run(id);
      q("DELETE FROM digest_state WHERE user_id = ?").run(id);
      q("DELETE FROM password_resets WHERE user_id = ?").run(id);
      q("DELETE FROM sessions WHERE user_id = ?").run(id);
      q("DELETE FROM users WHERE id = ?").run(id);
    },
    listUsers() {
      return q(`SELECT u.*, (SELECT COUNT(*) FROM subscriptions s WHERE s.user_id = u.id) AS subs FROM users u ORDER BY username`).all()
        .map((r) => ({ ...userFromRow(r), subs: r.subs }));
    },
    createSession(id, userId, expiresAt) { q("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(id, userId, expiresAt); },
    getSession(id) { return q("SELECT * FROM sessions WHERE id = ?").get(id) || null; },
    deleteSession(id) { q("DELETE FROM sessions WHERE id = ?").run(id); },
    deleteUserSessions(userId) { q("DELETE FROM sessions WHERE user_id = ?").run(userId); },
    createInvite(row) {
      q("INSERT INTO invites (code, max_uses, uses, expires_at, revoked, created_by, created_at) VALUES (?, ?, 0, ?, 0, ?, ?)").run(
        row.code, row.max_uses, row.expires_at, row.created_by, row.created_at,
      );
    },
    listInvites() {
      const uses = q("SELECT code, username, used_at FROM invite_uses ORDER BY id").all();
      return q("SELECT * FROM invites ORDER BY created_at DESC").all().map((inv) => ({
        code: inv.code,
        max_uses: inv.max_uses,
        uses: inv.uses,
        left: Math.max(0, inv.max_uses - inv.uses),
        expires_at: inv.expires_at,
        revoked: Boolean(inv.revoked),
        created_at: inv.created_at,
        used_by: uses.filter((u) => u.code === inv.code).map((u) => ({ username: u.username, used_at: u.used_at })),
      }));
    },
    revokeInvite(code) { return q("UPDATE invites SET revoked = 1 WHERE code = ?").run(code).changes; },
    redeemInvite(code, userId, username, nowIso) {
      db.exec("BEGIN");
      try {
        const inv = q("SELECT * FROM invites WHERE code = ?").get(code);
        if (!inv || inv.revoked || inv.uses >= inv.max_uses) throw new Error("uitnodiging ongeldig");
        if (inv.expires_at && inv.expires_at < nowIso) throw new Error("uitnodiging verlopen");
        q("UPDATE invites SET uses = uses + 1 WHERE code = ?").run(code);
        q("INSERT INTO invite_uses (code, user_id, username, used_at) VALUES (?, ?, ?, ?)").run(code, userId, username, nowIso);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    listSubs(userId) { return q("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY time, rowid").all(userId).map(subFromRow); },
    getSub(userId, id) { return subFromRow(q("SELECT * FROM subscriptions WHERE user_id = ? AND id = ?").get(userId, id)); },
    insertSub(userId, s) {
      q(`INSERT INTO subscriptions (id, user_id, from_code, from_name, to_code, to_name, time, time_from, time_to, when_mode, label, train, days, date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        s.id, userId, s.from, s.fromName || null, s.to || "", s.toName || null, s.time,
        s.timeFrom || null, s.timeTo || null, s.timeFrom ? (s.when === "arrive" ? "arrive" : "depart") : null,
        s.label || null, s.train || null,
        s.date ? null : JSON.stringify(s.days || []), s.date || null,
      );
    },
    updateSub(userId, s) {
      return q(`UPDATE subscriptions SET from_code = ?, from_name = ?, to_code = ?, to_name = ?, time = ?, time_from = ?, time_to = ?, when_mode = ?, label = ?, train = ?, days = ?, date = ?
         WHERE user_id = ? AND id = ?`).run(
        s.from, s.fromName || null, s.to || "", s.toName || null, s.time,
        s.timeFrom || null, s.timeTo || null, s.timeFrom ? (s.when === "arrive" ? "arrive" : "depart") : null,
        s.label || null, s.train || null,
        s.date ? null : JSON.stringify(s.days || []), s.date || null,
        userId, s.id,
      ).changes;
    },
    deleteSub(userId, id) { return q("DELETE FROM subscriptions WHERE user_id = ? AND id = ?").run(userId, id).changes; },
    replaceSubs(userId, list) {
      db.exec("BEGIN");
      try {
        q("DELETE FROM subscriptions WHERE user_id = ?").run(userId);
        for (const s of list) this.insertSub(userId, s);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    readState(userId) {
      const out = {};
      for (const row of q("SELECT key, json FROM trip_state WHERE user_id = ?").all(userId)) out[row.key] = JSON.parse(row.json);
      return out;
    },
    writeState(userId, obj) {
      db.exec("BEGIN");
      try {
        q("DELETE FROM trip_state WHERE user_id = ?").run(userId);
        const ins = q("INSERT INTO trip_state (user_id, key, json) VALUES (?, ?, ?)");
        for (const [k, v] of Object.entries(obj)) ins.run(userId, k, JSON.stringify(v));
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    readDigest(userId) {
      const row = q("SELECT events, slots FROM digest_state WHERE user_id = ?").get(userId);
      if (!row) return { events: {}, slots: [] };
      return { events: JSON.parse(row.events || "{}"), slots: JSON.parse(row.slots || "[]") };
    },
    writeDigest(userId, events, slots) {
      q("INSERT INTO digest_state (user_id, events, slots) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET events = excluded.events, slots = excluded.slots")
        .run(userId, JSON.stringify(events), JSON.stringify(slots));
    },
    addNotification(row) {
      q("INSERT INTO notifications (user_id, username, kind, title, body, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        row.user_id, row.username, row.kind, row.title, String(row.body || "").slice(0, 400), row.priority ?? null, row.created_at,
      );
      q("DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY id DESC LIMIT 200)").run();
    },
    recentNotifications(limit = 40) {
      return q("SELECT username, kind, title, body, priority, created_at FROM notifications ORDER BY id DESC LIMIT ?").all(limit);
    },
    recentNotificationsForUser(userId, limit = 40) {
      return q("SELECT kind, title, body, priority, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, limit);
    },
    addDigestRun(row) {
      q("INSERT INTO digest_runs (user_id, username, sent, count, reason, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        row.user_id, row.username, row.sent ? 1 : 0, row.count, row.reason || null, row.label || null, row.created_at,
      );
    },
    recentDigestRuns(limit = 20) {
      return q("SELECT username, sent, count, reason, label, created_at FROM digest_runs ORDER BY id DESC LIMIT ?").all(limit)
        .map((r) => ({ ...r, sent: Boolean(r.sent) }));
    },
    audit(row) {
      q("INSERT INTO audit (admin_id, admin_name, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        row.admin_id, row.admin_name, row.action, row.target || null, row.detail || null, row.created_at,
      );
    },
    recentAudit(limit = 40) {
      return q("SELECT admin_name, action, target, detail, created_at FROM audit ORDER BY id DESC LIMIT ?").all(limit);
    },
    createReset(row) {
      q("INSERT INTO password_resets (id, user_id, code_hash, expires_at, used) VALUES (?, ?, ?, ?, 0)").run(row.id, row.user_id, row.code_hash, row.expires_at);
    },
    takeReset(codeHash, nowMs) {
      db.exec("BEGIN");
      try {
        const row = q("SELECT * FROM password_resets WHERE code_hash = ? AND used = 0").get(codeHash);
        if (!row || row.expires_at < nowMs) {
          db.exec("ROLLBACK");
          return null;
        }
        q("UPDATE password_resets SET used = 1 WHERE id = ?").run(row.id);
        db.exec("COMMIT");
        return row.user_id;
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    addNsCount(day) {
      q("INSERT INTO ns_daily (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1").run(day);
    },
    nsCount(day) {
      return q("SELECT count FROM ns_daily WHERE day = ?").get(day)?.count || 0;
    },
  };
}
