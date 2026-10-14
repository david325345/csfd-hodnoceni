// Jádro: IMDb ID → ČSFD ID → hodnocení.
import { pickMatch } from './matcher.js';
import { isNotFound } from './csfd.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NON_TITLE_TYPES = new Set(['season', 'episode']);

const SERIES_TYPES = new Set(['series', 'tv-show']);

export const isSeriesType = (type) => SERIES_TYPES.has(type);

/**
 * Platnost uloženého hodnocení.
 * Filmy podle roku vydání: 2+ roky staré dlouho, loňské středně, letošní/bez roku krátce.
 * Seriály podle stavu z Cinemety: ukončené dlouho, běžící a nezjištěné krátce.
 */
export function ratingTtlMs(row, nowMs, config) {
  if (isSeriesType(row.type)) {
    const days = row.series_status === 'ended' ? config.ttlSeriesEndedDays : config.ttlSeriesOngoingDays;
    return days * DAY;
  }
  const currentYear = new Date(nowMs).getUTCFullYear();
  const age = Number.isFinite(row.year) && row.year > 0 ? currentYear - row.year : -1;
  const days = age >= 2 ? config.ttlFilmOldDays : age === 1 ? config.ttlFilmLastYearDays : config.ttlFilmNewDays;
  return days * DAY;
}

