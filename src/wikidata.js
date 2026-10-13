// Stažení celého mapování IMDb → ČSFD z Wikidat (P345 = IMDb ID, P2529 = ČSFD film ID).
const ENDPOINT = 'https://query.wikidata.org/sparql';

// Dotaz se dělí podle první číslice ČSFD ID, aby žádná část nenarazila na 60s limit.
const PREFIXES = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

const chunkQuery = (prefix) => `SELECT ?imdb ?csfd WHERE {
  ?i wdt:P2529 ?csfd ; wdt:P345 ?imdb .
  FILTER(STRSTARTS(?csfd, "${prefix}"))
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

/** Parsuje CSV výstup SPARQL (hlavička imdb,csfd). Vrací jen platné páry. */
export function parsePairsCsv(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const [imdbRaw, csfdRaw] = line.split(',');
    const imdb = imdbRaw?.replace(/"/g, '').trim();
    const csfd = csfdRaw?.replace(/"/g, '').trim();
    if (!/^tt\d+$/.test(imdb || '')) continue;
    if (!/^\d+$/.test(csfd || '')) continue;
    out.push([imdb, Number(csfd)]);
  }
  return out;
}

/**
 * Stáhne všechny páry. Každá část má 3 pokusy; když některá selže úplně,
 * vyhodí chybu (raději žádná aktualizace než neúplná).
 */
export async function fetchAllPairs({ userAgent, fetchImpl, log = console.log, pauseMs = 1000 } = {}) {
  const all = [];
  for (const prefix of PREFIXES) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const text = await sparql(chunkQuery(prefix), { userAgent, accept: 'text/csv', fetchImpl });
        const pairs = parsePairsCsv(text);
        all.push(...pairs);
        log(`[wikidata] část ${prefix}: ${pairs.length} párů`);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        log(`[wikidata] část ${prefix}, pokus ${attempt} selhal: ${e.message}`);
        await sleep(pauseMs * 5 * attempt);
      }
    }
    if (lastErr) throw new Error(`Wikidata část ${prefix} selhala: ${lastErr.message}`);
    await sleep(pauseMs); // pauza mezi částmi
  }
  return all;
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
