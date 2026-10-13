// Týdenní obnova Wikidata mapování s kontrolou poklesu.
import { fetchAllPairs, fetchTotalCount } from './wikidata.js';

const DAY = 24 * 3600_000;

export function createRefresher({ db, config, fetchImpl, log = console.log, now = () => Date.now() }) {
  let running = null;

  async function refresh({ force = false } = {}) {
    if (running) return running;
    running = (async () => {
      const started = now();
      log('[wikidata] obnova mapování začíná');
      try {
        const pairs = await fetchAllPairs({
          userAgent: config.wikidataUserAgent,
          fetchImpl,
          log,
          pauseMs: config.wikidataPauseMs ?? 1000
        });
        const total = await fetchTotalCount({ userAgent: config.wikidataUserAgent, fetchImpl });
        if (total && pairs.length < total * 0.99) {
          log(`[wikidata] varování: staženo ${pairs.length} z ${total} párů`);
        }

        const prev = db.wdCount();
        const minAllowed = prev * (1 - config.wikidataMaxDropPercent / 100);
        if (!force && prev > 0 && pairs.length < minAllowed) {
          const msg = `nové mapování má ${pairs.length} párů, předchozí ${prev} — pokles nad ${config.wikidataMaxDropPercent} %, ponechávám staré`;
          log(`[wikidata] ${msg}`);
          db.kvPut('wd_last_error', msg);
          db.kvPut('wd_last_attempt', now());
          return { ok: false, reason: msg };
        }

        db.replaceWdMap(pairs);
        db.kvPut('wd_last_refresh', now());
        db.kvPut('wd_last_attempt', now());
        db.kvPut('wd_last_error', '');
        const secs = Math.round((now() - started) / 1000);
        log(`[wikidata] hotovo: ${db.wdCount()} párů (předtím ${prev}), ${secs} s`);
        return { ok: true, count: db.wdCount(), previous: prev };
      } catch (e) {
        log(`[wikidata] obnova selhala: ${e.message}`);
        db.kvPut('wd_last_error', e.message);
        db.kvPut('wd_last_attempt', now());
        return { ok: false, reason: e.message };
      } finally {
        running = null;
      }
    })();
    return running;
  }

  /** Spustí obnovu, pokud je mapování prázdné nebo starší než nastavený interval. */
  function refreshIfDue() {
    const last = Number(db.kvGet('wd_last_refresh') || 0);
    const lastAttempt = Number(db.kvGet('wd_last_attempt') || 0);
    const due = !last || now() - last > config.wikidataRefreshDays * DAY;
    // Po neúspěchu zkusit znovu nejdřív za 6 hodin.
    const backoff = lastAttempt > last && now() - lastAttempt < 6 * 3600_000;
    if (due && !backoff) return refresh();
    return null;
  }

  return {
    refresh,
    refreshIfDue,
    get running() {
      return Boolean(running);
    }
  };
}
