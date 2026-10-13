import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createRefresher } from '../src/refresh.js';
import { parsePairsCsv } from '../src/wikidata.js';
import { createLimiter } from '../src/limiter.js';

const config = { wikidataRefreshDays: 7, wikidataMaxDropPercent: 5, wikidataUserAgent: 'test', wikidataPauseMs: 0 };
const quiet = () => {};

test('parsePairsCsv vezme jen platné páry', () => {
  const csv = 'imdb,csfd\r\ntt0110912,8852\r\nnm0000233,123\r\ntt1,abc\r\n"tt0116790","8805"\r\n';
  assert.deepEqual(parsePairsCsv(csv), [['tt0110912', 8852], ['tt0116790', 8805]]);
});

// Podvržená Wikidata: každá z 9 částí vrátí `perChunk` párů, count dotaz vrátí součet.
const fakeWikidata = (perChunk) => async (_url, opts) => {
  const q = new URLSearchParams(opts.body).get('query');
  if (q.includes('COUNT')) {
    return new Response(JSON.stringify({ results: { bindings: [{ n: { value: String(perChunk * 9) } }] } }));
  }
  const prefix = q.match(/STRSTARTS\(\?csfd, "(\d)"\)/)[1];
  let csv = 'imdb,csfd\n';
  for (let i = 0; i < perChunk; i++) csv += `tt${prefix}${i},${prefix}${i}\n`;
  return new Response(csv);
};

test('obnova naplní mapování a ochrání před velkým poklesem', async () => {
  const db = openDb(':memory:');
  const r1 = await createRefresher({ db, config, fetchImpl: fakeWikidata(100), log: quiet }).refresh();
  assert.equal(r1.ok, true);
  assert.equal(db.wdCount(), 900);
  assert.deepEqual(db.wdCsfdIds('tt50'), [50]);

  const r2 = await createRefresher({ db, config, fetchImpl: fakeWikidata(50), log: quiet }).refresh();
  assert.equal(r2.ok, false, 'pokles na polovinu se nepoužije');
  assert.equal(db.wdCount(), 900);

  const r3 = await createRefresher({ db, config, fetchImpl: fakeWikidata(50), log: quiet }).refresh({ force: true });
  assert.equal(r3.ok, true);
  assert.equal(db.wdCount(), 450);
});

test('refreshIfDue spouští jen když je potřeba', async () => {
  const db = openDb(':memory:');
  let clock = 10 * 86400_000;
  const ref = createRefresher({ db, config, fetchImpl: fakeWikidata(10), log: quiet, now: () => clock });
  const p = ref.refreshIfDue();
  assert.ok(p, 'prázdné mapování → spustit');
  await p;
  assert.equal(ref.refreshIfDue(), null, 'čerstvé → nespouštět');
  clock += 8 * 86400_000;
  assert.ok(ref.refreshIfDue(), 'po 8 dnech → spustit');
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
