# NS treinalerts

Pushmeldingen (via ntfy) als je NS-trein vertraagd is, van spoor wisselt, vervangend vervoer heeft of uitvalt.
Node.js 20 of nieuwer (LTS), alleen de standaardbibliotheek — geen extra npm-pakketten.

- **Starten/herstarten:** `./run.sh` (log: `data/app.log`)
- **UI:** http://<box>:8780 (abonnementen, stations zoeken, knop 'Test melding', drempel)
- **API-key:** zet `NS_API_KEY=...` in `.env` en draai `./run.sh`. Zonder key draait de UI wel, maar staat de poller stil ("NS_API_KEY missing").
- **ntfy:** het topic staat in `data/config.json` (`ntfy_topic`). Installeer de ntfy-app → "+" → abonneer op dat topic (server ntfy.sh).
- **Config** (`data/config.json`): `delay_threshold` (3), `delay_grow` (5 = nieuwe melding als vertraging ≥5 min verandert), `window_min` (30, minuten vóór vertrek; aan te passen in de UI), `poll_sec` (120), `digest_enabled` (aan), `digest_times` (`06:00` en `21:00`, Europe/Amsterdam), `digest_quiet` (uit).
- **Dagelijkse check:** op die tijden één ntfy-melding als er iets relevants is. Ochtend (vóór 12:00) kijkt naar vandaag, avond naar morgen. Landelijk: type `CALAMITY`, tekst met staking/strike, impact ≥ 3 (of level high), of 12 of meer stations. Daarnaast storingen en werkzaamheden (`DISRUPTION` / `MAINTENANCE`) op stations van abonnementen die die dag actief zijn, als de geldigheidsperiode die dag overlapt. Calamiteit of staking krijgt priority high. Niets relevants → geen melding, tenzij `digest_quiet` aan staat ('Alles rustig'). Dezelfde storing komt niet opnieuw in de volgende check, tenzij die is gewijzigd. In de UI: tijden, aan/uit, en 'Nu checken' (werkt ook als de check uit staat).
- **Tests:** `npm test`
- **Seed:** bij de eerste start, als `data/subscriptions.json` nog niet bestaat en `seed/subscriptions.json` wél, wordt dat bestand gekopieerd. Standaardpad `./seed/subscriptions.json` (naast de app), overschrijfbaar met `SEED_FILE`. `seed/*.json` staat in `.gitignore`, behalve `seed/subscriptions.example.json`.
- **Eenmalig:** vink 'Eenmalig' aan en kies een datum (`date`, `JJJJ-MM-DD`, standaard vandaag). Het abonnement wordt alleen die dag gevolgd en verdwijnt vanzelf na het venster (vertrek + 5 min, of zodra de trein is aangekomen). Abonnementen met alleen `days` blijven werken.

Werking: per actief abonnement (juiste weekdag, of de gekozen datum) wordt van 30 min vóór tot 5 min na vertrek elke 2 min gecheckt
(trips v3 voor routes, departures v2 voor treinnummers, plus disruptions v3; cache + max ~1 req/s).
Disruptions-antwoorden mogen gzip zijn. Trip-teksten komen uit `messages` en uit geneste `notes`-lijsten (`noteType` anders dan `ATTRIBUTE`). `partCancelled` geeft een melding dat de rit deels vervalt.
Alleen bij een *wijziging* komt een melding (incl. "weer op tijd"). Uitval = priority urgent.

## Zelf hosten

1. Node.js 20+ op de VPS. `git clone` de repo, `cp .env.example .env` en vul `NS_API_KEY` in. Zet bij voorkeur ook `NTFY_TOPIC` (lang en onraadbaar) en `UI_PASSWORD`.
2. Abonnementen klaarzetten (optioneel): `cp seed/subscriptions.example.json seed/subscriptions.json` en pas aan. Ontbreekt `data/subscriptions.json` bij het opstarten, dan wordt de seed byte-voor-byte gekopieerd. Bestaat het databestand al, dan blijft het staan — verwijder het om opnieuw te seeden. Het formaat is hetzelfde als `data/subscriptions.json` (en als `/api/export`), zodat bestaande abonnementen meteen meegaan.
3. **Docker:** `docker compose up -d --build`. Data (config, abonnementen, status) staat in `./data` (volume). `./seed` is read-only gemount. Herstart automatisch (`unless-stopped`), healthcheck op `/api/status`.
4. **Of systemd:** zet de code in `/opt/ns-alerts`, `sudo cp ns-alerts.service /etc/systemd/system/`, pas `User` aan, dan `sudo systemctl enable --now ns-alerts`. Node moet als `/usr/bin/node` beschikbaar zijn (20+).
5. Abonnementen meenemen: oude server `curl -u x:WACHTWOORD http://oud:8780/api/export > subs.json`, nieuwe server `curl -u x:WACHTWOORD -X POST --data-binary @subs.json http://nieuw:8780/api/import`. Voorbeeld: `subs.example.json`.
6. Zet de UI liefst achter een reverse proxy met HTTPS (Caddy/nginx) — basic auth over plain HTTP is niet veilig.

Env: `NS_API_KEY`, `NTFY_TOPIC`, `NTFY_SERVER`, `UI_PASSWORD`, `PORT` (8780), `DATA_DIR` (./data), `SEED_FILE` (./seed/subscriptions.json), `DIGEST_TIMES` (bijv. `06:00,21:00`), `DIGEST_ENABLED` (`1`/`0`), `DIGEST_QUIET` (`1`/`0`). De digest-variabelen overschrijven `data/config.json`. `/healthz` is altijd zonder wachtwoord bereikbaar.
