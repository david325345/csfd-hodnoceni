// Aktualizace Wikidata mapování: pravidelně přírůstek, občas plné stažení.
import { fetchAllRows, fetchDelta, fetchTotalCount } from './wikidata.js';

const DAY = 24 * 3600_000;
const FAIL_BACKOFF = 6 * 3600_000;
const DELTA_OVERLAP = DAY; // přírůstek se bere o den dřív, ať se nic neztratí

export function createRefresher({ db, config, fetchImpl, log = console.log, now = () => Date.now() }) {
  let running = null;
  const opts = () => ({
    userAgent: config.wikidataUserAgent,
    fetchImpl,
    log,
    pauseMs: config.wikidataPauseMs ?? 1000
  });

  async function runFull({ force }) {
    const syncStart = now();
    const rows = await fetchAllRows(opts());
    const total = await fetchTotalCount(opts());
    if (total && rows.length < total * 0.99) {
      log(`[wikidata] varování: staženo ${rows.length} z ${total} párů`);
    }

    const prev = db.wdCount();
    const minAllowed = prev * (1 - config.wikidataMaxDropPercent / 100);
    if (!force && prev > 0 && rows.length < minAllowed) {
      throw new Error(
        `nové mapování má ${rows.length} párů, předchozí ${prev} — pokles nad ${config.wikidataMaxDropPercent} %, ponechávám staré`
      );
    }

    db.replaceWdMap(rows.map((r) => [r.imdb, r.csfd, r.item]));
    db.kvPut('wd_last_full', syncStart);
    db.kvPut('wd_last_sync', syncStart);
    return { mode: 'full', count: db.wdCount(), previous: prev };
  }

  async function runIncremental() {
    const syncStart = now();
    const lastSync = Number(db.kvGet('wd_last_sync') || 0);
    const since = lastSync - DELTA_OVERLAP;
    const items = await fetchDelta(since, opts());
    const prev = db.wdCount();
    db.applyWdDelta(items);
    db.kvPut('wd_last_sync', syncStart);
    db.kvPut('wd_last_delta_items', items.size);
    return { mode: 'incremental', items: items.size, count: db.wdCount(), previous: prev };
  }

  /**
   * @param mode 'full' | 'incremental' (výchozí: podle toho, co je na řadě)
   * @param force u plného stažení přeskočí kontrolu poklesu
   */
  async function refresh({ mode, force = false } = {}) {
    if (running) return running;
    const lastFull = Number(db.kvGet('wd_last_full') || 0);
    // Přírůstek má smysl jen nad existujícím plným stažením.
    const chosen = mode === 'incremental' && lastFull ? 'incremental' : 'full';

    running = (async () => {
      const started = now();
      log(`[wikidata] ${chosen === 'full' ? 'plné stažení' : 'přírůstek'} začíná`);
      try {
        const result = chosen === 'full' ? await runFull({ force }) : await runIncremental();
        db.kvPut('wd_last_attempt', now());
        db.kvPut('wd_last_mode', chosen);
        db.kvPut('wd_last_error', '');
        const secs = Math.round((now() - started) / 1000);
        const detail = chosen === 'incremental' ? `${result.items} změněných položek, ` : '';
        log(`[wikidata] hotovo (${chosen}): ${detail}${result.count} párů (předtím ${result.previous}), ${secs} s`);
        return { ok: true, ...result };
      } catch (e) {
        log(`[wikidata] ${chosen} selhalo: ${e.message}`);
        db.kvPut('wd_last_error', `${chosen}: ${e.message}`);
        db.kvPut('wd_last_attempt', now());
        return { ok: false, mode: chosen, reason: e.message };
      } finally {
        running = null;
      }
    })();
    return running;
  }

  /** Spustí plné stažení nebo přírůstek, pokud je na řadě. Jinak vrací null. */
  function refreshIfDue() {
    const t = now();
    const lastFull = Number(db.kvGet('wd_last_full') || 0);
    const lastSync = Number(db.kvGet('wd_last_sync') || 0);
    const lastAttempt = Number(db.kvGet('wd_last_attempt') || 0);
    // Po neúspěchu zkusit znovu nejdřív za 6 hodin.
    if (lastAttempt > lastSync && t - lastAttempt < FAIL_BACKOFF) return null;
    if (!lastFull || t - lastFull > config.wikidataFullDays * DAY) return refresh({ mode: 'full' });
    if (t - lastSync > config.wikidataIncrementalDays * DAY) return refresh({ mode: 'incremental' });
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
