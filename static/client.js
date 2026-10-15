function readCsrf() {
  const m = document.cookie.match(/(?:^|; )csrf=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : "";
}

async function api(url, opts = {}) {
  const options = { ...opts, headers: { ...(opts.headers || {}) } };
  const method = String(options.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") options.headers["x-csrf-token"] = readCsrf();
  if (options.body && typeof options.body !== "string") {
    options.headers["content-type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(url, options);
  if (res.status === 401 && !url.endsWith("/api/login") && !url.endsWith("/api/register") && !url.endsWith("/api/reset")) {
    location.assign("/login");
  }
  return res;
}
