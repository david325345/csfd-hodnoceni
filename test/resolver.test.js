import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createResolver, ratingTtlMs } from '../src/resolver.js';

const config = { ratingTtlOldDays: 90, ratingTtlNewDays: 7, ratingOldAfterYears: 1, missTtlDays: 7 };
const DAY = 86400_000;
const NOW = Date.UTC(2026, 9, 13);
const quiet = () => {};

function setup({ movies = {}, search = { movies: [], tvSeries: [] }, meta = null } = {}) {
  const db = openDb(':memory:');
  let clock = NOW;
  const calls = { movie: 0, search: 0, meta: 0 };
  const csfdClient = {
    movie: async (id) => {
      calls.movie++;
      const m = movies[id];
      if (m instanceof Error) throw m;
      if (!m) throw Object.assign(new Error('404'), { name: 'CsfdError', reason: 'not-found' });
      return m;
    },
    search: async () => {
      calls.search++;
      return search;
    },
    pending: 0
  };
  const getMeta = async () => {
    calls.meta++;
    return meta;
  };
  const resolver = createResolver({ db, csfdClient, getMeta, config, now: () => clock, log: quiet });
  return { db, resolver, calls, tick: (ms) => (clock += ms) };
}

const film = (o = {}) => ({ rating: 85, ratingCount: 1000, colorRating: 'good', title: 'T', year: 2000, type: 'film', ...o });

test('Wikidata cesta + cache hodnocení', async () => {
  const s = setup({ movies: { 8852: film({ title: 'Pulp Fiction' }) } });
  s.db.replaceWdMap([['tt0110912', 8852]]);
  const r1 = await s.resolver.resolve('tt0110912');
  assert.equal(r1.csfdId, 8852);
  assert.equal(r1.source, 'wikidata');
  assert.equal(r1.row.rating, 85);
  await s.resolver.resolve('tt0110912');
  assert.equal(s.calls.movie, 1, 'druhý dotaz z cache');
  s.tick(30 * DAY);
  await s.resolver.resolve('tt0110912');
  assert.equal(s.calls.movie, 1, 'starý film: po 30 dnech pořád z cache');
  s.tick(61 * DAY);
  await s.resolver.resolve('tt0110912');
  assert.equal(s.calls.movie, 2, 'starý film: po 91 dnech znovu stáhnout');
});

test('víc ČSFD ID: přeskočí sezónu a neexistující ID', async () => {
  const s = setup({ movies: { 200: film({ type: 'season' }), 300: film({ type: 'series', rating: 90 }) } });
  s.db.replaceWdMap([['tt1', 100], ['tt1', 200], ['tt1', 300]]);
  const r = await s.resolver.resolve('tt1');
  assert.equal(r.csfdId, 300);
});

test('fallback najde, uloží do own_map a příště nehledá', async () => {
  const s = setup({
    movies: { 555: film({ rating: 77 }) },
    meta: { type: 'movie', name: 'New Film', year: 2026, directors: ['Jane Roe'], cast: [] },
    search: {
      movies: [{ id: 555, title: 'Nový film', year: 2026, type: 'film', creators: { directors: [{ name: 'Jane Roe' }], actors: [] } }],
      tvSeries: []
    }
  });
  const r = await s.resolver.resolve('tt9999999');
  assert.equal(r.csfdId, 555);
  assert.equal(r.source, 'search');
  assert.equal(s.db.ownGet('tt9999999').csfd, 555);
  await s.resolver.resolve('tt9999999');
  assert.equal(s.calls.search, 1);
  assert.equal(s.resolver.stats.bySource.own, 1);
});

test('neúspěch se uloží do miss a 7 dní se nehledá', async () => {
  const s = setup({ meta: { type: 'movie', name: 'Nic', year: 2026, directors: ['A B'], cast: [] } });
  assert.equal(await s.resolver.resolve('tt123'), null);
  assert.equal(await s.resolver.resolve('tt123'), null);
  assert.equal(s.calls.search, 1);
  s.tick(8 * 24 * 3600_000);
  await s.resolver.resolve('tt123');
  assert.equal(s.calls.search, 2);
});

test('ČSFD nedostupné → vrátí starší hodnocení jako stale', async () => {
  const movies = { 1: film() };
  const s = setup({ movies });
  s.db.replaceWdMap([['tt5', 1]]);
  await s.resolver.resolve('tt5');
  s.tick(91 * DAY);
  movies[1] = Object.assign(new Error('blocked'), { name: 'CsfdError', reason: 'blocked' });
  const r = await s.resolver.resolve('tt5');
  assert.equal(r.stale, true);
  assert.equal(r.row.rating, 85);
});

test('souběžné dotazy na stejné ID → jeden request', async () => {
  const s = setup({ movies: { 1: film() } });
  s.db.replaceWdMap([['tt7', 1]]);
  await Promise.all([s.resolver.resolve('tt7'), s.resolver.resolve('tt7'), s.resolver.resolve('tt7')]);
  assert.equal(s.calls.movie, 1);
});

test('nový film: hodnocení platí 7 dní', async () => {
  const s = setup({ movies: { 2: film({ year: 2026 }) } });
  s.db.replaceWdMap([['tt8', 2]]);
  await s.resolver.resolve('tt8');
  s.tick(6 * DAY);
  await s.resolver.resolve('tt8');
  assert.equal(s.calls.movie, 1);
  s.tick(2 * DAY);
  await s.resolver.resolve('tt8');
  assert.equal(s.calls.movie, 2);
});

test('ratingTtlMs podle roku', () => {
  assert.equal(ratingTtlMs(2026, NOW, config), 7 * DAY);
  assert.equal(ratingTtlMs(2025, NOW, config), 7 * DAY, 'loňský = ještě nový');
  assert.equal(ratingTtlMs(2024, NOW, config), 90 * DAY);
  assert.equal(ratingTtlMs(1994, NOW, config), 90 * DAY);
  assert.equal(ratingTtlMs(null, NOW, config), 7 * DAY, 'neznámý rok = nový');
});