export function createResolver({
  db,
  csfdClient,
  getMeta,
  getSeriesStatus = async () => null,
  config,
  now = () => Date.now(),
  log = console.log
}) {
  const inflight = new Map();
  const stats = {
    requests: 0,
    bySource: { own: 0, wikidata: 0, search: 0 },
    notFound: 0,
    missCacheHits: 0,
    fallback: { attempts: 0, matched: 0, noMeta: 0, noMatch: 0, ambiguous: 0, errors: 0 },
    ratingFetches: 0,
    ratingCacheHits: 0,
    staleServed: 0,
    seriesStatusChecks: 0,
    seriesRevived: 0,
    errors: 0
  };

  /** Stav seriálu z Cinemety; chyba = nezjištěno. */
  async function seriesStatus(imdbId) {
    try {
      return (await getSeriesStatus(imdbId)) ?? { status: null, endYear: null };
    } catch (e) {
      log(`[cinemeta] ${imdbId}: ${e.message}`);
      return { status: null, endYear: null };
    }
  }

  /**
   * U ukončeného seriálu s platným hodnocením jednou za čas ověří stav v Cinemetě.
   * Pořád ukončený se stejným rokem konce → jen se zapíše čas kontroly.
   * Jinak (rozjel se znovu, přibyla sezóna) → false a hodnocení se stáhne znovu.
   */
  async function endedStillValid(cached, imdbId) {
    const checkedAt = cached.status_checked_at || cached.fetched_at;
    if (now() - checkedAt < config.seriesStatusCheckDays * DAY) return true;
    stats.seriesStatusChecks++;
    const s = await seriesStatus(imdbId);
    if (s.status === null) return true; // Cinemeta nedostupná, zkusí se příště
    if (s.status === 'ended' && s.endYear === cached.series_end_year) {
      db.ratingStatusChecked(cached.csfd, now());
      return true;
    }
    stats.seriesRevived++;
    log(`[series] ${imdbId}: ${cached.series_status}/${cached.series_end_year} → ${s.status}/${s.endYear}, stahuji znovu`);
    return false;
  }

  /** Hodnocení podle ČSFD ID, z cache nebo čerstvě. Vrací řádek tabulky rating. */
  async function getRating(csfdId, imdbId) {
    const cached = db.ratingGet(csfdId);
    let fresh = Boolean(cached) && now() - cached.fetched_at < ratingTtlMs(cached, now(), config);
    if (fresh && isSeriesType(cached.type) && cached.series_status === 'ended' && imdbId) {
      fresh = await endedStillValid(cached, imdbId);
    }
    if (fresh) {
      stats.ratingCacheHits++;
      return { row: cached, stale: false };
    }
    try {
      const m = await csfdClient.movie(csfdId);
      stats.ratingFetches++;
      const row = {
        csfd: csfdId,
        rating: Number.isFinite(m.rating) ? m.rating : null,
        rating_count: Number.isFinite(m.ratingCount) ? m.ratingCount : null,
        color: m.colorRating ?? null,
        title: m.title ?? null,
        year: Number.isFinite(Number(m.year)) ? Number(m.year) : null,
        type: m.type ?? null,
        fetched_at: now(),
        series_status: null,
        series_end_year: null,
        status_checked_at: null
      };
      if (isSeriesType(row.type) && imdbId) {
        const s = await seriesStatus(imdbId);
        row.series_status = s.status;
        row.series_end_year = s.endYear;
        row.status_checked_at = now();
      }
      db.ratingPut(row);
      return { row, stale: false };
    } catch (e) {
      if (cached) {
        // ČSFD nedostupné — raději starší hodnocení než nic.
        stats.staleServed++;
        log(`[rating] ${csfdId}: ${e.message} → vracím starší hodnotu`);
        return { row: cached, stale: true };
      }
      throw e;
    }
  }

  /** Z několika ČSFD ID pro jedno IMDb vybere první, které není sezóna/díl. */
  async function ratingFromCandidates(ids, imdbId) {
    let lastErr = null;
    for (const id of ids) {
      try {
        const r = await getRating(id, imdbId);
        if (ids.length > 1 && NON_TITLE_TYPES.has(r.row.type)) continue;
        return { csfdId: id, ...r };
      } catch (e) {
        if (isNotFound(e)) continue; // ID na ČSFD neexistuje (smazané/sloučené)
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
    return null;
  }

  async function fallback(imdbId) {
    stats.fallback.attempts++;
    const meta = await getMeta(imdbId);
    if (!meta) {
      stats.fallback.noMeta++;
      return { match: null, reason: 'no-meta' };
    }
    const search = await csfdClient.search(meta.name);
    const result = pickMatch(meta, search);
    if (!result.candidate) {
      if (result.reason === 'ambiguous') stats.fallback.ambiguous++;
      else stats.fallback.noMatch++;
      log(`[fallback] ${imdbId} "${meta.name}" (${meta.year}): ${result.reason}`);
      return { match: null, reason: result.reason };
    }
    stats.fallback.matched++;
    const c = result.candidate;
    db.ownPut({
      imdb: imdbId,
      csfd: c.id,
      title: c.title,
      year: Number.isFinite(c.year) ? c.year : null,
      matched_by: result.reasons.join(','),
      created_at: now()
    });
    db.missDel(imdbId);
    log(`[fallback] ${imdbId} "${meta.name}" → ČSFD ${c.id} "${c.title}" [${result.reasons.join(',')}]`);
    return { match: c.id };
  }

  async function resolveUncached(imdbId) {
    // 1) vlastní nalezené páry, 2) Wikidata
    const own = db.ownGet(imdbId);
    if (own) {
      const r = await ratingFromCandidates([own.csfd], imdbId);
      if (r) return { ...r, source: 'own' };
    }
    const wd = db.wdCsfdIds(imdbId);
    if (wd.length) {
      const r = await ratingFromCandidates(wd, imdbId);
      if (r) return { ...r, source: 'wikidata' };
    }

    // 3) negativní cache
    const miss = db.missGet(imdbId);
    if (miss && now() - miss.tried_at < config.missTtlDays * DAY) {
      stats.missCacheHits++;
      return null;
    }

    // 4) fallback: Cinemeta + hledání na ČSFD
    let fb;
    try {
      fb = await fallback(imdbId);
    } catch (e) {
      stats.fallback.errors++;
      throw e;
    }
    if (!fb.match) {
      db.missPut(imdbId, fb.reason, now());
      return null;
    }
    const r = await ratingFromCandidates([fb.match], imdbId);
    return r ? { ...r, source: 'search' } : null;
  }

  async function resolve(imdbId) {
    stats.requests++;
    if (inflight.has(imdbId)) return inflight.get(imdbId);
    const p = (async () => {
      try {
        const r = await resolveUncached(imdbId);
        if (!r) {
          stats.notFound++;
          return null;
        }
        stats.bySource[r.source]++;
        return r;
      } catch (e) {
        stats.errors++;
        throw e;
      } finally {
        inflight.delete(imdbId);
      }
    })();
    inflight.set(imdbId, p);
    return p;
  }

  return { resolve, stats };
}
