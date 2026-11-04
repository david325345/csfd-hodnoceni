// Tituly, které jsou jen na ČSFD (nemají IMDb): hledání, metadata a hodnocení s ID csfd:<ČSFD ID>.
// Když titul IMDb má (Wikidata, vlastní pár nebo shoda v Cinemetě), do katalogu nepatří —
// v Nuviu ho najdeš normálně přes tt… a s ostatními addony.
import { normalize } from './matcher.js';
import { isSeriesType } from './resolver.js';

const DAY = 24 * 3600_000;
export const ID_PREFIX = 'csfd:';
const MOVIE_TYPES = new Set(['film', 'tv-film', 'theatrical', 'concert', 'student-film', 'amateur-film', 'video-compilation']);
const SERIES_TYPES = new Set(['series', 'tv-show']);
const CZSK = new Set(['cesko', 'ceskoslovensko', 'slovensko', 'ceska republika', 'protektorat cechy a morava']);

/** Česká nebo slovenská produkce (podle zemí původu z ČSFD). */
export const isCzSk = (origins) => (origins ?? []).some((o) => CZSK.has(normalize(o)));

/** Větší plakát: ČSFD posílá v hledání miniaturu (w60h85), stejný soubor jde i ve w420. Zástupný obrázek = null. */
export function posterUrl(src) {
  if (!src || src.startsWith('data:')) return null;
  const url = src.startsWith('//') ? `https:${src}` : src;
  return url.replace(/\/cache\/resized\/[^/]+\//, '/cache/resized/w420/');
}

/** Pomocná paralelní mapa s limitem souběhu. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Najde v Cinemetě titul se stejným (normalizovaným) názvem a rokem ±1.
 * Vrací IMDb ID, null (nic) nebo 'ambiguous' (víc různých IMDb ID).
 */
export function pickCinemetaHit(results, names, year) {
  const wanted = new Set(names.map(normalize).filter(Boolean));
  const hits = new Set();
  for (const r of results) {
    if (!wanted.has(normalize(r.name))) continue;
    if (Number.isFinite(year) && Number.isFinite(r.year) && Math.abs(r.year - year) > 1) continue;
    if (Number.isFinite(year) && !Number.isFinite(r.year)) continue;
    hits.add(r.imdb);
  }
  if (hits.size === 1) return [...hits][0];
  return hits.size > 1 ? 'ambiguous' : null;
}

/** Platnost metadat a seznamu dílů podle roku vydání (stejná pravidla jako u filmů). */
function ttlByYear(year, nowMs, config) {
  const age = Number.isFinite(year) && year > 0 ? new Date(nowMs).getUTCFullYear() - year : -1;
  const days = age >= 2 ? config.ttlFilmOldDays : age === 1 ? config.ttlFilmLastYearDays : config.ttlFilmNewDays;
  return days * DAY;
}

/** Zkrácený detail z node-csfd-api pro metadata a hodnocení. */
function compactDetail(m, csfdId) {
  const names = (list, n) => (list ?? []).slice(0, n).map((p) => p.name).filter(Boolean);
  const year = Number.isFinite(Number(m.year)) ? Number(m.year) : null;
  return {
    id: csfdId,
    title: m.title ?? null,
    year,
    type: m.type ?? null,
    poster: posterUrl(m.poster),
    background: m.photo ? (m.photo.startsWith('//') ? `https:${m.photo}` : m.photo) : null,
    description: (m.descriptions ?? [])[0] ?? null,
    genres: (m.genres ?? []).map((g) => (typeof g === 'string' ? g : g?.name)).filter(Boolean),
    origins: m.origins ?? [],
    duration: Number.isFinite(Number(m.duration)) ? Number(m.duration) : null,
    directors: names(m.creators?.directors, 5),
    actors: names(m.creators?.actors, 15),
    titlesOther: (m.titlesOther ?? []).map((t) => t.title).filter(Boolean),
    rating: Number.isFinite(m.rating) ? m.rating : null,
    ratingCount: Number.isFinite(m.ratingCount) ? m.ratingCount : null,
    colorRating: m.colorRating ?? null
  };
}

export function createCsfdOnly({
  db,
  csfdClient,
  episodes,
  searchCinemeta,
  config,
  now = () => Date.now(),
  log = console.log
}) {
  const deepInflight = new Set();
  const detailInflight = new Map();
  const stats = {
    searches: 0,
    results: 0,
    excludedImdb: 0,
    cinemetaMatches: 0,
    pending: 0,
    deepChecks: 0,
    metaRequests: 0,
    metaFetches: 0,
    metaCacheHits: 0,
    errors: 0
  };

  /** Zapamatuje si, že ČSFD titul má IMDb; když je pár jednoznačný a nový, uloží ho i jako vlastní pár. */
  function rememberImdb(csfdId, imdb, how, item) {
    stats.cinemetaMatches++;
    if (imdb === 'ambiguous') {
      db.classPut(csfdId, 'ambiguous', how, now());
      return;
    }
    db.classPut(csfdId, imdb, how, now());
    if (!db.ownGet(imdb) && !db.wdCsfdIds(imdb).length) {
      db.ownPut({
        imdb,
        csfd: csfdId,
        title: item?.title ?? null,
        year: Number.isFinite(item?.year) ? item.year : null,
        matched_by: `reverse,${how}`,
        created_at: now()
      });
      db.missDel(imdb);
    }
  }

  async function cinemetaLookup(type, names, year) {
    const uniq = [...new Map(names.filter(Boolean).map((n) => [normalize(n), n])).values()].slice(0, 4);
    const all = [];
    for (const name of uniq) {
      all.push(...(await searchCinemeta(type, name)));
      const hit = pickCinemetaHit(all, uniq, year);
      if (hit) return hit;
    }
    return pickCinemetaHit(all, uniq, year);
  }

  /** Detail z ČSFD (z DB, nebo nově stažený). Uloží i hodnocení, aby se nestahovalo zvlášť. */
  async function getDetail(csfdId) {
    const cached = db.metaGet(csfdId);
    if (cached && now() - cached.fetched_at < ttlByYear(cached.data.year, now(), config)) {
      stats.metaCacheHits++;
      return cached.data;
    }
    if (!detailInflight.has(csfdId)) {
      detailInflight.set(
        csfdId,
        (async () => {
          try {
            const d = compactDetail(await csfdClient.movie(csfdId), csfdId);
            stats.metaFetches++;
            db.metaPut(csfdId, d, now());
            const old = Number.isFinite(d.year) && new Date(now()).getUTCFullYear() - d.year >= 2;
            db.ratingPut({
              csfd: csfdId,
              rating: d.rating,
              rating_count: d.ratingCount,
              color: d.colorRating,
              title: d.title,
              year: d.year,
              type: d.type,
              fetched_at: now(),
              // Seriály bez IMDb nemají stav z Cinemety: staré se berou jako ukončené.
              series_status: isSeriesType(d.type) && old ? 'ended' : null
            });
            return d;
          } finally {
            detailInflight.delete(csfdId);
          }
        })()
      );
    }
    try {
      return await detailInflight.get(csfdId);
    } catch (e) {
      if (cached) return cached.data;
      throw e;
    }
  }

  /** Cizí titul: originální a další názvy z detailu → Cinemeta. Běží na pozadí. */
  function deepCheck(item, type) {
    if (deepInflight.has(item.id)) return;
    deepInflight.add(item.id);
    stats.deepChecks++;
    (async () => {
      try {
        const d = await getDetail(item.id);
        const imdb = await cinemetaLookup(type, [d.title, ...d.titlesOther], d.year ?? item.year);
        if (imdb) rememberImdb(item.id, imdb, 'cinemeta-alt', item);
        else db.classPut(item.id, null, 'none', now());
      } catch (e) {
        log(`[csfd-only] ${item.id}: ${e.message}`);
      } finally {
        deepInflight.delete(item.id);
      }
    })();
  }

  /** 'imdb' | 'only' | 'pending' */
  async function classify(item, type) {
    if (db.imdbForCsfd(item.id).length) return 'imdb';
    const c = db.classGet(item.id);
    if (c?.imdb) return 'imdb';
    if (c && now() - c.checked_at < config.csfdOnlyRecheckDays * DAY) return 'only';

    let hit = null;
    try {
      hit = await cinemetaLookup(type, [item.title], item.year);
    } catch (e) {
      log(`[csfd-only] Cinemeta "${item.title}": ${e.message}`);
      // Cinemeta nedostupná: česká a slovenská produkce se ukáže, nic se neukládá.
      return isCzSk(item.origins) ? 'only' : 'pending';
    }
    if (hit) {
      rememberImdb(item.id, hit, 'cinemeta', item);
      return 'imdb';
    }
    if (isCzSk(item.origins)) {
      db.classPut(item.id, null, 'none', now());
      return 'only';
    }
    // Cizí titul: český název nestačí, ověří se přes originální název na pozadí.
    deepCheck(item, type);
    return 'pending';
  }

  /** Hledání: jen tituly bez IMDb, v pořadí z ČSFD. Vrací pole Stremio meta preview. */
  async function search(type, query) {
    stats.searches++;
    const q = String(query ?? '').trim();
    if (!q) return [];
    try {
      const r = await csfdClient.search(q);
      const allowed = type === 'series' ? SERIES_TYPES : MOVIE_TYPES;
      const list = (type === 'series' ? r.tvSeries : r.movies)
        .filter((x) => Number.isFinite(x.id) && allowed.has(x.type))
        .slice(0, config.csfdOnlySearchLimit);
      const verdicts = await mapLimit(list, 4, (item) => classify(item, type));
      const metas = [];
      list.forEach((item, k) => {
        if (verdicts[k] === 'imdb') stats.excludedImdb++;
        else if (verdicts[k] === 'pending') stats.pending++;
        else {
          metas.push({
            id: `${ID_PREFIX}${item.id}`,
            type,
            name: item.title,
            poster: posterUrl(item.poster),
            releaseInfo: Number.isFinite(item.year) ? String(item.year) : undefined,
            description: (item.origins ?? []).join(' / ') || undefined
          });
        }
      });
      stats.results += metas.length;
      return metas;
    } catch (e) {
      stats.errors++;
      throw e;
    }
  }

  /** Metadata pro csfd:<ID> (u seriálu s díly z ČSFD). */
  async function meta(type, csfdId) {
    stats.metaRequests++;
    try {
      const d = await getDetail(csfdId);
      const series = isSeriesType(d.type);
      const m = {
        id: `${ID_PREFIX}${csfdId}`,
        type: series ? 'series' : 'movie',
        name: d.title,
        poster: d.poster ?? undefined,
        background: d.background ?? undefined,
        description: d.description ?? undefined,
        releaseInfo: d.year ? String(d.year) : undefined,
        year: d.year ?? undefined,
        genres: d.genres,
        director: d.directors,
        cast: d.actors,
        runtime: d.duration ? `${d.duration} min` : undefined,
        country: d.origins.join(', ') || undefined,
        links: [{ name: 'ČSFD', category: 'ČSFD', url: `https://www.csfd.cz/film/${csfdId}/` }]
      };
      if (series) {
        let list = [];
        try {
          list = (await episodes.listByCsfd(csfdId, ttlByYear(d.year, now(), config))).list;
        } catch (e) {
          log(`[csfd-only] díly ${csfdId}: ${e.message}`);
        }
        // ČSFD u dílů nemá datum vysílání; datum začátku seriálu, aby je Nuvio bralo jako vydané.
        const released = new Date(Date.UTC(d.year || 2000, 0, 1)).toISOString();
        m.videos = list.map((e) => ({
          id: `${ID_PREFIX}${csfdId}:${e.season}:${e.episode}`,
          title: e.title || `Epizoda ${e.episode}`,
          season: e.season,
          episode: e.episode,
          released
        }));
      }
      return m;
    } catch (e) {
      stats.errors++;
      throw e;
    }
  }

  /** Hodnocení dílu seriálu bez IMDb. */
  async function episodeRating(csfdId, season, episode) {
    const d = db.metaGet(csfdId)?.data;
    return episodes.resolveEpisodeByCsfd(csfdId, season, episode, ttlByYear(d?.year, now(), config));
  }

  return { search, meta, episodeRating, getDetail, stats };
}
