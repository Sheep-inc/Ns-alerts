const D = ["ma", "di", "wo", "do", "vr", "za", "zo"];
const sel = { from: null, to: null };
const $ = (i) => document.getElementById(i);
const pad = (n) => String(n).padStart(2, "0");
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v == null ? "" : String(v);
    else node.setAttribute(k, v);
  }
  for (const child of children || []) node.append(child);
  return node;
}

$("date").value = todayStr();
function syncMode() {
  const train = $("train").value.trim();
  const arrive = $("arrive").checked;
  $("rangeLbl").hidden = Boolean(train);
  $("rangeRow").hidden = Boolean(train);
  $("arriveRow").hidden = Boolean(train);
  $("rangeHint").hidden = Boolean(train);
  $("time").hidden = $("timeLbl").hidden = !train;
  $("rangeLbl").textContent = arrive ? "Aankomst tussen" : "Vertrek tussen";
}
$("arrive").onchange = syncMode;
$("train").oninput = syncMode;
$("once").onchange = () => {
  const on = $("once").checked;
  $("date").hidden = $("dateLbl").hidden = !on;
  $("days").hidden = $("daysLbl").hidden = on;
};
for (let i = 0; i < D.length; i++) {
  const input = el("input", { type: "checkbox", value: D[i] });
  if (i < 5) input.checked = true;
  $("days").append(el("label", {}, [input, document.createTextNode(` ${D[i]}`)]));
}

let digestRev = 0;
let serverDirty = 0;
$("ntfyServer").oninput = () => { serverDirty += 1; };
const touchDigest = () => { digestRev++; };
$("digestOn").onchange = touchDigest;
$("digestQuiet").onchange = touchDigest;
$("digestTimes").oninput = touchDigest;

function fillStatus(s) {
  $("st").replaceChildren();
  if (s.key) $("st").append("\u2705 NS API-key aanwezig");
  else $("st").append(el("span", { class: "warn", text: "\u26a0\ufe0f NS_API_KEY missing — zet de key in .env en herstart" }));
  const small = el("small");
  small.append(document.createTextNode(`Laatste poll: ${s.last_poll || "-"} `));
  if (s.error) small.append(el("span", { class: "warn", text: s.error }));
  $("st").append(document.createElement("br"), small);
  $("who").textContent = s.username ? s.username : "";
  $("adminLink").hidden = s.role !== "admin";
  const topic = s.topic || "";
  const server = s.server || "";
  $("topicText").textContent = topic;
  $("topicLink").href = topic && server ? `${server}/${topic}` : "";
  if (document.activeElement !== $("ntfyServer") && !serverDirty) $("ntfyServer").value = s.server && s.server !== "https://ntfy.sh" ? s.server : "";
  if (topic) $("topicQr").src = `/api/topic/qr?t=${encodeURIComponent(topic)}`;
}

function fillSubs(subs) {
  $("subs").replaceChildren();
  if (!subs.length) {
    $("subs").append(el("small", { text: "Nog geen abonnementen" }));
    return;
  }
  for (const x of subs) {
    const text = el("div");
    const line = el("div");
    const span = x.timeFrom && x.timeTo ? `${x.timeFrom}\u2013${x.timeTo}` : (x.time || "");
    line.append(el("b", { text: `${x.when === "arrive" ? "aankomst " : ""}${span}` }));
    line.append(document.createTextNode(` ${x.fromName || x.from || ""} \u2192 ${x.toName || x.to || ""}${x.train ? ` (trein ${x.train})` : ""}`));
    const meta = el("small");
    if (x.label) meta.append(document.createTextNode(`${x.label} `));
    if (x.date) {
      meta.append(el("span", { class: "badge", text: "eenmalig" }));
      meta.append(document.createTextNode(` ${x.date}`));
    } else meta.append(document.createTextNode((x.days || []).join(" ")));
    text.append(line, document.createElement("br"), meta);
    const actions = el("div", { class: "actions" });
    if (!x.timeFrom && x.to) {
      const conv = el("button", { type: "button", class: "link", text: "Bereik" });
      conv.addEventListener("click", () => toRange(x.id, x.time || ""));
      actions.append(conv);
    }
    const btn = el("button", { type: "button", text: "\u2715" });
    btn.addEventListener("click", () => del(x.id));
    actions.append(btn);
    $("subs").append(el("div", { class: x.date ? "sub once" : "sub" }, [text, actions]));
  }
}

