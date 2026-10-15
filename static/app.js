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

async function j(u, o) {
  const r = await fetch(u, o);
  return r.json();
}

let digestRev = 0;
const touchDigest = () => { digestRev++; };
$("digestOn").onchange = touchDigest;
$("digestQuiet").onchange = touchDigest;
$("digestTimes").oninput = touchDigest;

function fillStatus(s) {
  $("st").replaceChildren();
  if (s.key) $("st").append("\u2705 NS API-key aanwezig");
  else $("st").append(el("span", { class: "warn", text: "\u26a0\ufe0f NS_API_KEY missing — zet de key in .env en herstart" }));
  const small = el("small");
  small.append(document.createTextNode("ntfy-topic: "));
  small.append(el("b", { text: s.topic || "" }));
  small.append(document.createTextNode(` (${s.server || ""})`));
  small.append(document.createElement("br"));
  small.append(document.createTextNode(`Laatste poll: ${s.last_poll || "-"} `));
  if (s.error) small.append(el("span", { class: "warn", text: s.error }));
  $("st").append(document.createElement("br"), small);
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
    line.append(el("b", { text: x.time || "" }));
    line.append(document.createTextNode(` ${x.fromName || x.from || ""} \u2192 ${x.toName || x.to || ""}${x.train ? ` (trein ${x.train})` : ""}`));
    const meta = el("small");
    if (x.label) meta.append(document.createTextNode(`${x.label} `));
    if (x.date) {
      meta.append(el("span", { class: "badge", text: "eenmalig" }));
      meta.append(document.createTextNode(` ${x.date}`));
    } else meta.append(document.createTextNode((x.days || []).join(" ")));
    text.append(line, document.createElement("br"), meta);
    const btn = el("button", { type: "button", text: "\u2715" });
    btn.addEventListener("click", () => del(x.id));
    $("subs").append(el("div", { class: x.date ? "sub once" : "sub" }, [text, btn]));
  }
}

async function load() {
  const s = await j("/api/status");
  if (document.activeElement !== $("thr")) $("thr").value = s.threshold;
  if (document.activeElement !== $("win")) $("win").value = s.window_min;
  if (!digestRev) {
    $("digestOn").checked = s.digest_enabled !== false;
    $("digestTimes").value = (s.digest_times || ["06:00", "21:00"]).join(", ");
    $("digestQuiet").checked = !!s.digest_quiet;
  }
  fillStatus(s);
  fillSubs(await j("/api/subs"));
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
      const r = await fetch(`/api/stations?q=${encodeURIComponent(q)}`);
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
  const b = {
    from: code("from"),
    fromName: sel.from?.n,
    to: $("to").value ? code("to") : "",
    toName: sel.to?.n,
    time: $("time").value,
    train: $("train").value.trim(),
    label: $("label").value,
  };
  if ($("once").checked) b.date = $("date").value || todayStr();
  else b.days = [...document.querySelectorAll("#days input:checked")].map((e) => e.value);
  const r = await fetch("/api/subs", { method: "POST", body: JSON.stringify(b) });
  if (!r.ok) alert((await r.json()).error);
  load();
}

async function del(i) {
  if (!/^[0-9a-f]{8}$/.test(String(i || ""))) return;
  if (confirm("Verwijderen?")) {
    await fetch(`/api/subs/${encodeURIComponent(i)}`, { method: "DELETE" });
    load();
  }
}

async function testMsg() {
  const r = await fetch("/api/test", { method: "POST" });
  $("tr").textContent = r.ok ? "\u2705 verstuurd" : "\u274c mislukt";
}

async function saveThr() {
  await fetch("/api/settings", { method: "POST", body: JSON.stringify({ threshold: $("thr").value, window_min: $("win").value }) });
  load();
}

async function saveDigest() {
  const rev = digestRev;
  const r = await fetch("/api/settings", {
    method: "POST",
    body: JSON.stringify({
      digest_enabled: $("digestOn").checked,
      digest_times: $("digestTimes").value,
      digest_quiet: $("digestQuiet").checked,
    }),
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
  const r = await fetch("/api/digest", { method: "POST" });
  const d = await r.json();
  if (!r.ok) $("dr").textContent = `\u274c ${d.error || "mislukt"}`;
  else if (d.sent) $("dr").textContent = "\u2705 verstuurd";
  else $("dr").textContent = d.reason === "ongewijzigd" ? "geen wijziging" : "niets relevants";
}

$("addBtn").addEventListener("click", add);
$("testBtn").addEventListener("click", testMsg);
$("saveThrBtn").addEventListener("click", saveThr);
$("saveDigestBtn").addEventListener("click", saveDigest);
$("checkBtn").addEventListener("click", checkNow);
load();
setInterval(load, 30000);
