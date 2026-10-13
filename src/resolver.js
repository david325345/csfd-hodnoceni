// Jádro: IMDb ID → ČSFD ID → hodnocení.
import { pickMatch } from './matcher.js';
import { isNotFound } from './csfd.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NON_TITLE_TYPES = new Set(['season', 'episode']);

export function createResolver({ db, csfdClient, getMeta, config, now = () => Date.now(), log = console.log }) {
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
    errors: 0
  };

  /** Hodnocení podle ČSFD ID, z cache nebo čerstvě. Vrací řádek tabulky rating. */
  async function getRating(csfdId) {
    const cached = db.ratingGet(csfdId);
    if (cached && now() - cached.fetched_at < config.ratingTtlHours * HOUR) {
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
        fetched_at: now()
      };
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
  async function ratingFromCandidates(ids) {
    let lastErr = null;
    for (const id of ids) {
      try {
        const r = await getRating(id);
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
      const r = await ratingFromCandidates([own.csfd]);
      if (r) return { ...r, source: 'own' };
    }
    const wd = db.wdCsfdIds(imdbId);
    if (wd.length) {
      const r = await ratingFromCandidates(wd);
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
    const r = await ratingFromCandidates([fb.match]);
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
