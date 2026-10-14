"""NS treinalerts — single process, stdlib only. UI on :8780 + background poller + ntfy push."""
import gzip, json, os, secrets, threading, time, urllib.request, urllib.parse, logging, sys
from datetime import datetime, timedelta
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import detect

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("DATA_DIR") or os.path.join(BASE, "data"); os.makedirs(DATA, exist_ok=True)
CFG_F, SUBS_F, STATE_F = (os.path.join(DATA, f) for f in ("config.json", "subscriptions.json", "state.json"))
NS = "https://gateway.apiportal.ns.nl"
PORT = int(os.environ.get("PORT", 8780))
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ns")
lock = threading.Lock()

def load_env():
    p = os.path.join(BASE, ".env")
    if os.path.exists(p):
        for line in open(p):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip().strip('"\''))
def api_key(): return os.environ.get("NS_API_KEY", "").strip()

def rj(path, default):
    try: return json.load(open(path))
    except Exception: return default
def wj(path, obj):
    tmp = path + ".tmp"; json.dump(obj, open(tmp, "w"), indent=2, ensure_ascii=False); os.replace(tmp, path)

def config():
    c = rj(CFG_F, {})
    changed = False
    for k, v in {"ntfy_server": "https://ntfy.sh", "ntfy_topic": "ns-alerts-" + secrets.token_urlsafe(18).replace("_", "").replace("-", "").lower()[:22],
                 "delay_threshold": 3, "delay_grow": 5, "window_min": 60, "poll_sec": 120}.items():
        if k not in c: c[k] = v; changed = True
    if changed: wj(CFG_F, c)
    if os.environ.get("NTFY_TOPIC"): c["ntfy_topic"] = os.environ["NTFY_TOPIC"].strip()
    if os.environ.get("NTFY_SERVER"): c["ntfy_server"] = os.environ["NTFY_SERVER"].strip()
    return c

