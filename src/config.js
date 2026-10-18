// Konfigurace z proměnných prostředí (viz README).
const num = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Neplatná hodnota ${name}=${v}`);
  return n;
};

export const config = {
  port: num('PORT', 7020),
  dbPath: process.env.DB_PATH || './data/csfd-ratings.db',

  // Wikidata mapování IMDb → ČSFD
  // přírůstek (jen změněné položky) a plné stažení (dočistí smazané/sloučené)
  wikidataIncrementalDays: num('WIKIDATA_INCREMENTAL_DAYS', num('WIKIDATA_REFRESH_DAYS', 7)),
  wikidataFullDays: num('WIKIDATA_FULL_REFRESH_DAYS', 30),
  // Plné stažení se nepoužije, pokud má o víc než tolik % méně párů než předchozí.
  wikidataMaxDropPercent: num('WIKIDATA_MAX_DROP_PERCENT', 5),
  wikidataUserAgent:
    process.env.WIKIDATA_USER_AGENT || 'csfd-ratings/1.0 (self-hosted rating service)',

  // Platnost uloženého hodnocení.
  // Filmy podle roku vydání (vůči aktuálnímu roku): 2+ roky / loňský / letošní, budoucí a bez roku.
  ttlFilmOldDays: num('RATING_TTL_FILM_OLD_DAYS', 365),
  ttlFilmLastYearDays: num('RATING_TTL_FILM_LAST_YEAR_DAYS', 90),
  ttlFilmNewDays: num('RATING_TTL_FILM_NEW_DAYS', 3),
  // Seriály podle stavu z Cinemety: ukončené / běžící a nezjištěné.
  ttlSeriesEndedDays: num('RATING_TTL_SERIES_ENDED_DAYS', 365),
  ttlSeriesOngoingDays: num('RATING_TTL_SERIES_ONGOING_DAYS', 3),
  // Jak často u ukončeného seriálu ověřit v Cinemetě, že je pořád ukončený.
  seriesStatusCheckDays: num('SERIES_STATUS_CHECK_DAYS', 30),
  missTtlDays: num('MISS_TTL_DAYS', 7),
  // Hodnocení dílů: podle data posledního dílu série (Cinemeta) 2+ roky / loňská / letošní a bez data.
  ttlEpisodeOldDays: num('RATING_TTL_EPISODE_OLD_DAYS', 365),
  ttlEpisodeLastYearDays: num('RATING_TTL_EPISODE_LAST_YEAR_DAYS', 90),
  ttlEpisodeNewDays: num('RATING_TTL_EPISODE_NEW_DAYS', 3),
  // Max. stránek seznamu dílů (500 dílů na stránku).
  episodeMaxPages: num('EPISODE_MAX_PAGES', 6),

  // Šetrnost k ČSFD
  csfdConcurrency: num('CSFD_CONCURRENCY', 2),
  csfdDelayMs: num('CSFD_DELAY_MS', 500),

  // Stremio addon: veřejná adresa služby (jinak se odvodí z hlaviček) a cesta k ikoně
  publicUrl: process.env.PUBLIC_URL || '',
  iconPath: process.env.ICON_PATH || new URL('../public/icon.png', import.meta.url).pathname,

  // Volitelný token pro POST /admin/refresh-wikidata (prázdný = endpoint vypnutý)
  adminToken: process.env.ADMIN_TOKEN || ''
};
