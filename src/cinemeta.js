// Metadata k IMDb ID z Cinemety (oficiální metadata addon Stremia, bez klíče).
const BASE = 'https://v3-cinemeta.strem.io/meta';

const firstYear = (v) => {
  const m = String(v ?? '').match(/\d{4}/);
  return m ? Number(m[0]) : null;
};

const toList = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',') : [])
  .map((s) => String(s).trim())
  .filter(Boolean);

/**
 * Vrátí { type: 'movie'|'series', name, year, directors[], cast[] } nebo null.
 * Typ z IMDb ID neznáme, proto se zkouší nejdřív film, pak seriál.
 */
export async function getMeta(imdbId, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  for (const type of ['movie', 'series']) {
    const res = await fetchImpl(`${BASE}/${type}/${imdbId}.json`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      if (res.status === 404) continue;
      throw new Error(`Cinemeta HTTP ${res.status}`);
    }
    const meta = (await res.json())?.meta;
    if (!meta || !meta.name) continue;
    return {
      type,
      name: meta.name,
      year: firstYear(meta.year ?? meta.releaseInfo),
      directors: toList(meta.director),
      cast: toList(meta.cast)
    };
  }
  return null;
}
