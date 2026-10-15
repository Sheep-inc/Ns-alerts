document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("err");
  err.textContent = "";
  const r = await api("/api/login", {
    method: "POST",
    body: { username: document.getElementById("user").value, password: document.getElementById("pass").value },
  });
  if (r.ok) {
    location.assign("/");
    return;
  }
  const d = await r.json().catch(() => ({}));
  err.textContent = d.error || "inloggen mislukt";
});
