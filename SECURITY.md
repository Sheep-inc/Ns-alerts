# Beveiliging (één gebruiker)

Controle van de single-user app op branch `cursor/import-ns-alerts-3ca6`. De multi-user variant staat op een aparte branch en heeft een eigen aanvulling in hetzelfde document daar.

## Uitgevoerd

- Handmatige review van `app.js`, `detect.js`, `digest.js`, de UI en Docker/systemd.
- `npm audit` (geen runtime-dependencies; eslint staat alleen als devDependency).
- `eslint` met `eslint-plugin-security` (`npm run lint`). `detect-object-injection` en `detect-non-literal-fs-filename` staan uit na review: sleutels zijn vast of al gevalideerd, en bestandsnamen zijn `path.join` van de datamap of een vaste static-lijst (`index.html`, `app.js`, `app.css`).
- Tests in `tests/security.test.js` voor privé-adressen, CSP, bodylimiet en cross-site writes.

## Bevindingen en fixes

| Onderwerp | Bevinding | Fix |
| --- | --- | --- |
| XSS | Abonnementen, stationsnamen en foutteksten gingen via `innerHTML`, inclusief `onclick` met een id. | DOM-API met `textContent`. Script en CSS staan in `/app.js` en `/app.css`. |
| CSP | Geen security headers; inline script. | Strikte CSP (`script-src 'self'`, geen `unsafe-inline`), `nosniff`, `DENY` frames, `Referrer-Policy`, `Permissions-Policy`. |
| CSRF | Basic auth wordt door de browser herhaald. | `POST`/`DELETE` met `Sec-Fetch-Site: cross-site` of een afwijkende `Origin` krijgt 403. |
| Brute force | `UI_PASSWORD` had geen limiet. | 20 mislukte pogingen per IP per 15 minuten → 429. Vergelijken blijft `timingSafeEqual`. |
| Body | `Content-Length` werd niet begrensd. | Maximaal 1 MB, anders 413. |
| SSRF | `ntfy_server` werd ongecontroleerd opgehaald, inclusief redirects. | Alleen `http(s)`, geen userinfo, DNS-check op privé/loopback/link-local, redirects geweigerd. Privé alleen met `NTFY_ALLOW_PRIVATE=1`. |
| Logging | Het volledige ntfy-topic stond in de log. | Topic wordt gemaskeerd. 500-antwoorden zijn generiek. |
| Docker | Root, beschrijfbare rootfs, healthcheck zette het wachtwoord in het proceslijst-argument. | Gebruiker `node`, `read_only`, `cap_drop: ALL`, `no-new-privileges`, healthcheck op `/healthz`. systemd: `NoNewPrivileges`, `ProtectSystem=strict`. |
| Path | Statische bestanden komen uit een vaste lijst (`index.html`, `app.js`, `app.css`). Verwijder-id moet 8 hex tekens zijn. | Geen user-pad in `path.join`. |

`npm audit` rapporteert geen bekende kwetsbaarheden in de dependencies die op deze branch horen.

## Restrisico's

- De app wordt vaak over plain HTTP gebruikt. Basic auth en het ntfy-topic zijn dan op het netwerk zichtbaar. Zet een reverse proxy met HTTPS ervoor.
- `UI_PASSWORD` leeg betekent een open UI. Zet een wachtwoord.
- De rate-limit en de NS-cache zitten in het geheugen van één proces en resetten bij een herstart.
- `NTFY_ALLOW_PRIVATE=1` vertrouwt elk adres, inclusief metadata-diensten. Alleen aanzetten voor een eigen ntfy.
- `NS_API_KEY` blijft een omgevingsgeheim. Die komt niet in API-antwoorden, maar wel in de omgeving van het proces.
- HSTS staat niet aan, omdat een lokaal HTTP-adres daar anders kapotgaat. Zet HSTS op de reverse proxy.
