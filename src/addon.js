// Stremio addon rozhraní pro externí hodnocení (NuvioTVOS: resource "ratings" + "ratingSources").
import { existsSync, readFileSync } from 'node:fs';

export const ADDON_ID = 'cz.csfd-ratings.selfhosted';
export const RATING_SOURCE = 'csfd';
/** Varianta addonu bez hodnocení dílů: /bez-dilu/manifest.json (a /bez-dilu/ratings/…). */
export const NO_EPISODES_PREFIX = '/bez-dilu';

/** Rozdělí cestu na variantu a zbytek: { episodes, path }. */
export function splitVariant(path) {
  if (path === NO_EPISODES_PREFIX || path.startsWith(`${NO_EPISODES_PREFIX}/`)) {
    return { episodes: false, path: path.slice(NO_EPISODES_PREFIX.length) || '/' };
  }
  return { episodes: true, path };
}

export const CATALOG_ID = 'csfd-only';

export const manifestPath = (episodes) => `${episodes ? '' : NO_EPISODES_PREFIX}/manifest.json`;

/** Načte ikonu, pokud existuje. Bez ikony manifest ikonu neuvádí. */
export function loadIcon(path) {
  try {
    return existsSync(path) ? readFileSync(path) : null;
  } catch {
    return null;
  }
}

/** Veřejná adresa služby: PUBLIC_URL, jinak z hlaviček požadavku (reverse proxy). */
export function publicBaseUrl(req, configured) {
  if (configured) return configured.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

export function buildManifest({ baseUrl, hasIcon, version, episodes = true }) {
  const source = { source: RATING_SOURCE, name: 'ČSFD', max: 100 };
  if (hasIcon) source.icon = `${baseUrl}/icon.png`;
  // Nuvio se ptá na hodnocení dílů (tt…:S:E) jen u zdrojů s episodes: true.
  if (episodes) source.episodes = true;
  const manifest = {
    id: ADDON_ID,
    version,
    name: 'ČSFD hodnocení',
    description:
      (episodes
        ? 'Hodnocení z ČSFD.cz podle IMDb ID (filmy, seriály a jednotlivé díly).'
        : 'Hodnocení z ČSFD.cz podle IMDb ID (filmy a seriály).') +
      ' Hledání titulů, které jsou jen na ČSFD.',
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'csfd:'],
    resources: [
      { name: 'ratings', types: ['movie', 'series'], idPrefixes: ['tt', 'csfd:'] },
      { name: 'catalog', types: ['movie', 'series'] },
      { name: 'meta', types: ['movie', 'series'], idPrefixes: ['csfd:'] }
    ],
    // Jen hledání (isRequired): na Home se neukazují, výsledky jsou jen tituly bez IMDb.
    catalogs: ['movie', 'series'].map((type) => ({
      type,
      id: CATALOG_ID,
      name: 'Jen na ČSFD',
      extra: [{ name: 'search', isRequired: true }],
      extraSupported: ['search'],
      extraRequired: ['search']
    })),
    ratingSources: [source],
    behaviorHints: { configurable: false }
  };
  if (hasIcon) manifest.logo = `${baseUrl}/icon.png`;
  return manifest;
}

/**
 * Parsuje cestu /ratings/{type}/{id}.json. ID může být i díl (tt…:S:E) a titul jen na ČSFD (csfd:ID, csfd:ID:S:E).
 * Vrací { type, imdbId | csfdId, season, episode } (season/episode jen u dílu) nebo null.
 */
export function parseRatingsPath(path) {
  const m = path.match(/^\/ratings\/(movie|series)\/([^/]+?)\.json$/);
  if (!m) return null;
  let id;
  try {
    id = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  const imdb = id.match(/^(tt\d{5,10})(?::(\d+):(\d+))?$/);
  const cs = !imdb && id.match(/^csfd:(\d{1,9})(?::(\d+):(\d+))?$/);
  if (!imdb && !cs) return null;
  const hit = imdb || cs;
  const out = imdb ? { type: m[1], imdbId: imdb[1] } : { type: m[1], csfdId: Number(cs[1]) };
  if (hit[2] !== undefined) {
    out.season = Number(hit[2]);
    out.episode = Number(hit[3]);
  }
  return out;
}

/** /catalog/{type}/csfd-only/search=….json → { type, query } nebo null. */
export function parseCatalogPath(path) {
  const m = path.match(/^\/catalog\/(movie|series)\/([^/]+)(?:\/([^/]*))?\.json$/);
  if (!m || m[2] !== CATALOG_ID) return null;
  let query = '';
  for (const part of (m[3] ?? '').split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    let k, v;
    try {
      k = decodeURIComponent(part.slice(0, eq));
      v = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    } catch {
      return null;
    }
    if (k === 'search') query = v.trim();
  }
  return { type: m[1], query };
}

/** /meta/{type}/csfd:ID.json → { type, csfdId } nebo null. */
export function parseMetaPath(path) {
  const m = path.match(/^\/meta\/(movie|series)\/([^/]+?)\.json$/);
  if (!m) return null;
  let id;
  try {
    id = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  const cs = id.match(/^csfd:(\d{1,9})$/);
  return cs ? { type: m[1], csfdId: Number(cs[1]) } : null;
}

/** Odpověď ve formátu Nuvia z výsledku resolveru. */
export function ratingsPayload(result) {
  if (!result || !Number.isFinite(result.row?.rating)) return { ratings: [] };
  return {
    ratings: [
      {
        source: RATING_SOURCE,
        value: result.row.rating,
        url: `https://www.csfd.cz/film/${result.csfdId}/`
      }
    ]
  };
}

/** Odpověď ve formátu Nuvia pro díl (výsledek createEpisodeResolver().resolveEpisode). */
export function episodePayload(result) {
  const ep = result?.ep;
  if (!ep || !Number.isFinite(ep.rating)) return { ratings: [] };
  return {
    ratings: [{ source: RATING_SOURCE, value: Math.round(ep.rating), url: episodeUrl(result.seriesCsfdId, ep) }]
  };
}

export function episodeUrl(seriesCsfdId, ep) {
  if (ep.path) return `https://www.csfd.cz${ep.path}`;
  if (ep.csfdId) return `https://www.csfd.cz/film/${seriesCsfdId}/${ep.csfdId}/`;
  return `https://www.csfd.cz/film/${seriesCsfdId}/epizody/`;
}
