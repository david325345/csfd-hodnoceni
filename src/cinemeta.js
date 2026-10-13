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
 * Odpověď Cinemety je platná jen tehdy, když vrácené IMDb ID odpovídá dotazu
 * a typ odpovídá endpointu. Filmový endpoint totiž u seriálových ID občas vrací
 * jiný titul nebo seriál označený jako film.
 */
export function isValidMeta(meta, imdbId, type) {
  if (!meta || !meta.name) return false;
  const id = meta.imdb_id || meta.id;
  if (id && id !== imdbId) return false;
  if (meta.type && meta.type !== type) return false;
  return true;
}

/**
 * Vrátí { type: 'movie'|'series', name, year, directors[], cast[] } nebo null.
 * Typ z IMDb ID neznáme, proto se zkouší film i seriál a bere se první platná odpověď.
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
    if (!isValidMeta(meta, imdbId, type)) continue;
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
