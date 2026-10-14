// Stremio addon rozhraní pro externí hodnocení (NuvioTVOS: resource "ratings" + "ratingSources").
import { existsSync, readFileSync } from 'node:fs';

export const ADDON_ID = 'cz.csfd-ratings.selfhosted';
export const RATING_SOURCE = 'csfd';

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

export function buildManifest({ baseUrl, hasIcon, version }) {
  const source = { source: RATING_SOURCE, name: 'ČSFD', max: 100 };
  if (hasIcon) source.icon = `${baseUrl}/icon.png`;
  const manifest = {
    id: ADDON_ID,
    version,
    name: 'ČSFD hodnocení',
    description: 'Hodnocení z ČSFD.cz podle IMDb ID (filmy a seriály).',
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    resources: [{ name: 'ratings', types: ['movie', 'series'], idPrefixes: ['tt'] }],
    catalogs: [],
    ratingSources: [source],
    behaviorHints: { configurable: false }
  };
  if (hasIcon) manifest.logo = `${baseUrl}/icon.png`;
  return manifest;
}

/**
 * Parsuje cestu /ratings/{type}/{id}.json. ID může být i epizoda (tt…:S:E),
 * hodnocení se pak bere pro celý seriál. Vrací { type, imdbId } nebo null.
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
  const imdb = id.match(/^(tt\d{5,10})(?::\d+:\d+)?$/);
  if (!imdb) return null;
  return { type: m[1], imdbId: imdb[1] };
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
