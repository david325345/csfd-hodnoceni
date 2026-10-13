import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createRefresher } from '../src/refresh.js';
import { parseRowsCsv, FULL_CHUNKS } from '../src/wikidata.js';
import { createLimiter } from '../src/limiter.js';

const DAY = 86400_000;
const config = {
  wikidataIncrementalDays: 7,
  wikidataFullDays: 30,
  wikidataMaxDropPercent: 5,
  wikidataUserAgent: 'test',
  wikidataPauseMs: 0
};
const quiet = () => {};

/**
 * Podvržená Wikidata nad seznamem položek { item, imdb|null, csfd, modified }.
 * Rozumí dotazům plného stažení (STRLEN / STRSTARTS), přírůstku (dateModified) a COUNT.
 */
function fakeWikidata(data) {
  const calls = { full: 0, delta: 0 };
  const fetchImpl = async (_url, opts) => {
    const q = new URLSearchParams(opts.body).get('query');
    if (q.includes('COUNT')) {
      const n = data.filter((d) => d.imdb).length;
      return new Response(JSON.stringify({ results: { bindings: [{ n: { value: String(n) } }] } }));
    }
    let rows;
    if (q.includes('dateModified')) {
      calls.delta++;
      const since = Date.parse(q.match(/"([^"]+)"\^\^xsd:dateTime/)[1]);
      rows = data.filter((d) => d.modified >= since);
    } else {
      calls.full++;
      const len1 = q.includes('STRLEN(?csfd) = 1');
      const prefix = q.match(/STRSTARTS\(\?csfd, "(\d+)"\)/)?.[1];
      rows = data.filter((d) => d.imdb && (len1 ? String(d.csfd).length === 1 : String(d.csfd).startsWith(prefix)));
    }
    const csv = ['i,imdb,csfd', ...rows.map((d) => `http://www.wikidata.org/entity/${d.item},${d.imdb ?? ''},${d.csfd}`)].join('\n');
    return new Response(csv);
  };
  return { fetchImpl, calls };
}

const dataset = (n, modified = 0) =>
  Array.from({ length: n }, (_, i) => ({ item: `Q${i + 1}`, imdb: `tt${1000 + i}`, csfd: i + 1, modified }));

test('parseRowsCsv: Q-ID, platné IMDb, chybějící IMDb jako null', () => {
  const csv =
    'i,imdb,csfd\r\nhttp://www.wikidata.org/entity/Q1,tt0110912,8852\r\nhttp://www.wikidata.org/entity/Q2,,77\r\n' +
    'http://www.wikidata.org/entity/Q3,nm1,5\r\nhttp://www.wikidata.org/entity/Q4,tt1,abc\r\n';
  assert.deepEqual(parseRowsCsv(csv), [
    { item: 'Q1', imdb: 'tt0110912', csfd: 8852 },
    { item: 'Q2', imdb: null, csfd: 77 },
    { item: 'Q3', imdb: null, csfd: 5 }
  ]);
});

test('plné stažení má 91 částí a pokryje jedno- i víceciferná ID', async () => {
  assert.equal(FULL_CHUNKS.length, 91);
  const db = openDb(':memory:');
  const data = [...dataset(150), { item: 'Q999', imdb: 'tt9', csfd: 1478003, modified: 0 }];
  const wd = fakeWikidata(data);
  const r = await createRefresher({ db, config, fetchImpl: wd.fetchImpl, log: quiet }).refresh({ mode: 'full' });
  assert.equal(r.ok, true);
  assert.equal(wd.calls.full, 91);
  assert.equal(db.wdCount(), 151);
  assert.deepEqual(db.wdCsfdIds('tt1000'), [1]);
  assert.deepEqual(db.wdCsfdIds('tt9'), [1478003]);
});

test('plné stažení s velkým poklesem se nepoužije (bez force)', async () => {
  const db = openDb(':memory:');
  await createRefresher({ db, config, fetchImpl: fakeWikidata(dataset(200)).fetchImpl, log: quiet }).refresh({ mode: 'full' });
  const r = await createRefresher({ db, config, fetchImpl: fakeWikidata(dataset(100)).fetchImpl, log: quiet }).refresh({ mode: 'full' });
  assert.equal(r.ok, false);
  assert.equal(db.wdCount(), 200);
  const r2 = await createRefresher({ db, config, fetchImpl: fakeWikidata(dataset(100)).fetchImpl, log: quiet }).refresh({ mode: 'full', force: true });
  assert.equal(r2.ok, true);
  assert.equal(db.wdCount(), 100);
});

