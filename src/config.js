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
  wikidataRefreshDays: num('WIKIDATA_REFRESH_DAYS', 7),
  // Nové mapování se nepoužije, pokud má o víc než tolik % méně párů než předchozí.
  wikidataMaxDropPercent: num('WIKIDATA_MAX_DROP_PERCENT', 5),
  wikidataUserAgent:
    process.env.WIKIDATA_USER_AGENT || 'csfd-ratings/1.0 (self-hosted rating service)',

  // Cache
  ratingTtlHours: num('RATING_TTL_HOURS', 24),
  missTtlDays: num('MISS_TTL_DAYS', 7),

  // Šetrnost k ČSFD
  csfdConcurrency: num('CSFD_CONCURRENCY', 2),
  csfdDelayMs: num('CSFD_DELAY_MS', 500),

  // Volitelný token pro POST /admin/refresh-wikidata (prázdný = endpoint vypnutý)
  adminToken: process.env.ADMIN_TOKEN || ''
};
