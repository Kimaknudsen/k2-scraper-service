# K2 Scraper Service

Henter ledige oppkjøringstimer fra Vegvesen via sesjons-cookies.

## Strategi

1. **Direkte HTTP** — Sender request med BankID-sesjons-cookies, parser embedded JSON/API-data
2. **Playwright fallback** — Headless browser med injiserte cookies, fanger XHR-kall og leser DOM

## Oppsett

### Railway
1. Push til GitHub-repo
2. Koble til Railway
3. Sett environment variables:
   - `API_SECRET` — Hemmelighet for å autentisere kall fra edge function
   - `VEGVESEN_COOKIES` — BankID-sesjons-cookies (se under)

### Hente cookies
1. Logg inn på vegvesen.no med BankID
2. Åpne DevTools → Application → Cookies
3. Kopier alle cookies som en string: `cookie1=value1; cookie2=value2; ...`
4. Lim inn som `VEGVESEN_COOKIES` env var i Railway

### API
- `GET /health` — Helsesjekk
- `POST /scrape` — Hent ledige tider (krever `x-api-key` header)
- `POST /update-cookies` — Oppdater cookies runtime
- `GET /validate-cookies` — Sjekk om cookies er gyldige

Cookies utløper typisk etter noen timer. Oppdater via `/update-cookies` eller Railway env vars.
