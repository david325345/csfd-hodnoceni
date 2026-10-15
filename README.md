# csfd-ratings

Malá služba, která k IMDb ID vrátí hodnocení z ČSFD. Určená jako zdroj externího hodnocení (Nuvio apod.).

## Jak funguje

1. **Mapování IMDb → ČSFD z Wikidat** (vlastnosti P345 a P2529), ~318 tisíc párů. U každého páru se ukládá i Q-ID položky na Wikidatech.
   - **Plné stažení** při prvním startu a pak jednou za 30 dní. Je rozdělené na 91 malých dotazů (podle prvních dvou číslic ČSFD ID), trvá pár minut. Nové mapování se nepoužije, když má o víc než 5 % méně párů než předchozí — ochrana proti výpadku Wikidat. Plné stažení dočistí i smazané a sloučené položky.
   - **Přírůstek** jednou týdně: jeden dotaz na položky s ČSFD ID změněné od poslední aktualizace (s dnem překryvu). U každé změněné položky se její páry nahradí aktuálními, takže se zachytí nové, opravené i odebrané IMDb ID. Smazané položky přírůstek nevidí, ty dočistí nejbližší plné stažení.
   - Při neúspěchu se další pokus spustí nejdřív za 6 hodin. Do té doby zůstává poslední platné mapování.
2. **Fallback**, když IMDb ID v mapování není:
   - Cinemeta (metadata Stremia) dá k IMDb ID název, rok, typ, režiséry a herce. Typ se bere z požadavku (`/ratings/series/…` → jen seriálový endpoint Cinemety), protože Cinemeta pod stejným IMDb ID někdy vrací na filmovém endpointu úplně jiný titul. Bez typu (`/rating/{id}`) se zkusí oba endpointy a výsledek se přijme jen tehdy, když sedí právě jeden.
   - hledání na ČSFD podle názvu,
   - shoda se uzná při stejném typu (film / seriál), roku ±1 **a** shodě aspoň jednoho režiséra nebo herce. Bez shody tvůrce stačí shoda názvu jen při přesném roce. Dva stejně dobří kandidáti = nenalezeno (nehádá se).
   - Když nic nesedí (typicky anime: Cinemeta má anglický název, ČSFD romaji), stáhne se detail až 3 kandidátů se stejným typem a rokem ±1 a název se porovná i s alternativními názvy na ČSFD. Shoda musí být právě jedna. Stažený detail se rovnou použije pro hodnocení.
   - Nalezený pár se uloží natrvalo (`own_map`), neúspěch na 7 dní (`miss`).

3. **Hodnocení** z detailu na ČSFD se ukládá do databáze. Platnost:
   - **filmy** podle roku vydání: 2 a víc let staré 365 dní, loňské 90 dní, letošní, budoucí a bez roku 3 dny,
   - **seriály** podle stavu z Cinemety (`status` + `releaseInfo`): ukončené 365 dní, běžící a nezjištěné 3 dny. U ukončených se každých 30 dní (při dotazu) ověří v Cinemetě, že jsou pořád ukončené se stejným rokem konce. Když se seriál rozjel nebo přibyla sezóna, hodnocení se hned stáhne znovu a seriál se dál bere jako běžící. Kontrola stavu na ČSFD nic neposílá.
   - Když je ČSFD nedostupné, vrátí se starší uložené hodnocení s `"stale": true`.

Na ČSFD se jde jen na vyžádání, přes frontu (max. 2 požadavky souběžně, 500 ms rozestup). Cookie anti-bot ochrany Anubis (platí ~týden, vázané na IP serveru) se ukládá do databáze, aby se po restartu nemuselo řešit znovu.

