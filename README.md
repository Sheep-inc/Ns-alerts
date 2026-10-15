# NS treinalerts

Pushmeldingen (via ntfy) als je NS-trein vertraagd is, van spoor wisselt, vervangend vervoer heeft of uitvalt.
Elke gebruiker heeft een eigen account, eigen abonnementen en een eigen ntfy-topic.
Node.js 22 of nieuwer (`node:sqlite`, start met `--experimental-sqlite`).

- **Starten/herstarten:** `./run.sh` (log: `data/app.log`)
- **UI:** http://<box>:8780 — inloggen, registreren met uitnodiging, abonnementen, ntfy-topic met QR, drempel, dagelijkse check. Beheerders: `/beheer`.
- **API-key:** zet `NS_API_KEY=...` in `.env` en draai `./run.sh`. Zonder key draait de UI wel, maar staat de poller stil ("NS_API_KEY missing"). Dezelfde key geldt voor iedereen; identieke NS-verzoeken worden gedeeld (cache, max ~1 req/s).
- **Eerste beheerder:** `ADMIN_USERNAME` en `ADMIN_PASSWORD` worden alleen gebruikt als de database nog leeg is. Daarna maakt de beheerder uitnodigingscodes (eenmalig of N keer, optioneel met vervaldatum).
- **ntfy:** elke gebruiker ziet een eigen topic, een kopieerknop, een abonneer-link en een QR-code. "Nieuw topic" maakt een ander topic. Een eigen ntfy-server mag alleen `http` of `https` zijn; privé-adressen alleen met `NTFY_ALLOW_PRIVATE=1`.
- **Bestaande installatie:** bij de eerste start met een beheerder worden `data/subscriptions.json`, `data/config.json`, `data/state.json` en `data/digest.json` één keer in het account van de beheerder gezet. `NTFY_TOPIC` wint van het topic in `config.json`. Daarna is `data/app.sqlite` de bron. `UI_PASSWORD` doet niets meer.
- **Instellingen per gebruiker:** `delay_threshold` (3), `delay_grow` (5), `window_min` (30, minuten vóór vertrek), `digest_enabled`, `digest_times` (`06:00` en `21:00`, Europe/Amsterdam), `digest_quiet` (uit). De poll-interval blijft globaal (`POLL_SEC`, standaard 120).
- **Dagelijkse check:** op de tijden van die gebruiker één ntfy-melding als er iets relevants is. Ochtend (vóór 12:00) kijkt naar vandaag, avond naar morgen. Landelijk: type `CALAMITY`, tekst met staking/strike, impact ≥ 3 (of level high), of 12 of meer stations. Daarnaast storingen en werkzaamheden (`DISRUPTION` / `MAINTENANCE`) op stations van de eigen abonnementen die die dag actief zijn. Calamiteit of staking krijgt priority high. Niets relevants → geen melding, tenzij `digest_quiet` aan staat. In de UI: tijden, aan/uit, en 'Nu checken'.
- **Beheer:** gebruikers (status, laatste login, aantal abonnementen, gemaskeerd topic), uitnodigingen (restgebruik, vervaldatum, wie ze gebruikte), systeem (NS-key aanwezig, laatste poll, fout, NS-verzoeken vandaag, wachtrij), laatste meldingen, storingschecks, auditlog. Acties: code maken of intrekken, gebruiker uit- of aanzetten, verwijderen, eenmalige wachtwoordcode, 'Nu checken', testmelding.
- **Tests:** `npm test` — **Lint:** `npm run lint`
- **Seed:** als `data/subscriptions.json` nog niet bestaat en `seed/subscriptions.json` wél, wordt dat bestand gekopieerd en daarna geïmporteerd zodra er een beheerder is. `seed/*.json` staat in `.gitignore`, behalve `seed/subscriptions.example.json`.
- **Eenmalig:** vink 'Eenmalig' aan en kies een datum (`date`, `JJJJ-MM-DD`). Het abonnement wordt alleen die dag gevolgd en verdwijnt na het venster (vertrek + 5 min, of zodra de trein is aangekomen).

Werking: per actief abonnement van een actieve gebruiker wordt van `window_min` vóór tot 5 min na vertrek gecheckt
(trips v3 voor routes, departures v2 voor treinnummers, plus disruptions v3).
Alleen bij een wijziging komt een melding, en alleen naar het topic van die gebruiker.

## Zelf hosten

1. Node.js 22+ op de VPS. `git clone` de repo, `npm ci --omit=dev`, `cp .env.example .env`. Vul `NS_API_KEY`, `ADMIN_USERNAME` en `ADMIN_PASSWORD` in.
2. Abonnementen klaarzetten (optioneel): `cp seed/subscriptions.example.json seed/subscriptions.json` en pas aan. Ontbreekt `data/subscriptions.json`, dan wordt de seed gekopieerd. Met een beheerder gaat die lijst naar dat account.
3. **Docker:** `docker compose up -d --build`. De database staat in `./data` (volume). `./seed` is read-only. De container draait als gebruiker `node` (uid 1000) met een read-only rootfs; `./data` moet voor die gebruiker beschrijfbaar zijn (`sudo chown -R 1000:1000 data`). Healthcheck op `/healthz`.
4. **Of systemd:** code in `/opt/ns-alerts`, `sudo cp ns-alerts.service /etc/systemd/system/`, pas `User` aan, `sudo systemctl enable --now ns-alerts`. Node 22+ als `/usr/bin/node`.
5. Abonnementen meenemen tussen servers: ingelogd `curl -b cookies.txt http://oud:8780/api/export > subs.json` en op de nieuwe server `curl -b cookies.txt -X POST -H 'x-csrf-token: …' --data-binary @subs.json http://nieuw:8780/api/import`. Voorbeeld: `subs.example.json`.
6. Zet de UI achter een reverse proxy met HTTPS en zet `COOKIE_SECURE=1`. Zie `SECURITY.md`.

`/healthz` is zonder sessie bereikbaar. Overige API-routes eisen een sessiecookie (`HttpOnly`, `SameSite=Lax`) en op schrijfacties een CSRF-token (`x-csrf-token`, gelijk aan het `csrf`-cookie).
