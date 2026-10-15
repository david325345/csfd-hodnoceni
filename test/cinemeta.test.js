import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMeta, isValidMeta, parseSeriesStatus, getSeriesStatus } from '../src/cinemeta.js';

// Podvržená Cinemeta: odpovědi podle typu endpointu.
const fakeCinemeta = (byType) => async (url) => {
  const type = url.includes('/meta/movie/') ? 'movie' : 'series';
  const meta = byType[type];
  if (meta === 404) return new Response('', { status: 404 });
  return new Response(JSON.stringify({ meta: meta ?? {} }), { status: 200 });
};

test('isValidMeta odmítne jiné IMDb ID nebo jiný typ', () => {
  assert.equal(isValidMeta({ name: 'X', id: 'tt1', type: 'movie' }, 'tt1', 'movie'), true);
  assert.equal(isValidMeta({ name: 'Mirror', id: 'tt0072443', type: 'movie' }, 'tt0903747', 'movie'), false);
  assert.equal(isValidMeta({ name: 'Game of Thrones', id: 'tt0944947', type: 'series' }, 'tt0944947', 'movie'), false);
  assert.equal(isValidMeta({}, 'tt1', 'movie'), false);
});

test('seriálové ID: chybná filmová odpověď se přeskočí a vezme se seriál', async () => {
  const meta = await getMeta('tt0903747', {
    fetchImpl: fakeCinemeta({
      movie: { id: 'tt0072443', imdb_id: 'tt0072443', type: 'movie', name: 'Mirror', year: '1975' },
      series: { id: 'tt0903747', imdb_id: 'tt0903747', type: 'series', name: 'Breaking Bad', year: '2008–2013', cast: ['Bryan Cranston'] }
    })
  });
  assert.equal(meta.type, 'series');
  assert.equal(meta.name, 'Breaking Bad');
  assert.equal(meta.year, 2008);
});

test('seriál vrácený filmovým endpointem jako series se nebere jako film', async () => {
  const gotSeries = { id: 'tt0944947', type: 'series', name: 'Game of Thrones', year: '2011–2019' };
  const meta = await getMeta('tt0944947', { fetchImpl: fakeCinemeta({ movie: gotSeries, series: gotSeries }) });
  assert.equal(meta.type, 'series');
});

test('film projde hned z filmového endpointu', async () => {
  const meta = await getMeta('tt0110912', {
    fetchImpl: fakeCinemeta({
      movie: { id: 'tt0110912', type: 'movie', name: 'Pulp Fiction', year: '1994', director: ['Quentin Tarantino'] },
      series: 404
    })
  });
  assert.equal(meta.type, 'movie');
  assert.deepEqual(meta.directors, ['Quentin Tarantino']);
});

test('parseSeriesStatus podle skutečných odpovědí Cinemety', () => {
  assert.deepEqual(parseSeriesStatus({ releaseInfo: '2008–2013', status: 'Ended' }), { status: 'ended', endYear: 2013 });
  assert.deepEqual(parseSeriesStatus({ releaseInfo: '2016–2025', status: 'Ended' }), { status: 'ended', endYear: 2025 });
  assert.deepEqual(parseSeriesStatus({ releaseInfo: '2022–', status: 'Continuing' }), { status: 'continuing', endYear: null });
  assert.deepEqual(parseSeriesStatus({ releaseInfo: '1999–', status: 'Returning Series' }), { status: 'continuing', endYear: null });
  assert.deepEqual(parseSeriesStatus({ releaseInfo: '2005–2013' }), { status: 'ended', endYear: 2013 }, 'bez status pole z rozsahu');
  assert.deepEqual(parseSeriesStatus({ releaseInfo: '2022–' }), { status: 'continuing', endYear: null });
  assert.deepEqual(parseSeriesStatus({}), { status: null, endYear: null });
});

test('getSeriesStatus: platná odpověď, jiné ID, 404', async () => {
  const ok = await getSeriesStatus('tt0903747', {
    fetchImpl: fakeCinemeta({ series: { id: 'tt0903747', type: 'series', name: 'Breaking Bad', releaseInfo: '2008–2013', status: 'Ended' } })
  });
  assert.deepEqual(ok, { status: 'ended', endYear: 2013 });
  const wrong = await getSeriesStatus('tt0903747', { fetchImpl: fakeCinemeta({ series: { id: 'tt1', type: 'series', name: 'X' } }) });
  assert.equal(wrong, null);
  assert.equal(await getSeriesStatus('tt0903747', { fetchImpl: fakeCinemeta({ series: 404 }) }), null);
});

import { getMetas } from '../src/cinemeta.js';

test('getMeta s typem a getMetas: skutečný případ tt43691383', async () => {
  const fetchImpl = fakeCinemeta({
    movie: { id: 'tt43691383', imdb_id: 'tt43691383', type: 'movie', name: 'Baby Daze', year: '1939' },
    series: { id: 'tt43691383', imdb_id: 'tt43691383', type: 'series', name: "So What's Wrong with Getting Reborn as a Goblin", releaseInfo: '2026–' }
  });
  assert.equal((await getMeta('tt43691383', { fetchImpl })).name, 'Baby Daze', 'bez typu film napřed (stará cesta)');
  const s = await getMeta('tt43691383', { type: 'series', fetchImpl });
  assert.equal(s.type, 'series');
  assert.equal(s.year, 2026);
  assert.deepEqual((await getMetas('tt43691383', { fetchImpl })).map((m) => m.type), ['movie', 'series']);
});