test('přírůstek: přidá nové, opraví změněné, odebere pár bez IMDb', async () => {
  const db = openDb(':memory:');
  let clock = 100 * DAY;
  const data = dataset(10, 0);
  const wd = fakeWikidata(data);
  const ref = createRefresher({ db, config, fetchImpl: wd.fetchImpl, log: quiet, now: () => clock });
  await ref.refresh({ mode: 'full' });
  assert.equal(db.wdCount(), 10);

  clock += 7 * DAY;
  data[0].csfd = 555; data[0].modified = clock - DAY;              // oprava ČSFD ID
  data[1].imdb = null; data[1].modified = clock - DAY;            // IMDb odebráno
  data.push({ item: 'Q50', imdb: 'tt5000', csfd: 50, modified: clock - DAY }); // nová položka

  const r = await ref.refresh({ mode: 'incremental' });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'incremental');
  assert.equal(r.items, 3);
  assert.deepEqual(db.wdCsfdIds('tt1000'), [555], 'staré ID 1 nahrazeno');
  assert.deepEqual(db.wdCsfdIds('tt1001'), [], 'pár bez IMDb odebrán');
  assert.deepEqual(db.wdCsfdIds('tt5000'), [50], 'nová položka přidána');
  assert.equal(db.wdCount(), 10);
});

test('refreshIfDue: nejdřív plné, pak týdně přírůstek, měsíčně plné', async () => {
  const db = openDb(':memory:');
  let clock = 100 * DAY;
  const wd = fakeWikidata(dataset(20));
  const ref = createRefresher({ db, config, fetchImpl: wd.fetchImpl, log: quiet, now: () => clock });

  assert.equal((await ref.refreshIfDue()).mode, 'full');
  assert.equal(ref.refreshIfDue(), null, 'čerstvé → nic');
  clock += 8 * DAY;
  assert.equal((await ref.refreshIfDue()).mode, 'incremental');
  clock += 8 * DAY;
  assert.equal((await ref.refreshIfDue()).mode, 'incremental');
  clock += 15 * DAY;
  assert.equal((await ref.refreshIfDue()).mode, 'full', 'po 31 dnech plné');
});

test('migrace: stará tabulka bez Q-ID vynutí plné stažení', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const path = join(mkdtempSync(join(tmpdir(), 'csfd-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE wd_map (imdb TEXT NOT NULL, csfd INTEGER NOT NULL, PRIMARY KEY (imdb, csfd))');
  // Stav, jak ho zanechala první verze: úspěšný pokus před chvílí, bez chyby.
  old.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO kv VALUES ('wd_last_full', '123');
    INSERT INTO kv VALUES ('wd_last_refresh', '${Date.now() - 60_000}');
    INSERT INTO kv VALUES ('wd_last_attempt', '${Date.now() - 60_000}');
    INSERT INTO kv VALUES ('wd_last_error', '')`);
  old.exec("INSERT INTO wd_map VALUES ('tt1', 1)");
  old.close();

  const db = openDb(path);
  assert.equal(db.kvGet('wd_last_full'), '0');
  assert.deepEqual(db.wdCsfdIds('tt1'), [1], 'stará data zůstanou do plného stažení');
  const ref = createRefresher({ db, config, fetchImpl: fakeWikidata(dataset(5)).fetchImpl, log: quiet });
  assert.equal((await ref.refreshIfDue()).mode, 'full');
  db.close();
});

test('po neúspěchu 6 hodin pauza, pak znovu', async () => {
  const db = openDb(':memory:');
  let clock = 100 * DAY;
  const failing = async () => { throw new Error('boom'); };
  const ref = createRefresher({ db, config, fetchImpl: failing, log: quiet, now: () => clock });
  const r = await ref.refreshIfDue();
  assert.equal(r.ok, false);
  clock += 3600_000;
  assert.equal(ref.refreshIfDue(), null, 'za hodinu ještě ne');
  clock += 6 * 3600_000;
  assert.ok(ref.refreshIfDue(), 'po 7 hodinách znovu');
});

test('limiter dodrží souběh a rozestup', async () => {
  const lim = createLimiter({ concurrency: 2, delayMs: 30 });
  let active = 0, peak = 0;
  const starts = [];
  const job = () => lim.run(async () => {
    starts.push(Date.now());
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 50));
    active--;
  });
  await Promise.all([job(), job(), job(), job()]);
  assert.ok(peak <= 2);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 25);
});
