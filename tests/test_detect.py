import json, os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import detect
F = lambda n: json.load(open(os.path.join(os.path.dirname(__file__), "fixtures", n)))
SUB = {"from": "UT", "fromName": "Utrecht", "to": "ASD", "toName": "Amsterdam", "time": "08:12"}

class T(unittest.TestCase):
    def setUp(self):
        self.trip = detect.pick_trip(F("trips.json")["trips"], "08:12")
        self.cur = detect.state_from_trip(self.trip); self.cur["disruptions"] = []
    def test_parse_trip(self):
        self.assertEqual(self.cur["delay"], 7); self.assertEqual(self.cur["track"], "18"); self.assertEqual(self.cur["trainNumber"], "3014")
    def test_first_notification_format(self):
        ev = detect.diff(None, self.cur)
        t, b, p = detect.format_msg(SUB, self.cur, ev)
        self.assertEqual(t, "08:12 Utrecht → Amsterdam"); self.assertIn("+7 min vertraging", b); self.assertIn("spoor 18", b); self.assertEqual(p, "high")
    def test_no_repeat(self):
        self.assertEqual(detect.diff(dict(self.cur), self.cur), [])
    def test_small_growth_ignored_big_growth_notified(self):
        c = dict(self.cur, delay=9); self.assertEqual(detect.diff(self.cur, c), [])
        c = dict(self.cur, delay=13); self.assertIn("+13", detect.diff(self.cur, c)[0][1])
    def test_resolved(self):
        c = dict(self.cur, delay=0); self.assertIn("weer op tijd", detect.diff(self.cur, c)[0][1])
    def test_below_threshold_silent(self):
        on = dict(self.cur, delay=0, track="5"); self.assertEqual(detect.diff(on, dict(on, delay=2)), [])
    def test_cancel_departure(self):
        cur = detect.state_from_departure(F("departures.json")["payload"]["departures"][0])
        ev = detect.diff(None, cur); self.assertIn("geannuleerd", ev[0][1])
        self.assertEqual(detect.format_msg(dict(SUB, train="3014"), cur, ev)[2], "urgent")
    def test_track_change(self):
        prev = dict(self.cur, track="5"); ev = detect.diff(prev, self.cur)
        self.assertTrue(any("spoor 18" in e[1] for e in ev))
    def test_disruptions(self):
        d = detect.relevant_disruptions(F("disruptions.json"), self.cur["stations"])
        self.assertEqual([x["id"] for x in d], ["7_123"])
        c = dict(self.cur, disruptions=d); ev = detect.diff(dict(self.cur), c)
        self.assertIn("storing", ev[0][1])
    def test_alternative(self):
        t = dict(self.trip, status="ALTERNATIVE_TRANSPORT"); c = detect.state_from_trip(t); c["disruptions"] = []
        self.assertTrue(any("vervangend" in e[1] for e in detect.diff(dict(self.cur), c)))


class Live(unittest.TestCase):
    """Fixtures captured from the real NS API on 2026-10-14."""
    def test_live_trip(self):
        tr = F("live_trips.json")["trips"][0]; c = detect.state_from_trip(tr)
        self.assertTrue(c["planned"]); self.assertTrue(c["track"]); self.assertIn("UT", c["stations"])
        self.assertIsNotNone(detect.pick_trip(F("live_trips.json")["trips"], c["planned"][11:16]))
    def test_live_departure(self):
        c = detect.state_from_departure(F("live_departures.json")["payload"]["departures"][0])
        self.assertTrue(c["trainNumber"]); self.assertGreaterEqual(c["delay"], 0)
    def test_live_disruptions(self):
        d = F("live_disruptions.json"); code = d[0]["publicationSections"][0]["section"]["stations"][0]["stationCode"]
        self.assertTrue(detect.relevant_disruptions(d, [code]))
    def test_part_cancelled(self):
        tr = json.loads(json.dumps(F("live_trips.json")["trips"][0])); tr["legs"][0]["partCancelled"] = True
        c = detect.state_from_trip(tr); c["disruptions"] = []
        self.assertTrue(any("deels" in e[1] for e in detect.diff(dict(c, partCancelled=False), c)))
if __name__ == "__main__": unittest.main()
