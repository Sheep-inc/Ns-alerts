document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("err");
  err.textContent = "";
  const r = await api("/api/reset", {
    method: "POST",
    body: { code: document.getElementById("code").value, password: document.getElementById("pass").value },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    err.textContent = d.error || "mislukt";
    return;
  }
  document.getElementById("ok").textContent = "Wachtwoord opgeslagen. Je kunt nu inloggen.";
});
