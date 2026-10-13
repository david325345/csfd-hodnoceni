// Mapování IMDb → ČSFD z Wikidat (P345 = IMDb ID, P2529 = ČSFD film ID).
const ENDPOINT = 'https://query.wikidata.org/sparql';

// Plné stažení se dělí podle prvních dvou číslic ČSFD ID (10–99) plus jedna část
// pro jednociferná ID → 91 malých dotazů, žádný se nepřiblíží 60s limitu.
export const FULL_CHUNKS = [
  'STRLEN(?csfd) = 1',
  ...Array.from({ length: 90 }, (_, i) => `STRSTARTS(?csfd, "${i + 10}")`)
];

const fullQuery = (filter) => `SELECT ?i ?imdb ?csfd WHERE {
  ?i wdt:P2529 ?csfd ; wdt:P345 ?imdb .
  FILTER(${filter})
}`;

// Přírůstek: všechny položky s ČSFD ID změněné od `since`. IMDb je volitelné,
// aby se poznalo i odebrání IMDb ID (položka pak nemá žádný platný pár).
const deltaQuery = (sinceIso) => `SELECT ?i ?imdb ?csfd WHERE {
  ?i wdt:P2529 ?csfd ; schema:dateModified ?d .
  FILTER(?d >= "${sinceIso}"^^xsd:dateTime)
  OPTIONAL { ?i wdt:P345 ?imdb }
}`;

const COUNT_QUERY = 'SELECT (COUNT(*) AS ?n) WHERE { ?i wdt:P2529 ?csfd ; wdt:P345 ?imdb . }';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sparql(query, { userAgent, accept, fetchImpl = fetch, timeoutMs = 90_000 }) {
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: {
      'User-Agent': userAgent,
      Accept: accept,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ query }).toString(),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  return res.text();
}

async function withRetry(fn, { label, log, pauseMs }) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      log(`[wikidata] ${label}, pokus ${attempt} selhal: ${e.message}`);
      if (attempt < 3) await sleep(pauseMs * 5 * attempt);
    }
  }
  throw new Error(`${label} selhalo: ${lastErr.message}`);
}

/**
 * Parsuje CSV výstup SPARQL (sloupce i, imdb, csfd).
 * Vrací řádky { item: 'Q123', imdb: 'tt…' | null, csfd: number }.
 * Řádky s neplatným ČSFD ID se zahodí, neplatné IMDb se převede na null.
 */
export function parseRowsCsv(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const [itemRaw, imdbRaw, csfdRaw] = line.split(',').map((v) => (v ?? '').replace(/"/g, '').trim());
    const item = itemRaw.match(/Q\d+$/)?.[0];
    if (!item || !/^\d+$/.test(csfdRaw)) continue;
    out.push({ item, imdb: /^tt\d+$/.test(imdbRaw) ? imdbRaw : null, csfd: Number(csfdRaw) });
  }
  return out;
}

/** Plné stažení všech párů. Když některá část selže i na 3. pokus, vyhodí chybu. */
export async function fetchAllRows({ userAgent, fetchImpl, log = console.log, pauseMs = 1000 } = {}) {
  const all = [];
  for (let n = 0; n < FULL_CHUNKS.length; n++) {
    const rows = await withRetry(
      async () => parseRowsCsv(await sparql(fullQuery(FULL_CHUNKS[n]), { userAgent, accept: 'text/csv', fetchImpl })),
      { label: `část ${n + 1}/${FULL_CHUNKS.length}`, log, pauseMs }
    );
    for (const r of rows) if (r.imdb) all.push(r);
    if ((n + 1) % 10 === 0 || n === FULL_CHUNKS.length - 1) {
      log(`[wikidata] staženo ${n + 1}/${FULL_CHUNKS.length} částí, ${all.length} párů`);
    }
    await sleep(pauseMs);
  }
  return all;
}

/** Přírůstek od zadaného času. Vrací Map(item → [[imdb, csfd], ...]). */
export async function fetchDelta(since, { userAgent, fetchImpl, log = console.log, pauseMs = 1000 } = {}) {
  const sinceIso = new Date(since).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const rows = await withRetry(
    async () => parseRowsCsv(await sparql(deltaQuery(sinceIso), { userAgent, accept: 'text/csv', fetchImpl })),
    { label: 'přírůstek', log, pauseMs }
  );
  const items = new Map();
  for (const r of rows) {
    if (!items.has(r.item)) items.set(r.item, []);
    if (r.imdb) items.get(r.item).push([r.imdb, r.csfd]);
  }
  return items;
}

/** Celkový počet párů podle Wikidat (pro kontrolu úplnosti). Při chybě vrací null. */
export async function fetchTotalCount({ userAgent, fetchImpl } = {}) {
  try {
    const text = await sparql(COUNT_QUERY, {
      userAgent,
      accept: 'application/sparql-results+json',
      fetchImpl
    });
    return Number(JSON.parse(text).results.bindings[0].n.value);
  } catch {
    return null;
  }
}
