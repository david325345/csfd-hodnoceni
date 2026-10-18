// Hodnocení jednotlivých dílů seriálu.
// Seznam dílů (všechny série) je na ČSFD na jedné stránce /film/{id}/epizody/
// (500 dílů na stránku), stahuje se celý a ukládá do DB.
const DAY = 24 * 3600_000;
const CODE_RE = /\((?:S(\d+))?E(\d+)\)/;
const SERIES_TYPES = new Set(['series', 'tv-show']);

/**
 * Z HTML stránky /epizody/ vytáhne díly: { season, episode, csfdId, path, title, rating }.
 * Značka "(S01E05)" → série 1, díl 5; "(E05)" (seriál bez sérií) → série 1, díl 5.
 * `hasSeasons` = aspoň jeden díl má značku série.
 */
export function parseEpisodeList(html) {
  const episodes = [];
  const seen = new Set();
  let hasSeasons = false;
  for (const tr of String(html).split(/<tr[\s>]/).slice(1)) {
    const code = tr.match(CODE_RE);
    const a = tr.match(/<a\b[^>]*film-title-name[^>]*>([^<]*)<\/a>/);
    if (!code || !a) continue;
    if (code[1]) hasSeasons = true;
    const season = code[1] ? Number(code[1]) : 1;
    const episode = Number(code[2]);
    const key = `${season}:${episode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const href = (a[0].match(/href="([^"]+)"/) || [])[1] || null;
    const id = href && href.match(/\/film\/\d+[^/]*\/(\d+)/);
    const pct = tr.match(/td-rating[^>]*>\s*(\d+(?:[,.]\d+)?)\s*%/);
    episodes.push({
      season,
      episode,
      csfdId: id ? Number(id[1]) : null,
      path: href ? href.replace(/prehled\/?$/, '') : null,
      title: a[1].trim() || null,
      rating: pct ? Number(pct[1].replace(',', '.')) : null
    });
  }
  return { episodes, hasSeasons };
}

/** Odkazuje stránka na další stránku seznamu? */
export const hasNextPage = (html, page) => new RegExp(`[?&]page=${page + 1}(?!\\d)`).test(html);

/** Je to stránka ČSFD (a ne ověření proti botům)? */
export const isCsfdPage = (html) => /<title>[^<]*SFD\.(cz|sk)/i.test(html);

/**
 * Platnost seznamu dílů pro danou sérii podle data posledního dílu série (z Cinemety):
 * 2+ roky staré dlouho, loňské středně, letošní, budoucí a bez data krátce.
 */
export function episodeTtlMs(lastReleasedMs, nowMs, config) {
  const age = Number.isFinite(lastReleasedMs)
    ? new Date(nowMs).getUTCFullYear() - new Date(lastReleasedMs).getUTCFullYear()
    : -1;
  const days = age >= 2 ? config.ttlEpisodeOldDays : age === 1 ? config.ttlEpisodeLastYearDays : config.ttlEpisodeNewDays;
  return days * DAY;
}

/**
 * Rozhodne o díle podle uloženého seznamu a dílů z Cinemety.
 * Vrací { ep } nebo { reason } (proč se hodnocení nevrací).
 */
export function pickEpisode({ list, hasSeasons, videos }, season, episode) {
  if (season < 1) return { reason: 'season0' };
  const csfdSeasons = new Set(list.map((e) => e.season));
  const cmSeasons = videos ? Object.keys(videos.seasons).length : 0;
  // ČSFD čísluje díly za sebou (One Piece), Cinemeta/TVDB v sériích → nejde spolehlivě spárovat.
  if (!hasSeasons && csfdSeasons.size <= 1 && cmSeasons >= 2) return { reason: 'absolute' };
  if (videos?.seasons[season]) {
    const csfdCount = list.filter((e) => e.season === season).length;
    // Méně dílů na ČSFD než v Cinemetě = hrozí posun čísel.
    if (csfdCount < videos.seasons[season].count) return { reason: 'season-short' };
  }
  const ep = list.find((e) => e.season === season && e.episode === episode);
  if (!ep) return { reason: 'not-found' };
  if (!Number.isFinite(ep.rating)) return { reason: 'no-rating' };
  return { ep };
}

export function createEpisodeResolver({
  db,
  csfdClient,
  resolver,
  getSeriesVideos = async () => null,
  config,
  now = () => Date.now(),
  log = console.log
}) {
  const inflight = new Map();
  const videosCache = new Map(); // imdb → { at, value }
  const VIDEOS_MS = 6 * 3600_000;
  const stats = {
    requests: 0,
    found: 0,
    listFetches: 0,
    listCacheHits: 0,
    newEpisodeRefetch: 0,
    staleServed: 0,
    challengeRetries: 0,
    skipped: { notSeries: 0, season0: 0, absolute: 0, seasonShort: 0, notFound: 0, noRating: 0, emptyList: 0 },
    errors: 0
  };

  async function videosFor(imdbId) {
    const c = videosCache.get(imdbId);
    if (c && now() - c.at < VIDEOS_MS) return c.value;
    let value = null;
    try {
      value = await getSeriesVideos(imdbId);
    } catch (e) {
      log(`[episodes] Cinemeta ${imdbId}: ${e.message}`);
      return c?.value ?? null;
    }
    if (videosCache.size > 500) videosCache.clear();
    videosCache.set(imdbId, { at: now(), value });
    return value;
  }

  /** Stáhne celý seznam dílů z ČSFD (všechny stránky). */
  async function downloadList(seriesCsfd) {
    const all = [];
    let hasSeasons = false;
    for (let page = 1; page <= config.episodeMaxPages; page++) {
      const url = `https://www.csfd.cz/film/${seriesCsfd}/epizody/${page > 1 ? `?page=${page}` : ''}`;
      let r = await csfdClient.fetchHtml(url);
      if (!isCsfdPage(r.html)) {
        // Ověření proti botům: knihovna ho vyřeší při stažení detailu, pak znovu.
        stats.challengeRetries++;
        await csfdClient.movie(seriesCsfd);
        r = await csfdClient.fetchHtml(url);
        if (!isCsfdPage(r.html)) throw new Error(`ČSFD vrátilo ověření místo seznamu dílů (HTTP ${r.status})`);
      }
      if (r.status === 404) break;
      if (r.status >= 400) throw new Error(`ČSFD HTTP ${r.status}`);
      const p = parseEpisodeList(r.html);
      all.push(...p.episodes);
      hasSeasons ||= p.hasSeasons;
      if (!p.episodes.length || !hasNextPage(r.html, page)) break;
    }
    return { list: all, hasSeasons };
  }

  /** Seznam dílů z DB, nebo nově stažený, když je pro danou sérii prošlý nebo chybí nový díl. */
  async function getList(seriesCsfd, imdbId, season, episode) {
    const videos = await videosFor(imdbId);
    const stored = db.episodeListGet(seriesCsfd);
    let refetch = !stored;
    if (stored) {
      const lastReleased = videos?.seasons[season]?.lastReleased;
      if (now() - stored.fetched_at >= episodeTtlMs(lastReleased, now(), config)) refetch = true;
      else {
        const has = db.episodeGet(seriesCsfd, season, episode);
        const released = videos?.released[`${season}:${episode}`];
        // Díl podle Cinemety už vyšel po posledním stažení → stáhnout hned.
        if (!has && Number.isFinite(released) && released <= now() && released > stored.fetched_at) {
          stats.newEpisodeRefetch++;
          refetch = true;
        }
      }
    }
    if (!refetch) {
      stats.listCacheHits++;
      return { list: db.episodesAll(seriesCsfd), hasSeasons: Boolean(stored.has_seasons), videos };
    }

    const key = seriesCsfd;
    if (!inflight.has(key)) {
      inflight.set(
        key,
        (async () => {
          try {
            const d = await downloadList(seriesCsfd);
            stats.listFetches++;
            db.episodesReplace(seriesCsfd, d.list, d.hasSeasons, now());
            return d;
          } finally {
            inflight.delete(key);
          }
        })()
      );
    }
    try {
      const d = await inflight.get(key);
      return { ...d, videos };
    } catch (e) {
      if (stored) {
        stats.staleServed++;
        log(`[episodes] ${seriesCsfd}: ${e.message} → vracím uložený seznam`);
        return { list: db.episodesAll(seriesCsfd), hasSeasons: Boolean(stored.has_seasons), videos };
      }
      throw e;
    }
  }

  /**
   * Hodnocení dílu. Vrací { seriesCsfdId, ep, reason } — `ep` jen při jisté shodě.
   * Chyba = ČSFD i DB nedostupné.
   */
  async function resolveEpisode(imdbId, season, episode) {
    stats.requests++;
    try {
      const series = await resolver.resolve(imdbId, { type: 'series' });
      if (!series) return { reason: 'series-not-found' };
      if (series.row.type && !SERIES_TYPES.has(series.row.type)) {
        stats.skipped.notSeries++;
        return { seriesCsfdId: series.csfdId, reason: 'not-series' };
      }
      if (season < 1) {
        stats.skipped.season0++;
        return { seriesCsfdId: series.csfdId, reason: 'season0' };
      }
      const data = await getList(series.csfdId, imdbId, season, episode);
      if (!data.list.length) {
        stats.skipped.emptyList++;
        return { seriesCsfdId: series.csfdId, reason: 'empty-list' };
      }
      const r = pickEpisode(data, season, episode);
      if (r.ep) stats.found++;
      else {
        const k = { 'season-short': 'seasonShort', 'not-found': 'notFound', 'no-rating': 'noRating' }[r.reason] ?? r.reason;
        if (k in stats.skipped) stats.skipped[k]++;
      }
      return { seriesCsfdId: series.csfdId, ...r };
    } catch (e) {
      stats.errors++;
      throw e;
    }
  }

  return { resolveEpisode, stats };
}