async function load() {
  const statusRes = await api("/api/status");
  if (!statusRes.ok) return;
  const s = await statusRes.json();
    if (document.activeElement !== $("thr")) $("thr").value = s.threshold;
    if (document.activeElement !== $("win")) $("win").value = s.window_min;
    if (document.activeElement !== $("margin")) $("margin").value = s.range_margin ?? 15;
  if (!digestRev) {
    $("digestOn").checked = s.digest_enabled !== false;
    $("digestTimes").value = (s.digest_times || ["06:00", "21:00"]).join(", ");
    $("digestQuiet").checked = !!s.digest_quiet;
  }
  fillStatus(s);
  fillAlerts(s.alerts || []);
  fillNotes(s.notifications || []);
  const subsRes = await api("/api/subs");
  if (subsRes.ok) fillSubs(await subsRes.json());
}

function fillAlerts(alerts) {
  $("alerts").replaceChildren();
  if (!alerts.length) {
    $("alerts").append(el("small", { text: "Nog geen abonnementen om te volgen. Voeg er hieronder een toe." }));
    return;
  }
  for (const a of alerts) {
    const box = el("div", { class: `sub alert ${a.status || "idle"}` });
    const text = el("div");
    text.append(el("div", { text: a.label || "" }));
    const bits = [];
    if (a.status === "cancelled") bits.push("Rijdt niet");
    else if (a.status === "alternative") bits.push("Vervangend vervoer");
    else if (a.status === "delayed") bits.push(`+${a.delay} min`);
    else if (a.status === "ok") bits.push("Op tijd");
    else if (a.watching) bits.push("Wordt nu gevolgd");
    else bits.push("Buiten venster");
    if (a.departure) bits.push(`vertrek ${a.departure}`);
    if (a.track) bits.push(`spoor ${a.track}`);
    text.append(el("small", { text: bits.join(" · ") }));
    if ((a.messages || []).length) text.append(el("small", { text: a.messages.join(" · ") }));
    box.append(text);
    $("alerts").append(box);
  }
}

function fillNotes(notes) {
  $("notes").replaceChildren();
  if (!notes.length) {
    $("notes").append(el("small", { text: "Nog geen meldingen. Die komen hier (en in ntfy) als iets wijzigt." }));
    return;
  }
  for (const n of notes) {
    const when = (n.created_at || "").replace("T", " ").slice(0, 16);
    $("notes").append(el("div", { class: "log", text: `${when} · ${n.title || ""}${n.body ? ` — ${n.body}` : ""}` }));
  }
}

function search(f) {
  let t;
  $(f).oninput = () => {
    sel[f] = null;
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = $(f).value;
      const box = $(`s${f}`);
      box.replaceChildren();
      if (q.length < 2) return;
      const r = await api(`/api/stations?q=${encodeURIComponent(q)}`);
      const d = await r.json();
      if (!r.ok) {
        box.append(el("div", {}, [el("small", { text: `Zoeken niet mogelijk (${d.error}); typ de stationscode, bv. UT` })]));
        return;
      }
      for (const s of d) {
        const row = el("div");
        row.append(document.createTextNode(s.name || ""), " ", el("small", { text: s.code || "" }));
        row.addEventListener("click", () => pick(f, s.code, s.name || ""));
        box.append(row);
      }
    }, 300);
  };
}

function pick(f, c, n) {
  sel[f] = { c, n };
  $(f).value = `${n} (${c})`;
  $(`s${f}`).replaceChildren();
}
search("from");
search("to");

const code = (f) => (sel[f] ? sel[f].c : $(f).value.trim().toUpperCase());

