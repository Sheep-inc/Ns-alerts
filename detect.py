"""Pure change-detection logic (no I/O) — unit tested."""
from datetime import datetime

def _dt(s):
    if not s: return None
    return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")

def _flat(x):
    for i in x or []:
        if isinstance(i, list): yield from _flat(i)
        else: yield i

def delay_min(planned, actual):
    p, a = _dt(planned), _dt(actual)
    if not p or not a: return 0
    return max(0, round((a - p).total_seconds() / 60))

def state_from_trip(trip):
    """trip = element of /api/v3/trips payload['trips']"""
    legs = [l for l in trip.get("legs", []) if l.get("travelType", "PUBLIC_TRANSIT") != "WALK"] or trip.get("legs", [])
    first = legs[0]; o = first.get("origin", {})
    cancelled = trip.get("status") == "CANCELLED" or any(l.get("cancelled") for l in legs)
    alt = trip.get("status") == "ALTERNATIVE_TRANSPORT" or any(l.get("alternativeTransport") for l in legs)
    msgs = [m.get("text") or m.get("message") for m in (trip.get("messages") or [])]
    for l in legs:
        msgs += [m.get("text") or m.get("message") for m in (l.get("messages") or [])]
        # real v3 data: notes (flat list or list of lists); skip plain ATTRIBUTE notes
        for group in (l.get("notes"), (l.get("origin") or {}).get("notes"), (l.get("product") or {}).get("notes")):
            for n in _flat(group):
                if isinstance(n, dict) and n.get("noteType") not in (None, "ATTRIBUTE"):
                    msgs.append(n.get("value"))
    return {
        "planned": o.get("plannedDateTime"),
        "delay": delay_min(o.get("plannedDateTime"), o.get("actualDateTime")),
        "plannedTrack": o.get("plannedTrack"),
        "track": o.get("actualTrack") or o.get("plannedTrack"),
        "cancelled": bool(cancelled),
        "alternative": bool(alt),
        "partCancelled": any(l.get("partCancelled") for l in legs) and not cancelled,
        "changeNotPossible": trip.get("status") == "CHANGE_NOT_POSSIBLE" or any(l.get("changePossible") is False for l in legs[:-1]),
        "trainNumber": (first.get("product") or {}).get("number"),
        "stations": [s for l in legs for s in (l.get("origin", {}).get("stationCode"), l.get("destination", {}).get("stationCode")) if s],
        "messages": sorted(set(filter(None, msgs))),
    }

def state_from_departure(dep):
    """dep = element of /departures payload['departures']"""
    return {
        "planned": dep.get("plannedDateTime"),
        "delay": delay_min(dep.get("plannedDateTime"), dep.get("actualDateTime")),
        "plannedTrack": dep.get("plannedTrack"),
        "track": dep.get("actualTrack") or dep.get("plannedTrack"),
        "cancelled": bool(dep.get("cancelled")) or dep.get("departureStatus") == "CANCELLED",
        "alternative": False, "changeNotPossible": False,
        "trainNumber": (dep.get("product") or {}).get("number") or dep.get("name"),
        "stations": [],
        "messages": sorted(set(filter(None, (m.get("message") for m in dep.get("messages") or [])))),
    }

def pick_trip(trips, hhmm):
    for t in trips:
        legs = t.get("legs") or []
        if legs and (legs[0].get("origin", {}).get("plannedDateTime") or "")[11:16] == hhmm:
            return t
    return None

def relevant_disruptions(disruptions, station_codes):
    codes = {c.upper() for c in station_codes if c}
    out = []
    for d in disruptions or []:
        if d.get("isActive") is False: continue
        found = set()
        for ps in d.get("publicationSections") or []:
            for s in (ps.get("section") or {}).get("stations") or []:
                found.add((s.get("stationCode") or "").upper())
        if found & codes:
            out.append({"id": d.get("id"), "title": d.get("title"), "type": d.get("type")})
    return out

def diff(prev, cur, threshold=3, grow=5):
    """Return list of (priority, text-fragment) events. prev may be None."""
    p = prev or {"delay": 0, "cancelled": False, "track": cur.get("plannedTrack"), "alternative": False, "changeNotPossible": False, "disruptions": []}
    ev = []
    if cur["cancelled"] and not p.get("cancelled"):
        return [("high", "❌ RIJDT NIET (geannuleerd)")]
    if p.get("cancelled") and not cur["cancelled"]:
        ev.append(("default", "✅ rijdt toch weer"))
    if cur["cancelled"]:
        return ev
    d, pd = cur["delay"], p.get("delay", 0)
    if d >= threshold and pd < threshold:
        ev.append(("high", f"⚠️ +{d} min vertraging"))
    elif d >= threshold and abs(d - pd) >= grow:
        ev.append(("high" if d > pd else "default", f"⚠️ vertraging nu +{d} min (was +{pd})"))
    elif d < threshold and pd >= threshold:
        ev.append(("default", "✅ weer op tijd" if d == 0 else f"✅ vertraging opgelost (+{d} min)"))
    if cur.get("track") and p.get("track") and cur["track"] != p["track"]:
        ev.append(("high", f"🔀 spoorwijziging: nu spoor {cur['track']} (was {p['track']})"))
    elif prev is None and cur.get("track") and cur.get("plannedTrack") and cur["track"] != cur["plannedTrack"]:
        ev.append(("high", f"🔀 spoorwijziging: nu spoor {cur['track']} (gepland {cur['plannedTrack']})"))
    if cur.get("alternative") and not p.get("alternative"):
        ev.append(("high", "🚌 vervangend vervoer"))
    if cur.get("partCancelled") and not p.get("partCancelled"):
        ev.append(("high", "⚠️ rijdt deels niet (deel van de rit vervalt)"))
    if cur.get("changeNotPossible") and not p.get("changeNotPossible"):
        ev.append(("high", "⛔ overstap niet mogelijk"))
    old = {x["id"] for x in p.get("disruptions", [])}
    for x in cur.get("disruptions", []):
        if x["id"] not in old:
            ev.append(("default", f"🚧 storing: {x['title']}"))
    return ev

def format_msg(sub, cur, events):
    t = (cur.get("planned") or "")[11:16] or sub.get("time", "")
    route = f"{sub.get('fromName') or sub.get('from')} → {sub.get('toName') or sub.get('to') or ''}".strip(" →")
    if sub.get("train"): route += f" (trein {sub['train']})"
    parts = [e[1] for e in events]
    if cur.get("track") and not cur.get("cancelled") and not any("spoor" in x for x in parts):
        parts.append(f"spoor {cur['track']}")
    prio = "high" if any(e[0] == "high" for e in events) else "default"
    if any("geannuleerd" in x for x in parts): prio = "urgent"
    return f"{t} {route}", ", ".join(parts), prio
