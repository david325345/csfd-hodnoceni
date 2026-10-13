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

  // Platnost uloženého hodnocení podle stáří titulu.
  // „Starý“ = rok vydání je o víc než RATING_OLD_AFTER_YEARS let před aktuálním rokem.
  ratingTtlOldDays: num('RATING_TTL_OLD_DAYS', 90),
  ratingTtlNewDays: num('RATING_TTL_NEW_DAYS', 7),
  ratingOldAfterYears: num('RATING_OLD_AFTER_YEARS', 1),
  missTtlDays: num('MISS_TTL_DAYS', 7),

  // Šetrnost k ČSFD
  csfdConcurrency: num('CSFD_CONCURRENCY', 2),
  csfdDelayMs: num('CSFD_DELAY_MS', 500),

  // Volitelný token pro POST /admin/refresh-wikidata (prázdný = endpoint vypnutý)
  adminToken: process.env.ADMIN_TOKEN || ''
};
