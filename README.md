# NS treinalerts

Pushmeldingen (via ntfy) als je NS-trein vertraagd is, van spoor wisselt, vervangend vervoer heeft of uitvalt.
Alleen Python 3 standaardbibliotheek, geen extra pakketten nodig.

- **Starten/herstarten:** `./run.sh` (log: `data/app.log`)
- **UI:** http://<box>:8780 (abonnementen, stations zoeken, knop 'Test melding', drempel)
- **API-key:** zet `NS_API_KEY=...` in `.env` en draai `./run.sh`. Zonder key draait de UI wel, maar staat de poller stil ("NS_API_KEY missing").
- **ntfy:** het topic staat in `data/config.json` (`ntfy_topic`). Installeer de ntfy-app → "+" → abonneer op dat topic (server ntfy.sh).
- **Config** (`data/config.json`): `delay_threshold` (3), `delay_grow` (5 = nieuwe melding als vertraging ≥5 min verandert), `window_min` (60), `poll_sec` (120).
- **Tests:** `python3 -m unittest discover -s tests -v`

Werking: per actief abonnement (juiste weekdag) wordt van 60 min vóór tot 5 min na vertrek elke 2 min gecheckt
(trips v3 voor routes, departures v2 voor treinnummers, plus disruptions v3; cache + max ~1 req/s).
Alleen bij een *wijziging* komt een melding (incl. "weer op tijd"). Uitval = priority urgent.

## Zelf hosten

1. `git clone` de repo, `cp .env.example .env` en vul `NS_API_KEY` in. Zet bij voorkeur ook `NTFY_TOPIC` (lang en onraadbaar) en `UI_PASSWORD`.
2. **Docker:** `docker compose up -d --build`. Data (config, abonnementen, status) staat in `./data` (volume), herstart automatisch (`unless-stopped`), healthcheck op `/api/status`.
3. **Of systemd:** zet de code in `/opt/ns-alerts`, `sudo cp ns-alerts.service /etc/systemd/system/`, pas `User` aan, dan `sudo systemctl enable --now ns-alerts`.
4. Abonnementen meenemen: oude server `curl -u x:WACHTWOORD http://oud:8780/api/export > subs.json`, nieuwe server `curl -u x:WACHTWOORD -X POST --data-binary @subs.json http://nieuw:8780/api/import`. Voorbeeld: `subs.example.json`.
5. Zet de UI liefst achter een reverse proxy met HTTPS (Caddy/nginx) — basic auth over plain HTTP is niet veilig.

Env: `NS_API_KEY`, `NTFY_TOPIC`, `NTFY_SERVER`, `UI_PASSWORD`, `PORT` (8780), `DATA_DIR` (./data). `/healthz` is altijd zonder wachtwoord bereikbaar.