# ---------- NS API with cache + simple rate limit ----------
_cache, _last_call = {}, [0.0]
class NoKey(Exception): pass
def ns_get(path, params=None, ttl=90):
    key = api_key()
    if not key: raise NoKey("NS_API_KEY missing")
    url = NS + path + ("?" + urllib.parse.urlencode(params) if params else "")
    hit = _cache.get(url)
    if hit and time.time() - hit[0] < ttl: return hit[1]
    wait = 1.0 - (time.time() - _last_call[0])  # max ~1 req/s
    if wait > 0: time.sleep(wait)
    _last_call[0] = time.time()
    req = urllib.request.Request(url, headers={"Ocp-Apim-Subscription-Key": key, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        raw = r.read()
    if raw[:2] == b"\x1f\x8b": raw = gzip.decompress(raw)  # disruptions v3 answers gzipped
    data = json.loads(raw)
    _cache[url] = (time.time(), data)
    if len(_cache) > 500: _cache.clear()
    return data

_stations = []
def stations():
    global _stations
    if not _stations:
        d = ns_get("/reisinformatie-api/api/v2/stations", ttl=86400)
        _stations = [{"code": s.get("code"), "name": (s.get("namen") or {}).get("lang"), "land": s.get("land")} for s in d.get("payload", [])]
    return _stations

def ntfy(title, body, prio="default", tags=""):
    c = config()
    # ntfy accepts UTF-8 headers poorly; use JSON publish instead
    payload = json.dumps({"topic": c["ntfy_topic"], "title": title, "message": body, "priority": {"min":1,"low":2,"default":3,"high":4,"urgent":5}.get(prio,3)}).encode()
    req = urllib.request.Request(c["ntfy_server"].rstrip("/") + "/", data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r: return r.status

# ---------- poller ----------
status = {"last_poll": None, "error": None}
DAYS = ["ma", "di", "wo", "do", "vr", "za", "zo"]
def active_window(sub, now, window):
    if DAYS[now.weekday()] not in sub.get("days", DAYS): return None
    h, m = map(int, sub["time"].split(":"))
    dep = now.replace(hour=h, minute=m, second=0, microsecond=0)
    if dep - timedelta(minutes=window) <= now <= dep + timedelta(minutes=5): return dep
    return None

def check_sub(sub, dep, cfg):
    if sub.get("train"):
        d = ns_get("/reisinformatie-api/api/v2/departures", {"station": sub["from"], "maxJourneys": 40})
        deps = (d.get("payload") or {}).get("departures", [])
        m = [x for x in deps if str((x.get("product") or {}).get("number")) == str(sub["train"])]
        if not m: return None
        cur = detect.state_from_departure(m[0]); cur["stations"] = [sub["from"]]
    else:
        d = ns_get("/reisinformatie-api/api/v3/trips", {"fromStation": sub["from"], "toStation": sub["to"],
                   "dateTime": dep.astimezone().isoformat(timespec="seconds"),
                   "previousAdvices": 1, "nextAdvices": 2})
        t = detect.pick_trip(d.get("trips", []), sub["time"])
        if not t: return None
        cur = detect.state_from_trip(t)
    stns = set(cur["stations"]) | {sub["from"], sub.get("to")}
    try:
        dis = ns_get("/disruptions/v3", {"isActive": "true"}, ttl=300)
        cur["disruptions"] = detect.relevant_disruptions(dis if isinstance(dis, list) else dis.get("payload", []), stns)
    except NoKey: raise
    except Exception as e:
        log.warning("disruptions failed: %s", e); cur["disruptions"] = []
    return cur

def poll_once(now=None):
    cfg = config(); now = now or datetime.now()
    if not api_key():
        status.update(error="NS_API_KEY missing", last_poll=now.isoformat(timespec="seconds")); return
    subs = rj(SUBS_F, []); st = rj(STATE_F, {})
    today = now.strftime("%Y-%m-%d")
    for sub in subs:
        dep = active_window(sub, now, cfg["window_min"])
        if not dep: continue
        k = f"{sub['id']}@{today}"
        try:
            cur = check_sub(sub, dep, cfg)
        except Exception as e:
            log.warning("check %s failed: %s", sub["id"], e); status["error"] = str(e); continue
        if not cur: continue
        ev = detect.diff(st.get(k), cur, cfg["delay_threshold"], cfg["delay_grow"])
        st[k] = cur
        if ev:
            title, body, prio = detect.format_msg(sub, cur, ev)
            log.info("NOTIFY %s: %s", title, body)
            try: ntfy(title, body, prio)
            except Exception as e: log.warning("ntfy failed: %s", e)
    st = {k: v for k, v in st.items() if k.endswith(today)}
    wj(STATE_F, st)
    status.update(error=None, last_poll=now.isoformat(timespec="seconds"))

def poller():
    while True:
        try: poll_once()
        except Exception as e: log.exception("poll"); status["error"] = str(e)
        time.sleep(config()["poll_sec"])

# ---------- web ----------
import base64, hmac
def authorized(h):
    pw = os.environ.get("UI_PASSWORD", "")
    if not pw: return True
    a = h.headers.get("Authorization", "")
    if not a.startswith("Basic "): return False
    try: given = base64.b64decode(a[6:]).decode().split(":", 1)[-1]
    except Exception: return False
    return hmac.compare_digest(given, pw)

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def handle_one_request(self):
        try: super().handle_one_request()
        except Exception: pass
    def parse_request(self):
        if not super().parse_request(): return False
        if self.path.split("?")[0] == "/healthz" or authorized(self): return True
        self.send_response(401); self.send_header("WWW-Authenticate", 'Basic realm="NS treinalerts"'); self.send_header("Content-Length", "0"); self.end_headers()
        return False
    def send(self, code, obj, ctype="application/json"):
        b = obj.encode() if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", ctype + "; charset=utf-8"); self.send_header("Content-Length", len(b)); self.end_headers(); self.wfile.write(b)
    def body(self):
        n = int(self.headers.get("Content-Length", 0)); return json.loads(self.rfile.read(n) or b"{}")
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if u.path == "/": return self.send(200, open(os.path.join(BASE, "static", "index.html")).read(), "text/html")
        if u.path == "/healthz": return self.send(200, {"ok": True})
        if u.path in ("/api/subs", "/api/export"): return self.send(200, rj(SUBS_F, []))
        if u.path == "/api/status":
            c = config(); return self.send(200, {"key": bool(api_key()), "topic": c["ntfy_topic"], "server": c["ntfy_server"], "threshold": c["delay_threshold"], **status})
        if u.path == "/api/stations":
            term = (q.get("q", [""])[0]).lower()
            try: res = [s for s in stations() if term in (s["name"] or "").lower() or term == (s["code"] or "").lower()][:10]
            except NoKey: return self.send(503, {"error": "NS_API_KEY missing"})
            except Exception as e: return self.send(502, {"error": str(e)})
            return self.send(200, res)
        self.send(404, {"error": "not found"})
    def do_POST(self):
        if self.path == "/api/subs":
            b = self.body()
            if not b.get("from") or not (b.get("to") or b.get("train")) or not b.get("time"): return self.send(400, {"error": "van, naar/treinnummer en tijd verplicht"})
            sub = {k: b.get(k) for k in ("from", "fromName", "to", "toName", "time", "label", "train")}
            sub["from"] = sub["from"].upper(); sub["to"] = (sub["to"] or "").upper()
            sub["days"] = b.get("days") or DAYS[:5]; sub["id"] = secrets.token_hex(4)
            with lock: s = rj(SUBS_F, []); s.append(sub); wj(SUBS_F, s)
            return self.send(200, sub)
        if self.path == "/api/import":
            b = self.body()
            if not isinstance(b, list) or not all(isinstance(x, dict) and x.get("from") and x.get("time") for x in b): return self.send(400, {"error": "ongeldige lijst"})
            for x in b: x.setdefault("id", secrets.token_hex(4)); x.setdefault("days", DAYS[:5])
            with lock: wj(SUBS_F, b)
            return self.send(200, {"ok": True, "count": len(b)})
        if self.path == "/api/test":
            try: ntfy("🚆 Test melding", "NS treinalerts werkt! Je ontvangt hier meldingen bij vertraging, spoorwijziging of uitval.")
            except Exception as e: return self.send(502, {"error": str(e)})
            return self.send(200, {"ok": True})
        if self.path == "/api/settings":
            b = self.body(); c = config()
            if "threshold" in b: c["delay_threshold"] = max(1, int(b["threshold"]))
            wj(CFG_F, c); return self.send(200, {"ok": True})
        self.send(404, {"error": "not found"})
    def do_DELETE(self):
        if self.path.startswith("/api/subs/"):
            i = self.path.rsplit("/", 1)[1]
            with lock: wj(SUBS_F, [s for s in rj(SUBS_F, []) if s["id"] != i])
            return self.send(200, {"ok": True})
        self.send(404, {})

if __name__ == "__main__":
    load_env(); c = config()
    log.info("ntfy topic: %s/%s", c["ntfy_server"], c["ntfy_topic"])
    if not api_key(): log.warning("NS_API_KEY missing — UI draait, poller staat stil tot de key er is (zet in .env en herstart)")
    threading.Thread(target=poller, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
