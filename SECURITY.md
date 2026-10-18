# Beveiliging

Twee varianten van dezelfde app:

- **Eén gebruiker** — branch `cursor/import-ns-alerts-3ca6`, pull request #1. Basic auth (`UI_PASSWORD`), JSON-bestanden, geen accounts.
- **Meerdere gebruikers** — branch `cursor/multi-user-accounts-3ca6`. Deze tak bevat de fixes van #1 en vervangt basic auth door accounts, SQLite en een beheerpagina.

## Uitgevoerd

- Handmatige review van de server, detectie, digest, UI, Docker en systemd, op beide varianten.
- `npm audit` (single-user: alleen devDependencies; multi-user: runtime-dependency `qrcode`).
- `eslint` met `eslint-plugin-security` (`npm run lint`). `detect-object-injection` en `detect-non-literal-fs-filename` staan uit na review: sleutels zijn vast of al gevalideerd, bestandsnamen zijn `path.join` van de datamap of een vaste lijst statische bestanden.
- `tests/security.test.js`: privé-adressen, CSP, bodylimiet (413 vóór authenticatie), cross-site writes.
- Multi-user tests: isolatie van abonnementen en topics, CSRF, login-limiet, eenmalige resetcode, gemaskeerd beheeroverzicht, geen NS-key of wachtwoordhash in dat overzicht.

## Bevindingen en fixes (één gebruiker, PR #1)

| Onderwerp | Bevinding | Fix |
| --- | --- | --- |
| XSS | Abonnementen, stationsnamen en foutteksten gingen via `innerHTML`, inclusief `onclick` met een id. | DOM met `textContent`. Script en CSS in `/app.js` en `/app.css`. |
| CSP | Geen security headers; inline script. | Strikte CSP (`script-src 'self'`, geen `unsafe-inline`), `nosniff`, `DENY` frames, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP. |
| CSRF | Basic auth wordt door de browser herhaald. | `POST`/`DELETE` met `Sec-Fetch-Site: cross-site` of een afwijkende `Origin` krijgt 403. |
| Brute force | `UI_PASSWORD` had geen limiet. | 20 mislukte pogingen per IP per 15 minuten → 429. Vergelijken met `timingSafeEqual`. |
| Body | `Content-Length` werd niet begrensd. | Maximaal 1 MB, anders 413. |
| SSRF | `ntfy_server` werd ongecontroleerd opgehaald, inclusief redirects. | Alleen `http(s)`, geen userinfo, DNS-check op privé/loopback/link-local, redirects geweigerd. Privé alleen met `NTFY_ALLOW_PRIVATE=1`. |
| Logging | Het volledige ntfy-topic stond in de log. | Topic wordt gemaskeerd. 500-antwoorden zijn generiek. |
| Docker | Root, beschrijfbare rootfs, healthcheck zette het wachtwoord in het procesargument. | Gebruiker `node`, `read_only`, `cap_drop: ALL`, `no-new-privileges`, healthcheck op `/healthz`. systemd: `NoNewPrivileges`, `ProtectSystem=strict`. |
| Path | Statische bestanden uit een vaste lijst. Verwijder-id moest 8 hex tekens zijn. | Geen user-pad in `path.join`. |

## Bevindingen en fixes (meerdere gebruikers)

| Onderwerp | Bevinding | Fix |
| --- | --- | --- |
| Wachtwoorden | Basic auth is herhaalbaar en deelt één geheim. | scrypt (`N=16384`, salt in de hash). Zelfde fouttekst voor onbekende gebruiker en fout wachtwoord; een dummy-hash houdt de tijd vergelijkbaar. |
| Sessie | Een door de client gekozen sessie-id is fixatie. | Nieuw `sid` bij elke login (`HttpOnly`, `SameSite=Lax`), oude sessies van die gebruiker worden verwijderd. Cookie `Secure` met `COOKIE_SECURE=1`. |
| CSRF | Een ingelogde browser kan een cross-site POST meedoen als alleen de cookie telt. | Double-submit: cookie `csrf` (niet HttpOnly) moet gelijk zijn aan `x-csrf-token` (`timingSafeEqual`), plus de Origin/`Sec-Fetch-Site`-check van #1. |
| Brute force | Login en registratie zijn raadbaar. | 8 mislukte logins per IP per 10 minuten, daarna 429 zonder nieuwe poging. Registratie: 20 per 15 minuten. |
| XSS | NS-teksten en gebruikersnamen komen in de UI en in het beheer. | Alleen `textContent` / DOM. Geen inline script. Zelfde CSP. |
| SSRF | Elke gebruiker kan een ntfy-server opgeven. | Zelfde `isAllowedNotifyUrl` bij opslaan, bij migratie en bij verzenden. Ongeldige waarden worden niet als link getoond. |
| Geheimen | Beheer ziet alle gebruikers. | Topic in het overzicht is gemaskeerd. Geen wachtwoordhash, geen resetcode in de auditlog (alleen een sha256 van de code), geen NS-key in JSON of logs. Meldingenlog bewaart geen topic. |
| Reset | Een resetlink mag niet blijven werken. | 24 uur, één keer, daarna zijn sessies ongeldig. |
| Injectie | Gebruikersinvoer komt in SQL en in paden. | Alleen prepared statements. Abonnement-id: letters, cijfers, `_` en `-`, max 32. Stationscode, tijd en gebruikersnaam hebben een vast patroon. |
| Path | Een verzoek als `/.env` mag geen bestand buiten `static/` lezen. | Alleen een vaste lijst (`index.html`, `app.js`, `app.css`, de login/beheer-pagina's). Al het andere buiten `/api/` is 404. |
| Body | Grote login-body's. | 1 MB wordt geweigerd vóór de sessiecheck (413). |
| Docker | `qrcode` is een runtime-dependency. | `npm ci --omit=dev` in de image, daarna `USER node`. Geen secrets in de image. Database alleen op het volume `/app/data`. Rootfs blijft read-only in Compose. |
| sqlite | Database op schijf. | `better-sqlite3` (prepared statements). Bestand alleen onder `DATA_DIR`. |

`npm audit` rapporteert geen bekende kwetsbaarheden. `npm run lint` geeft geen waarschuwingen.

## Restrisico's

- De app praat vaak plain HTTP. Zonder TLS zijn het sessiecookie, de resetcode en het ntfy-topic op het netwerk zichtbaar. Zet een reverse proxy met HTTPS ervoor en `COOKIE_SECURE=1`. HSTS staat hier niet aan, omdat een lokaal HTTP-adres daar anders kapotgaat.
- De rate-limit en de NS-cache zitten in het geheugen van één proces en resetten bij een herstart.
- `NTFY_ALLOW_PRIVATE=1` vertrouwt elk adres, inclusief metadata-diensten. Alleen aanzetten voor een eigen ntfy.
- `NS_API_KEY`, `ADMIN_PASSWORD` en de sqlite-database staan in de omgeving of in `data/`. Die komen niet in API-antwoorden, maar wel bij wie de host of het volume kan lezen.
- Een lege `ADMIN_USERNAME` bij een lege database maakt geen account. De UI is dan dicht (401), niet open.
- Op de single-user tak blijft basic auth herhaalbaar over HTTP zolang `UI_PASSWORD` gezet is, en een lege `UI_PASSWORD` laat de UI open.
- `SCRYPT_N` onder de standaard maakt wachtwoorden goedkoper om te raden. In productie niet zetten.
- De beheerder kan een eenmalige resetcode zien op het moment dat die wordt aangemaakt. Dat is de bedoeling; daarna staat alleen de hash in de database.
