import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createResolver, ratingTtlMs } from '../src/resolver.js';

const config = {
  ttlFilmOldDays: 365,
  ttlFilmLastYearDays: 90,
  ttlFilmNewDays: 3,
  ttlSeriesEndedDays: 365,
  ttlSeriesOngoingDays: 3,
  seriesStatusCheckDays: 30,
  missTtlDays: 7
};
const DAY = 86400_000;
const NOW = Date.UTC(2026, 9, 13);
const quiet = () => {};

function setup({ movies = {}, search = { movies: [], tvSeries: [] }, meta = null, status = {}, start = NOW } = {}) {
  const db = openDb(':memory:');
  let clock = start;
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
  const getSeriesStatus = async (id) => {
    calls.status = (calls.status || 0) + 1;
    const v = status[id];
    if (v instanceof Error) throw v;
    return v ?? null;
  };
  const resolver = createResolver({ db, csfdClient, getMeta, getSeriesStatus, config, now: () => clock, log: quiet });
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
  s.tick(300 * DAY);
  await s.resolver.resolve('tt0110912');
  assert.equal(s.calls.movie, 1, 'starý film: po 300 dnech pořád z cache');
  s.tick(66 * DAY);
  await s.resolver.resolve('tt0110912');
  assert.equal(s.calls.movie, 2, 'starý film: po roce znovu stáhnout');
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
  s.tick(366 * DAY);
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

test('nový film: hodnocení platí 3 dny, loňský 90 dní', async () => {
  // začátek roku, aby se během testu nezměnil rok (a tím stáří filmu)
  const s = setup({ movies: { 2: film({ year: 2026 }), 3: film({ year: 2025 }) }, start: Date.UTC(2026, 1, 1) });
  s.db.replaceWdMap([['tt8', 2], ['tt9', 3]]);
  await s.resolver.resolve('tt8');
  await s.resolver.resolve('tt9');
  s.tick(2 * DAY);
  await s.resolver.resolve('tt8');
  assert.equal(s.calls.movie, 2, 'letošní po 2 dnech z cache');
  s.tick(2 * DAY);
  await s.resolver.resolve('tt8');
  await s.resolver.resolve('tt9');
  assert.equal(s.calls.movie, 3, 'letošní po 4 dnech znovu, loňský z cache');
  s.tick(90 * DAY);
  await s.resolver.resolve('tt9');
  assert.equal(s.calls.movie, 4, 'loňský po 94 dnech znovu');
});

test('ratingTtlMs: filmy podle roku, seriály podle stavu', () => {
  const f = (year) => ratingTtlMs({ type: 'film', year }, NOW, config) / DAY;
  assert.equal(f(2026), 3);
  assert.equal(f(2027), 3, 'budoucí = nový');
  assert.equal(f(null), 3, 'bez roku = nový');
  assert.equal(f(2025), 90);
  assert.equal(f(2024), 365);
  assert.equal(f(1994), 365);
  const sr = (series_status, year = 2008) => ratingTtlMs({ type: 'series', year, series_status }, NOW, config) / DAY;
  assert.equal(sr('ended'), 365);
  assert.equal(sr('continuing', 1999), 3, 'běžící se neřídí rokem začátku');
  assert.equal(sr(null, 1990), 3, 'nezjištěný stav = krátce');
  assert.equal(ratingTtlMs({ type: 'tv-show', year: 2000, series_status: 'ended' }, NOW, config) / DAY, 365);
});

const series = (o = {}) => film({ type: 'series', year: 2008, ...o });

test('seriál: stav z Cinemety se uloží, ukončený platí rok', async () => {
  const s = setup({ movies: { 10: series() }, status: { tt0903747: { status: 'ended', endYear: 2013 } } });
  s.db.replaceWdMap([['tt0903747', 10]]);
  const r = await s.resolver.resolve('tt0903747');
  assert.equal(r.row.series_status, 'ended');
  assert.equal(r.row.series_end_year, 2013);
  s.tick(29 * DAY);
  await s.resolver.resolve('tt0903747');
  assert.equal(s.calls.movie, 1);
  assert.equal(s.calls.status, 1, 'do 30 dní se Cinemeta znovu neptá');
});

test('ukončený seriál: měsíční kontrola, beze změny hodnocení nestahuje', async () => {
  const s = setup({ movies: { 10: series() }, status: { tt1: { status: 'ended', endYear: 2013 } } });
  s.db.replaceWdMap([['tt1', 10]]);
  await s.resolver.resolve('tt1');
  s.tick(31 * DAY);
  await s.resolver.resolve('tt1');
  assert.equal(s.calls.status, 2, 'po 30 dnech kontrola');
  assert.equal(s.calls.movie, 1, 'pořád ukončený → hodnocení zůstává');
  s.tick(5 * DAY);
  await s.resolver.resolve('tt1');
  assert.equal(s.calls.status, 2, 'další kontrola až za 30 dní od poslední');
  assert.equal(s.resolver.stats.seriesStatusChecks, 1);
});

test('ukončený seriál se rozjel → stáhnout znovu a brát jako běžící', async () => {
  const status = { tt2: { status: 'ended', endYear: 2019 } };
  const s = setup({ movies: { 20: series({ rating: 80 }) }, status });
  s.db.replaceWdMap([['tt2', 20]]);
  await s.resolver.resolve('tt2');
  status.tt2 = { status: 'continuing', endYear: null };
  s.tick(31 * DAY);
  const r = await s.resolver.resolve('tt2');
  assert.equal(s.calls.movie, 2, 'po změně stavu znovu z ČSFD');
  assert.equal(r.row.series_status, 'continuing');
  assert.equal(s.resolver.stats.seriesRevived, 1);
  s.tick(4 * DAY);
  await s.resolver.resolve('tt2');
  assert.equal(s.calls.movie, 3, 'jako běžící platí 3 dny');
});

test('ukončený seriál s novou sezónou (jiný rok konce) → stáhnout znovu', async () => {
  const status = { tt3: { status: 'ended', endYear: 2019 } };
  const s = setup({ movies: { 30: series() }, status });
  s.db.replaceWdMap([['tt3', 30]]);
  await s.resolver.resolve('tt3');
  status.tt3 = { status: 'ended', endYear: 2026 };
  s.tick(31 * DAY);
  const r = await s.resolver.resolve('tt3');
  assert.equal(s.calls.movie, 2);
  assert.equal(r.row.series_end_year, 2026);
});

test('Cinemeta nedostupná: nový seriál krátce, ukončený zůstane', async () => {
  const status = { tt4: new Error('down') };
  const s = setup({ movies: { 40: series() }, status });
  s.db.replaceWdMap([['tt4', 40]]);
  const r = await s.resolver.resolve('tt4');
  assert.equal(r.row.series_status, null, 'stav nezjištěn');
  s.tick(4 * DAY);
  status.tt4 = { status: 'ended', endYear: 2013 };
  await s.resolver.resolve('tt4');
  assert.equal(s.calls.movie, 2);
  status.tt4 = new Error('down again');
  s.tick(40 * DAY);
  await s.resolver.resolve('tt4');
  assert.equal(s.calls.movie, 2, 'kontrola selhala → hodnocení zůstává');
});

test('film se na Cinemetu neptá', async () => {
  const s = setup({ movies: { 50: film() } });
  s.db.replaceWdMap([['tt5x', 50]]);
  await s.resolver.resolve('tt5x');
  assert.equal(s.calls.status || 0, 0);
});
