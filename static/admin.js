const $ = (id) => document.getElementById(id);

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

function btn(text, fn) {
  const b = el("button", { type: "button", text });
  b.addEventListener("click", fn);
  return b;
}

function line(text) {
  return el("div", { text });
}

async function load() {
  const r = await api("/api/admin/overview");
  if (r.status === 403) {
    $("err").textContent = "alleen voor beheerders";
    for (const card of document.querySelectorAll("main .card")) card.hidden = true;
    return;
  }
  if (!r.ok) return;
  const d = await r.json();
  const sys = d.system || {};
  $("system").replaceChildren(
    line(sys.key ? "NS API-key aanwezig" : "NS API-key ontbreekt"),
    line(`Laatste poll: ${sys.last_poll || "-"}`),
    line(`Fout: ${sys.error || "-"}`),
    line(`NS-verzoeken vandaag: ${sys.ns_today ?? 0}`),
    line(`Wachtrij: ${sys.ns_queued ?? 0}`),
    line(`Limiet: ${sys.rate || ""}`),
  );
  $("invites").replaceChildren();
  if (!(d.invites || []).length) $("invites").append(el("small", { text: "Geen codes" }));
  for (const inv of d.invites || []) {
    const box = el("div", { class: "sub" });
    const text = el("div");
    text.append(el("div", { class: "topic", text: inv.code }));
    const who = (inv.used_by || []).map((u) => u.username).join(", ");
    text.append(el("small", { text: `over: ${inv.left} / ${inv.max_uses}${inv.expires_at ? ` · tot ${inv.expires_at}` : ""}${inv.revoked ? " · ingetrokken" : ""}${who ? ` · gebruikt door ${who}` : ""}` }));
    const actions = el("div", { class: "actions" });
    if (!inv.revoked) actions.append(btn("Intrekken", () => act(`/api/admin/invites/${encodeURIComponent(inv.code)}/revoke`)));
    box.append(text, actions);
    $("invites").append(box);
  }
  $("users").replaceChildren();
  for (const u of d.users || []) {
    const box = el("div", { class: "sub" });
    const text = el("div");
    text.append(el("div", {}, [el("b", { text: u.username }), document.createTextNode(` · ${u.role}${u.disabled ? " · uit" : ""}`)]));
    text.append(el("small", { text: `laatste login: ${u.last_login_at || "-"} · abonnementen: ${u.subs} · topic: ${u.topic}` }));
    const actions = el("div", { class: "actions" });
    actions.append(btn(u.disabled ? "Inschakelen" : "Uitschakelen", () => act(`/api/admin/users/${u.id}/${u.disabled ? "enable" : "disable"}`)));
    actions.append(btn("Verwijderen", () => { if (confirm(`Gebruiker ${u.username} verwijderen?`)) act(`/api/admin/users/${u.id}`, "DELETE"); }));
    actions.append(btn("Reset wachtwoord", () => resetUser(u)));
    actions.append(btn("Nu checken", () => act(`/api/admin/users/${u.id}/digest`)));
    actions.append(btn("Testmelding", () => act(`/api/admin/users/${u.id}/test`)));
    box.append(text, actions);
    $("users").append(box);
  }
  $("notes").replaceChildren();
  if (!(d.notifications || []).length) $("notes").append(el("small", { text: "Nog geen meldingen" }));
  for (const n of d.notifications || []) {
    $("notes").append(el("div", { class: "log", text: `${n.created_at || ""} · ${n.username || ""} · ${n.kind || ""} · ${n.title || ""}` }));
  }
  $("digests").replaceChildren();
  if (!(d.digest_runs || []).length) $("digests").append(el("small", { text: "Nog geen checks" }));
  for (const run of d.digest_runs || []) {
    $("digests").append(el("div", { class: "log", text: `${run.created_at || ""} · ${run.username || ""} · ${run.label || ""} · ${run.sent ? "verstuurd" : "niet verstuurd"} · ${run.count}` }));
  }
  $("audit").replaceChildren();
  if (!(d.audit || []).length) $("audit").append(el("small", { text: "Nog geen acties" }));
  for (const a of d.audit || []) {
    $("audit").append(el("div", { class: "log", text: `${a.created_at || ""} · ${a.admin_name || ""} · ${a.action || ""} · ${a.target || ""} ${a.detail || ""}` }));
  }
}

async function act(url, method = "POST") {
  const r = await api(url, { method });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    $("err").textContent = d.error || "mislukt";
    return d;
  }
  $("err").textContent = "";
  await load();
  return d;
}

async function resetUser(u) {
  const d = await act(`/api/admin/users/${u.id}/reset`);
  if (!d || !d.code) return;
  const box = el("div", { class: "warn" });
  box.append(line(`Eenmalige code voor ${u.username}:`));
  box.append(el("div", { class: "topic", text: d.code }));
  box.append(line("Pad: /wachtwoord — de code wordt één keer getoond."));
  $("users").prepend(box);
}

$("inviteBtn").addEventListener("click", async () => {
  const body = { maxUses: Number($("maxUses").value || 1) };
  if ($("expires").value) body.expiresAt = new Date($("expires").value).toISOString();
  const r = await api("/api/admin/invites", { method: "POST", body });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    $("err").textContent = d.error || "mislukt";
    return;
  }
  $("newCode").textContent = d.code || "";
  $("err").textContent = "";
  load();
});

$("logoutBtn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: {} });
  location.assign("/login");
});

load();