Knihovna [node-csfd-api](https://github.com/bartholomej/node-csfd-api) je použitá **beze změn**, zamčená na verzi `5.13.1`. Databáze je vestavěné SQLite z Node (`node:sqlite`, Node ≥ 22.13), takže služba nemá žádné nativní závislosti. Jediná závislost je node-csfd-api.

## Instalační stránka

Na adrese `/` je instalační stránka: adresa manifestu s tlačítkem Kopírovat, QR kód (`/qr.svg`, generovaný lokálně), vyzkoušení podle IMDb ID a stav mapování. Adresu manifestu si stránka bere z adresy, na které je otevřená. QR kód používá `PUBLIC_URL`, jinak hlavičky proxy. Nuvio vyžaduje HTTPS.

## Nuvio / Stremio addon

Služba je zároveň Stremio addon s externím hodnocením ve formátu NuvioTVOS (resource `ratings` + `ratingSources`).

- **Instalace:** v Nuviu přidat addon s adresou `https://<adresa-služby>/manifest.json`.
- `GET /manifest.json` — addon „ČSFD hodnocení“, zdroj `csfd`, stupnice `max: 100` (Nuvio zobrazí procenta).
- `GET /ratings/{movie|series}/{tt…}.json` — `{"ratings":[{"source":"csfd","value":91,"url":"https://www.csfd.cz/film/8852/"}]}`. ID epizody (`tt…:S:E`) se bere jako celý seriál. Nenalezeno, chybějící hodnocení nebo nedostupné ČSFD = `{"ratings":[]}` s HTTP 200 (Nuvio nic nezobrazí).
- **Ikona:** `public/icon.png` (čtverec 256×256 px, PNG s průhledným pozadím, čitelná na tmavém pozadí). Když chybí, manifest ikonu neuvádí a Nuvio ukáže hvězdičku. Nuvio ji vykresluje do 38×38 bodů vedle čísla, název zdroje se v detailu nepíše.
- Adresa ikony v manifestu se skládá z `PUBLIC_URL`, jinak z hlaviček reverse proxy (`X-Forwarded-Proto/Host`).

## API

### `GET /rating/{imdbId}`

```json
{
  "imdbId": "tt0110912",
  "found": true,
  "csfdId": 8852,
  "rating": 88,
  "ratingCount": 123456,
  "colorRating": "good",
  "title": "Pulp Fiction: Historky z podsvětí",
  "year": 1994,
  "type": "film",
  "url": "https://www.csfd.cz/film/8852/",
  "source": "wikidata",
  "stale": false,
  "fetchedAt": "2026-10-13T13:45:00.000Z"
}
```

- `rating` je v procentech, může být `null` (málo hodnocení na ČSFD).
- `source`: `wikidata`, `search` (právě nalezeno fallbackem) nebo `own` (dříve nalezeno fallbackem).
- Nenalezeno: `404 {"imdbId": "...", "found": false}`.
- ČSFD nedostupné a nic v cache: `503`.

### `GET /stats`

Počty párů, stav poslední obnovy Wikidat, velikost cache, fronta na ČSFD a čítače resolveru. Důležité položky:

- `wikidata.lastFull` / `lastSync` / `lastMode` / `lastDeltaItems` — kdy proběhlo poslední plné stažení, poslední aktualizace vůbec, jakého typu a kolik položek změnil poslední přírůstek.
- `wikidata.imdbWithMultipleCsfd` — kolik IMDb ID má na Wikidatech víc ČSFD ID. Zatím se bere první, které není sezóna/díl.
- `resolver.fallback` — `attempts / matched / noMatch / ambiguous / noMeta / errors`. Když `errors` výrazně roste, ČSFD nebo Cinemeta nejspíš blokuje nebo změnilo web.
- `resolver.staleServed` — kolikrát se vrátilo starší hodnocení kvůli nedostupnému ČSFD.

### `GET /health`

`{"ok": true, "wikidataPairs": 317406}` — používá Docker healthcheck.

### `POST /admin/refresh-wikidata`

Ruční spuštění obnovy mapování. Funguje jen s nastaveným `ADMIN_TOKEN`:

```bash
curl -X POST -H "Authorization: Bearer TOKEN" "http://localhost:7020/admin/refresh-wikidata?mode=incremental"
# mode=full (výchozí) | incremental; u full ?force=1 přeskočí kontrolu poklesu
```

## Konfigurace (proměnné prostředí)

| Proměnná | Výchozí | Popis |
|---|---|---|
| `PORT` | `7020` | port HTTP serveru |
| `DB_PATH` | `./data/csfd-ratings.db` | SQLite databáze |
| `WIKIDATA_INCREMENTAL_DAYS` | `7` | jak často stahovat přírůstek |
| `WIKIDATA_FULL_REFRESH_DAYS` | `30` | jak často stahovat celé mapování |
| `WIKIDATA_MAX_DROP_PERCENT` | `5` | max. povolený pokles počtu párů při plném stažení |
| `RATING_TTL_FILM_OLD_DAYS` | `365` | filmy 2 a víc let staré |
| `RATING_TTL_FILM_LAST_YEAR_DAYS` | `90` | loňské filmy |
| `RATING_TTL_FILM_NEW_DAYS` | `3` | letošní, budoucí a filmy bez roku |
| `RATING_TTL_SERIES_ENDED_DAYS` | `365` | ukončené seriály |
| `RATING_TTL_SERIES_ONGOING_DAYS` | `3` | běžící seriály a seriály s nezjištěným stavem |
| `SERIES_STATUS_CHECK_DAYS` | `30` | jak často ověřit, že ukončený seriál je pořád ukončený |
| `MISS_TTL_DAYS` | `7` | jak dlouho se znovu nehledá nenalezený titul |
| `CSFD_CONCURRENCY` | `2` | souběžné požadavky na ČSFD |
| `CSFD_DELAY_MS` | `500` | min. rozestup požadavků na ČSFD |
| `ADMIN_TOKEN` | prázdné | token pro `/admin/refresh-wikidata` |
| `PUBLIC_URL` | prázdné | veřejná adresa služby pro odkaz na ikonu v manifestu (jinak z hlaviček) |
| `ICON_PATH` | `public/icon.png` | cesta k ikoně |

## Nasazení

Před nasazením ověř, že ČSFD ze serveru normálně odpovídá:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -A 'Mozilla/5.0' https://www.csfd.cz/film/8852/
```

Pak:

```bash
docker compose up -d --build
docker compose logs -f
```

První start stáhne mapování z Wikidat (pár minut, v logu `[wikidata] staženo 10/91 částí …` až `hotovo (full)`). Služba mezitím běží a dotazy řeší fallbackem.

Test:

```bash
curl http://localhost:7020/rating/tt0110912
curl http://localhost:7020/stats
```

## Testy

```bash
npm install
npm test
```

Testy běží offline. `test/library.test.js` pouští skutečnou node-csfd-api nad uloženými stránkami ČSFD (z testů knihovny), takže hlídá, že knihovna vrací data ve tvaru, s jakým počítá párování.

## Aktualizace knihovny

Knihovna je zamčená na `5.13.1` a není upravená. Kdyby ČSFD změnilo web nebo ochranu a hodnocení přestalo chodit (v `/stats` roste `resolver.errors`):

1. v `package.json` změnit verzi `node-csfd-api`,
2. `npm install && npm test`,
3. znovu sestavit kontejner.

## Upgrade z první verze

Databáze z první verze nemá u párů Q-ID položek Wikidat. Při startu nové verze se sloupec doplní a automaticky se spustí plné stažení (pár minut). Do jeho dokončení služba dál používá původní mapování.

## Kontrola párů z fallbacku

Skript znovu spáruje všechny páry z `own_map` přísnou cestou (oba endpointy Cinemety, jen jednoznačná shoda) a vypíše podezřelé. Ve výchozím stavu nic nemaže:

```sh
cd /app
node --disable-warning=ExperimentalWarning scripts/check-own-map.mjs           # výpis
APPLY=1 node --disable-warning=ExperimentalWarning scripts/check-own-map.mjs   # smazání podezřelých
```

Smazaný pár se při příštím dotazu z Nuvia najde znovu, už s typem z požadavku.
