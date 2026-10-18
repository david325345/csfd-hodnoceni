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

async function fetchMeta(imdbId, type, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const res = await fetchImpl(`${BASE}/${type}/${imdbId}.json`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Cinemeta HTTP ${res.status}`);
  }
  const meta = (await res.json())?.meta;
  if (!isValidMeta(meta, imdbId, type)) return null;
  return {
    type,
    name: meta.name,
    year: firstYear(meta.year ?? meta.releaseInfo),
    directors: toList(meta.director),
    cast: toList(meta.cast)
  };
}

/**
 * Vrátí { type: 'movie'|'series', name, year, directors[], cast[] } nebo null.
 * S `type` se ptá jen na daný endpoint. Bez typu zkusí film, pak seriál, a vezme první platnou odpověď.
 * Pozor: Cinemeta pod stejným IMDb ID někdy vrací na filmovém endpointu úplně jiný titul,
 * proto má fallback typ znát (Nuvio ho posílá), nebo použít getMetas.
 */
export async function getMeta(imdbId, { type, ...opts } = {}) {
  for (const t of type ? [type] : ['movie', 'series']) {
    const meta = await fetchMeta(imdbId, t, opts);
    if (meta) return meta;
  }
  return null;
}

/** Platné odpovědi z obou endpointů (0–2 položky). */
export async function getMetas(imdbId, opts = {}) {
  const out = [];
  for (const t of ['movie', 'series']) {
    const meta = await fetchMeta(imdbId, t, opts);
    if (meta) out.push(meta);
  }
  return out;
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

/**
 * Díly seriálu z Cinemety (bez série 0):
 * { seasons: { [s]: { count, lastReleased } }, released: { "s:e": ms } } nebo null.
 * `lastReleased` = datum posledního dílu série (ms), slouží k určení stáří série.
 */
export function summarizeVideos(videos) {
  const seasons = {};
  const released = {};
  for (const v of Array.isArray(videos) ? videos : []) {
    const s = Number(v.season);
    const e = Number(v.episode ?? v.number);
    if (!Number.isInteger(s) || s < 1 || !Number.isInteger(e)) continue;
    const t = Date.parse(v.released ?? v.firstAired ?? '');
    const k = `${s}:${e}`;
    if (k in released) continue;
    released[k] = Number.isFinite(t) ? t : null;
    const info = (seasons[s] ??= { count: 0, lastReleased: null });
    info.count++;
    if (Number.isFinite(t) && (info.lastReleased == null || t > info.lastReleased)) info.lastReleased = t;
  }
  return Object.keys(seasons).length ? { seasons, released } : null;
}

export async function getSeriesVideos(imdbId, { fetchImpl = fetch, timeoutMs = 8_000 } = {}) {
  const res = await fetchImpl(`${BASE}/series/${imdbId}.json`, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Cinemeta HTTP ${res.status}`);
  const meta = (await res.json())?.meta;
  if (!isValidMeta(meta, imdbId, 'series')) return null;
  return summarizeVideos(meta.videos);
}
