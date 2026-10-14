import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wd_map (
  imdb TEXT NOT NULL,
  csfd INTEGER NOT NULL,
  item TEXT,
  PRIMARY KEY (imdb, csfd)
);
CREATE TABLE IF NOT EXISTS own_map (
  imdb       TEXT PRIMARY KEY,
  csfd       INTEGER NOT NULL,
  title      TEXT,
  year       INTEGER,
  matched_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS miss (
  imdb     TEXT PRIMARY KEY,
  reason   TEXT,
  tried_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rating (
  csfd         INTEGER PRIMARY KEY,
  rating       INTEGER,
  rating_count INTEGER,
  color        TEXT,
  title        TEXT,
  year         INTEGER,
  type         TEXT,
  fetched_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);

  // Migrace: starší verze neměla u párů Q-ID položky Wikidat. Bez něj nejde
  // přírůstková aktualizace, proto se sloupec přidá a vynutí se plné stažení.
  const cols = db.prepare('PRAGMA table_info(wd_map)').all().map((c) => c.name);
  if (!cols.includes('item')) {
    db.exec('ALTER TABLE wd_map ADD COLUMN item TEXT');
    db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run('wd_last_full', '0');
  }
  db.exec('CREATE INDEX IF NOT EXISTS wd_map_item ON wd_map (item)');

  // Migrace: stav seriálu u hodnocení (verze 1.3).
  const rcols = db.prepare('PRAGMA table_info(rating)').all().map((c) => c.name);
  if (!rcols.includes('series_status')) db.exec('ALTER TABLE rating ADD COLUMN series_status TEXT');
  if (!rcols.includes('series_end_year')) db.exec('ALTER TABLE rating ADD COLUMN series_end_year INTEGER');
  if (!rcols.includes('status_checked_at')) db.exec('ALTER TABLE rating ADD COLUMN status_checked_at INTEGER');

  const prepareWd = () => ({
    wdGet: db.prepare('SELECT csfd FROM wd_map WHERE imdb = ? ORDER BY csfd'),
    wdCount: db.prepare('SELECT COUNT(*) AS n FROM wd_map'),
    wdAmbiguous: db.prepare(
      'SELECT COUNT(*) AS n FROM (SELECT imdb FROM wd_map GROUP BY imdb HAVING COUNT(*) > 1)'
    ),
    wdDelItem: db.prepare('DELETE FROM wd_map WHERE item = ?'),
    wdIns: db.prepare('INSERT OR REPLACE INTO wd_map (imdb, csfd, item) VALUES (?, ?, ?)')
  });

  const st = {
    ownGet: db.prepare('SELECT * FROM own_map WHERE imdb = ?'),
    ownPut: db.prepare(
      `INSERT OR REPLACE INTO own_map (imdb, csfd, title, year, matched_by, created_at)
       VALUES (@imdb, @csfd, @title, @year, @matched_by, @created_at)`
    ),
    ownCount: db.prepare('SELECT COUNT(*) AS n FROM own_map'),
    missGet: db.prepare('SELECT * FROM miss WHERE imdb = ?'),
    missPut: db.prepare('INSERT OR REPLACE INTO miss (imdb, reason, tried_at) VALUES (?, ?, ?)'),
    missDel: db.prepare('DELETE FROM miss WHERE imdb = ?'),
    missCount: db.prepare('SELECT COUNT(*) AS n FROM miss'),
    ratingGet: db.prepare('SELECT * FROM rating WHERE csfd = ?'),
    ratingPut: db.prepare(
      `INSERT OR REPLACE INTO rating
         (csfd, rating, rating_count, color, title, year, type, fetched_at, series_status, series_end_year, status_checked_at)
       VALUES (@csfd, @rating, @rating_count, @color, @title, @year, @type, @fetched_at,
               @series_status, @series_end_year, @status_checked_at)`
    ),
    ratingStatusChecked: db.prepare('UPDATE rating SET status_checked_at = ? WHERE csfd = ?'),
    ratingCount: db.prepare('SELECT COUNT(*) AS n FROM rating'),
    kvGet: db.prepare('SELECT value FROM kv WHERE key = ?'),
    kvPut: db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)'),
    ...prepareWd()
  };

  return {
    raw: db,
    wdCsfdIds: (imdb) => st.wdGet.all(imdb).map((r) => r.csfd),
    wdCount: () => st.wdCount.get().n,
    wdAmbiguousCount: () => st.wdAmbiguous.get().n,

    /**
     * Nahradí celé Wikidata mapování v jedné transakci (řádky [imdb, csfd, item]).
     * Při chybě zůstane staré mapování beze změny.
     */
    replaceWdMap(rows) {
      db.exec('BEGIN');
      try {
        db.exec('DROP TABLE IF EXISTS wd_map_new');
        db.exec(
          'CREATE TABLE wd_map_new (imdb TEXT NOT NULL, csfd INTEGER NOT NULL, item TEXT, PRIMARY KEY (imdb, csfd))'
        );
        const ins = db.prepare('INSERT OR IGNORE INTO wd_map_new (imdb, csfd, item) VALUES (?, ?, ?)');
        for (const [imdb, csfd, item] of rows) ins.run(imdb, csfd, item ?? null);
        db.exec('DROP TABLE wd_map');
        db.exec('ALTER TABLE wd_map_new RENAME TO wd_map');
        db.exec('CREATE INDEX IF NOT EXISTS wd_map_item ON wd_map (item)');
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      // Po přejmenování tabulky připravit dotazy znovu.
      Object.assign(st, prepareWd());
    },

    /**
     * Přírůstková změna: pro každou změněnou položku Wikidat smaže její staré
     * páry a vloží aktuální. `items` = Map(item → [[imdb, csfd], ...]);
     * prázdný seznam = položka už žádný platný pár nemá.
     */
    applyWdDelta(items) {
      db.exec('BEGIN');
      try {
        for (const [item, pairs] of items) {
          st.wdDelItem.run(item);
          for (const [imdb, csfd] of pairs) st.wdIns.run(imdb, csfd, item);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    ownGet: (imdb) => st.ownGet.get(imdb),
    ownPut: (row) => st.ownPut.run(row),
    ownCount: () => st.ownCount.get().n,

    missGet: (imdb) => st.missGet.get(imdb),
    missPut: (imdb, reason, ts) => st.missPut.run(imdb, reason, ts),
    missDel: (imdb) => st.missDel.run(imdb),
    missCount: () => st.missCount.get().n,

    ratingGet: (csfd) => st.ratingGet.get(csfd),
    ratingPut: (row) =>
      st.ratingPut.run({ series_status: null, series_end_year: null, status_checked_at: null, ...row }),
    ratingStatusChecked: (csfd, ts) => st.ratingStatusChecked.run(ts, csfd),
    ratingCount: () => st.ratingCount.get().n,

    kvGet: (key) => st.kvGet.get(key)?.value ?? null,
    kvPut: (key, value) => st.kvPut.run(key, value == null ? null : String(value)),

    close: () => db.close()
  };
}
