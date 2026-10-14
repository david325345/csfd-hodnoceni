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

/**
 * Stav seriálu z Cinemety: { status: 'ended'|'continuing'|null, endYear: number|null }.
 * `status` bere z pole status (Ended / Continuing / Returning Series), jinak z releaseInfo
 * ("2008–2013" = ukončený, "2022–" = běžící). Vrací null, když Cinemeta seriál nezná.
 */
export function parseSeriesStatus(meta) {
  const info = String(meta?.releaseInfo ?? meta?.year ?? '');
  const range = info.match(/(\d{4})\s*[–-]\s*(\d{4})?/);
  const endYear = range && range[2] ? Number(range[2]) : null;
  const raw = String(meta?.status ?? '').toLowerCase();
  let status = null;
  if (raw === 'ended' || raw === 'canceled' || raw === 'cancelled') status = 'ended';
  else if (raw) status = 'continuing';
  else if (range) status = endYear ? 'ended' : 'continuing';
  return { status, endYear };
}

export async function getSeriesStatus(imdbId, { fetchImpl = fetch, timeoutMs = 8_000 } = {}) {
  const res = await fetchImpl(`${BASE}/series/${imdbId}.json`, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Cinemeta HTTP ${res.status}`);
  const meta = (await res.json())?.meta;
  if (!isValidMeta(meta, imdbId, 'series')) return null;
  return parseSeriesStatus(meta);
}
