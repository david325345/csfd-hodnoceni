# csfd-ratings

Malá služba, která k IMDb ID vrátí hodnocení z ČSFD. Určená jako zdroj externího hodnocení (Nuvio apod.).

## Jak funguje

1. **Mapování IMDb → ČSFD z Wikidat** (vlastnosti P345 a P2529). Stahuje se celé (~317 tisíc párů) při prvním startu a pak jednou týdně. Nové mapování se nepoužije, když má o víc než 5 % méně párů než předchozí — ochrana proti výpadku Wikidat.
2. **Fallback**, když IMDb ID v mapování není:
   - Cinemeta (metadata Stremia) dá k IMDb ID název, rok, typ, režiséry a herce,
   - hledání na ČSFD podle názvu,
   - shoda se uzná jen při stejném typu (film / seriál), roku ±1 **a** shodě aspoň jednoho režiséra nebo herce. Bez shody tvůrce stačí shoda názvu jen při přesném roce. Dva stejně dobří kandidáti = nenalezeno (nehádá se).
   - Nalezený pár se uloží natrvalo (`own_map`), neúspěch na 7 dní (`miss`).
   - Stojí to 2 requesty na ČSFD (hledání + detail) a pro každý titul se to stane jednou.
3. **Hodnocení** z detailu na ČSFD, cache 24 h. Když je ČSFD nedostupné, vrátí se starší uložené hodnocení s `"stale": true`.

Na ČSFD se jde jen na vyžádání, přes frontu (max. 2 požadavky souběžně, 500 ms rozestup). Cookie anti-bot ochrany Anubis (platí ~týden, vázané na IP serveru) se ukládá do databáze, aby se po restartu nemuselo řešit znovu.

Knihovna [node-csfd-api](https://github.com/bartholomej/node-csfd-api) je použitá **beze změn**, zamčená na verzi `5.13.1`. Databáze je vestavěné SQLite z Node (`node:sqlite`, Node ≥ 22.13), takže služba nemá žádné nativní závislosti. Jediná závislost je node-csfd-api.

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

- `wikidata.imdbWithMultipleCsfd` — kolik IMDb ID má na Wikidatech víc ČSFD ID. Zatím se bere první, které není sezóna/díl.
- `resolver.fallback` — `attempts / matched / noMatch / ambiguous / noMeta / errors`. Když `errors` výrazně roste, ČSFD nebo Cinemeta nejspíš blokuje nebo změnilo web.
- `resolver.staleServed` — kolikrát se vrátilo starší hodnocení kvůli nedostupnému ČSFD.

### `GET /health`

`{"ok": true, "wikidataPairs": 317406}` — používá Docker healthcheck.

### `POST /admin/refresh-wikidata`

Ruční spuštění obnovy mapování. Funguje jen s nastaveným `ADMIN_TOKEN`:

```bash
curl -X POST -H "Authorization: Bearer TOKEN" http://localhost:7020/admin/refresh-wikidata
# ?force=1 přeskočí kontrolu poklesu
```

## Konfigurace (proměnné prostředí)

| Proměnná | Výchozí | Popis |
|---|---|---|
| `PORT` | `7020` | port HTTP serveru |
| `DB_PATH` | `./data/csfd-ratings.db` | SQLite databáze |
| `WIKIDATA_REFRESH_DAYS` | `7` | jak často obnovit mapování |
| `WIKIDATA_MAX_DROP_PERCENT` | `5` | max. povolený pokles počtu párů |
| `RATING_TTL_HOURS` | `24` | platnost cache hodnocení |
| `MISS_TTL_DAYS` | `7` | jak dlouho se znovu nehledá nenalezený titul |
| `CSFD_CONCURRENCY` | `2` | souběžné požadavky na ČSFD |
| `CSFD_DELAY_MS` | `500` | min. rozestup požadavků na ČSFD |
| `ADMIN_TOKEN` | prázdné | token pro `/admin/refresh-wikidata` |

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

První start stáhne mapování z Wikidat (pár minut, v logu `[wikidata] část 1..9`). Služba mezitím běží a dotazy řeší fallbackem.

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