async function add() {
  const train = $("train").value.trim();
  const b = {
    from: code("from"),
    fromName: sel.from?.n,
    to: $("to").value ? code("to") : "",
    toName: sel.to?.n,
    label: $("label").value,
  };
  if (train) {
    b.train = train;
    b.time = $("time").value;
  } else {
    b.timeFrom = $("timeFrom").value;
    b.timeTo = $("timeTo").value;
    b.when = $("arrive").checked ? "arrive" : "depart";
  }
  if ($("once").checked) b.date = $("date").value || todayStr();
  else b.days = [...document.querySelectorAll("#days input:checked")].map((e) => e.value);
  const r = await api("/api/subs", { method: "POST", body: b });
  if (!r.ok) alert((await r.json()).error);
  load();
}

async function toRange(id, time) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(String(id || ""))) return;
  const margin = Number($("margin").value);
  const m = Number.isFinite(margin) ? margin : 15;
  if (!confirm(`Vast tijdstip ${time} omzetten naar een bereik van \u00b1${m} minuten?`)) return;
  const r = await api(`/api/subs/${encodeURIComponent(id)}`, { method: "POST", body: { convert: true, margin: m } });
  if (!r.ok) alert((await r.json()).error);
  load();
}

async function del(i) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(String(i || ""))) return;
  if (confirm("Verwijderen?")) {
    await api(`/api/subs/${encodeURIComponent(i)}`, { method: "DELETE" });
    load();
  }
}

async function testMsg() {
  const r = await api("/api/test", { method: "POST", body: {} });
  $("tr").textContent = r.ok ? "\u2705 verstuurd" : "\u274c mislukt";
}

async function saveThr() {
  await api("/api/settings", { method: "POST", body: { threshold: $("thr").value, window_min: $("win").value, range_margin: $("margin").value } });
  load();
}

async function saveDigest() {
  const rev = digestRev;
  const r = await api("/api/settings", {
    method: "POST",
    body: {
      digest_enabled: $("digestOn").checked,
      digest_times: $("digestTimes").value,
      digest_quiet: $("digestQuiet").checked,
    },
  });
  if (!r.ok) {
    $("dr").textContent = `\u274c ${(await r.json()).error}`;
    return;
  }
  if (digestRev === rev) digestRev = 0;
  $("dr").textContent = "\u2705 opgeslagen";
  load();
}

async function checkNow() {
  const r = await api("/api/digest", { method: "POST", body: {} });
  const d = await r.json();
  if (!r.ok) $("dr").textContent = `\u274c ${d.error || "mislukt"}`;
  else if (d.sent) $("dr").textContent = "\u2705 verstuurd";
  else $("dr").textContent = d.reason === "herinnering" ? "herinnering verstuurd" : "niets relevants";
}

async function copyTopic() {
  const text = $("topicText").textContent;
  try {
    await navigator.clipboard.writeText(text);
    $("copyMsg").textContent = "gekopieerd";
  } catch {
    $("copyMsg").textContent = "kopieer het topic handmatig";
  }
}

async function regenTopic() {
  if (!confirm("Nieuw topic? Het oude stopt met meldingen.")) return;
  const r = await api("/api/topic", { method: "POST", body: {} });
  if (!r.ok) {
    $("copyMsg").textContent = "mislukt";
    return;
  }
  $("copyMsg").textContent = "nieuw topic";
  load();
}

async function saveServer() {
  const rev = serverDirty;
  const r = await api("/api/settings", { method: "POST", body: { ntfy_server: $("ntfyServer").value } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    $("copyMsg").textContent = d.error || "server geweigerd";
    return;
  }
  if (serverDirty === rev) serverDirty = 0;
  $("copyMsg").textContent = "server opgeslagen";
  load();
}

async function logout() {
  await api("/api/logout", { method: "POST", body: {} });
  location.assign("/login");
}

$("copyBtn").addEventListener("click", copyTopic);
$("regenBtn").addEventListener("click", regenTopic);
$("saveServerBtn").addEventListener("click", saveServer);
$("logoutBtn").addEventListener("click", logout);
$("addBtn").addEventListener("click", add);
$("testBtn").addEventListener("click", testMsg);
$("saveThrBtn").addEventListener("click", saveThr);
$("saveDigestBtn").addEventListener("click", saveDigest);
$("checkBtn").addEventListener("click", checkNow);
load();
setInterval(load, 30000);
