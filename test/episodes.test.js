import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { summarizeVideos } from '../src/cinemeta.js';
import { splitVariant } from '../src/addon.js';
import {
  parseEpisodeList,
  hasNextPage,
  isCsfdPage,
  episodeTtlMs,
  pickEpisode,
  createEpisodeResolver
} from '../src/episodes.js';

const DAY = 86400_000;
const NOW = Date.UTC(2026, 9, 18);
const quiet = () => {};
const config = { ttlEpisodeOldDays: 365, ttlEpisodeLastYearDays: 90, ttlEpisodeNewDays: 3, episodeMaxPages: 6 };

// Řádek ve tvaru stránky /film/{id}/epizody/ na ČSFD.
const row = (sid, eid, title, code, rating) =>
  `<tr><td class="name name-half"><h3 class="film-title-inline"><a href="/film/${sid}-serial/${eid}-dil/prehled/" class="film-title-name">${title}</a>` +
  `<span class="film-title-info"> <span class="info">(${code})</span></span></h3></td>` +
  `<td class="td-rating text-right"> ${rating == null ? '' : `${rating}%`} </td></tr>`;
const page = (rows, { next = null } = {}) =>
  `<html><head><title>Seriál (2008) | Epizody | ČSFD.cz</title></head><body><table>${rows.join('')}</table>` +
  (next ? `<a href="/film/1/epizody/?page=${next}">další</a>` : '') + '</body></html>';

test('parseEpisodeList: série, díly, desetinné hodnocení, bez hodnocení, duplicita', () => {
  const html = page([
    row(72489, 474213, 'Vánoce u Simpsonových', 'S01E01', '92,5'),
    row(72489, 474214, 'Bart génius', 'S01E02', '81'),
    row(72489, 474215, 'Nový díl', 'S02E01', null),
    row(72489, 474216, 'Duplicita', 'S01E02', '10')
  ]);
  const { episodes, hasSeasons } = parseEpisodeList(html);
  assert.equal(hasSeasons, true);
  assert.equal(episodes.length, 3);
  assert.deepEqual(episodes[0], {
    season: 1,
    episode: 1,
    csfdId: 474213,
    path: '/film/72489-serial/474213-dil/',
    title: 'Vánoce u Simpsonových',
    rating: 92.5
  });
  assert.equal(episodes[1].rating, 81);
  assert.equal(episodes[2].rating, null);
});

test('parseEpisodeList: seriál bez sérií (E01) → série 1, hasSeasons=false', () => {
  const r = parseEpisodeList(page([row(1, 2, 'A', 'E01', '80'), row(1, 3, 'B', 'E02', '70')]));
  assert.equal(r.hasSeasons, false);
  assert.deepEqual(r.episodes.map((e) => [e.season, e.episode]), [[1, 1], [1, 2]]);
});

test('hasNextPage a isCsfdPage', () => {
  assert.equal(hasNextPage(page([], { next: 2 }), 1), true);
  assert.equal(hasNextPage(page([], { next: 2 }), 2), false);
  assert.equal(hasNextPage('<a href="?page=21">', 1), false);
  assert.equal(isCsfdPage(page([])), true);
  assert.equal(isCsfdPage("<html><title>Making sure you're not a bot!</title></html>"), false);
});

test('episodeTtlMs podle data posledního dílu série', () => {
  assert.equal(episodeTtlMs(Date.UTC(2020, 5, 1), NOW, config), 365 * DAY);
  assert.equal(episodeTtlMs(Date.UTC(2024, 11, 31), NOW, config), 365 * DAY);
  assert.equal(episodeTtlMs(Date.UTC(2025, 0, 1), NOW, config), 90 * DAY);
  assert.equal(episodeTtlMs(Date.UTC(2026, 3, 1), NOW, config), 3 * DAY);
  assert.equal(episodeTtlMs(null, NOW, config), 3 * DAY);
});

test('summarizeVideos: počty a poslední datum za sérii, bez série 0', () => {
  const v = summarizeVideos([
    { season: 0, episode: 1, released: '2007-01-01T00:00:00.000Z' },
    { season: 1, episode: 1, released: '2008-01-20T00:00:00.000Z' },
    { season: 1, episode: 2, released: '2008-01-27T00:00:00.000Z' },
    { season: 2, episode: 1 }
  ]);
  assert.deepEqual(Object.keys(v.seasons), ['1', '2']);
  assert.equal(v.seasons[1].count, 2);
  assert.equal(v.seasons[1].lastReleased, Date.UTC(2008, 0, 27));
  assert.equal(v.seasons[2].lastReleased, null);
  assert.equal(v.released['1:2'], Date.UTC(2008, 0, 27));
  assert.equal(summarizeVideos([]), null);
});

const ep = (season, episode, rating = 80) => ({ season, episode, rating, csfdId: season * 100 + episode, path: null, title: null });
const vids = (counts) => ({
  seasons: Object.fromEntries(Object.entries(counts).map(([s, count]) => [s, { count, lastReleased: null }])),
  released: {}
});

test('pickEpisode: přesná shoda, speciály navíc na konci, méně dílů, číslování za sebou, série 0', () => {
  // Doctor Who: ČSFD má v sérii 14 dílů (vánoční speciál na konci), Cinemeta 13 → díly 1–13 sedí
  const dw = { list: [...Array(14)].map((_, i) => ep(1, i + 1)), hasSeasons: true, videos: vids({ 1: 13 }) };
  assert.equal(pickEpisode(dw, 1, 13).ep.episode, 13);
  assert.equal(pickEpisode(dw, 0, 1).reason, 'season0');
  // Méně dílů na ČSFD než v Cinemetě → hrozí posun
  const short = { list: [ep(2, 1), ep(2, 2)], hasSeasons: true, videos: vids({ 2: 3 }) };
  assert.equal(pickEpisode(short, 2, 1).reason, 'season-short');
  // One Piece: ČSFD jedna řada, Cinemeta víc sérií
  const op = { list: [...Array(30)].map((_, i) => ep(1, i + 1)), hasSeasons: false, videos: vids({ 1: 8, 2: 22 }) };
  assert.equal(pickEpisode(op, 1, 1).reason, 'absolute');
  // Bez dat z Cinemety: jen přesná shoda
  const noCm = { list: [ep(1, 1), ep(1, 2, null)], hasSeasons: true, videos: null };
  assert.equal(pickEpisode(noCm, 1, 1).ep.rating, 80);
  assert.equal(pickEpisode(noCm, 1, 2).reason, 'no-rating');
  assert.equal(pickEpisode(noCm, 3, 1).reason, 'not-found');
});

// --- resolver dílů s podvrženým ČSFD a Cinemetou ---
function setup({ pages, videos, seriesType = 'series' }) {
  const db = openDb(':memory:');
  let clock = NOW;
  const calls = { html: 0, movie: 0, videos: 0, urls: [] };
  let challengeOnce = false;
  const csfdClient = {
    fetchHtml: async (url) => {
      calls.html++;
      calls.urls.push(url);
      await new Promise((r) => setTimeout(r, 5));
      if (challengeOnce) {
        challengeOnce = false;
        return { status: 200, html: '<html><title>Making sure you are not a bot</title></html>' };
      }
      const p = url.match(/page=(\d+)/);
      const html = pages.current[p ? Number(p[1]) - 1 : 0];
      if (html instanceof Error) throw html;
      return { status: 200, html };
    },
    movie: async () => {
      calls.movie++;
      return {};
    }
  };
  const resolver = { resolve: async () => ({ csfdId: 237486, row: { type: seriesType } }) };
  const getSeriesVideos = async () => {
    calls.videos++;
    return videos.current;
  };
  const r = createEpisodeResolver({ db, csfdClient, resolver, getSeriesVideos, config, now: () => clock, log: quiet });
  return { db, r, calls, tick: (ms) => (clock += ms), challenge: () => (challengeOnce = true) };
}

const bb = (rating = '88,8') =>
  page([row(237486, 1, 'Pilot', 'S01E01', rating), row(237486, 2, 'Druhý', 'S01E02', '88,3'), row(237486, 3, 'Třetí', 'S02E01', '90')]);
const bbVideos = (lastS2 = Date.UTC(2009, 4, 1)) => ({
  seasons: { 1: { count: 2, lastReleased: Date.UTC(2008, 2, 1) }, 2: { count: 1, lastReleased: lastS2 } },
  released: { '1:1': Date.UTC(2008, 0, 20), '1:2': Date.UTC(2008, 0, 27), '2:1': lastS2 }
});

test('8 souběžných dotazů na díly = 1 stažení seznamu, pak z DB', async () => {
  const s = setup({ pages: { current: [bb()] }, videos: { current: bbVideos() } });
  const res = await Promise.all([...Array(8)].map((_, i) => s.r.resolveEpisode('tt0903747', i % 2 ? 1 : 2, 1)));
  assert.equal(s.calls.html, 1);
  assert.equal(res[0].ep.rating, 90);
  assert.equal(res[1].ep.rating, 88.8);
  assert.equal(res[1].ep.path, '/film/237486-serial/1-dil/');
  await s.r.resolveEpisode('tt0903747', 1, 2);
  assert.equal(s.calls.html, 1, 'další díl z DB');
  assert.equal(s.r.stats.listFetches, 1);
});

test('platnost podle stáří série: stará série rok, letošní 3 dny', async () => {
  const videos = { current: bbVideos(Date.UTC(2026, 8, 1)) }; // série 2 letos
  const s = setup({ pages: { current: [bb()] }, videos });
  await s.r.resolveEpisode('tt0903747', 1, 1);
  s.tick(10 * DAY);
  await s.r.resolveEpisode('tt0903747', 1, 1);
  assert.equal(s.calls.html, 1, 'série 1 (2008) po 10 dnech z DB');
  await s.r.resolveEpisode('tt0903747', 2, 1);
  assert.equal(s.calls.html, 2, 'série 2 (letos) po 10 dnech znovu');
  s.tick(300 * DAY);
  await s.r.resolveEpisode('tt0903747', 1, 1);
  assert.equal(s.calls.html, 2, 'série 1 po 310 dnech od 1. stažení, ale 300 od posledního → z DB');
  s.tick(70 * DAY);
  await s.r.resolveEpisode('tt0903747', 1, 1);
  assert.equal(s.calls.html, 3, 'série 1 po roce znovu');
});

test('nový díl: chybí v seznamu a podle Cinemety vyšel po stažení → stáhne hned', async () => {
  const pages = { current: [bb()] };
  const videos = { current: bbVideos(Date.UTC(2026, 9, 1)) };
  const s = setup({ pages, videos });
  await s.r.resolveEpisode('tt0903747', 2, 1);
  // díl 2:2 ještě nevyšel → nic se nestahuje
  videos.current.seasons[2].count = 2;
  videos.current.released['2:2'] = NOW + 2 * DAY;
  const before = await s.r.resolveEpisode('tt0903747', 2, 2);
  assert.equal(before.ep, undefined);
  assert.equal(s.calls.html, 1);
  // vyšel (o 2 dny později, seznam je 2 dny starý, platnost 3 dny) → stáhne se hned
  s.tick(2 * DAY + 3600_000);
  pages.current = [page([row(237486, 1, 'Pilot', 'S01E01', '88'), row(237486, 2, 'D', 'S01E02', '88'), row(237486, 3, 'T', 'S02E01', '90'), row(237486, 4, 'N', 'S02E02', '95')])];
  const after = await s.r.resolveEpisode('tt0903747', 2, 2);
  assert.equal(s.calls.html, 2);
  assert.equal(after.ep.rating, 95);
  assert.equal(s.r.stats.newEpisodeRefetch, 1);
});

test('ČSFD nedostupné: uložený seznam se vrátí, bez něj chyba', async () => {
  const pages = { current: [bb()] };
  const s = setup({ pages, videos: { current: bbVideos(Date.UTC(2026, 8, 1)) } });
  await s.r.resolveEpisode('tt0903747', 2, 1);
  s.tick(5 * DAY);
  pages.current = [new Error('network')];
  const r = await s.r.resolveEpisode('tt0903747', 2, 1);
  assert.equal(r.ep.rating, 90);
  assert.equal(s.r.stats.staleServed, 1);

  const s2 = setup({ pages: { current: [new Error('network')] }, videos: { current: null } });
  await assert.rejects(() => s2.r.resolveEpisode('tt0903747', 1, 1));
});

test('ověření proti botům: vyřeší se přes detail a zkusí znovu', async () => {
  const s = setup({ pages: { current: [bb()] }, videos: { current: null } });
  s.challenge();
  const r = await s.r.resolveEpisode('tt0903747', 1, 1);
  assert.equal(r.ep.rating, 88.8);
  assert.equal(s.calls.movie, 1);
  assert.equal(s.calls.html, 2);
});

test('víc stránek: stáhne další, dokud stránka odkazuje dál', async () => {
  const p1 = page([row(1, 1, 'A', 'E01', '80')], { next: 2 });
  const p2 = page([row(1, 2, 'B', 'E02', '70')]);
  const s = setup({ pages: { current: [p1, p2] }, videos: { current: null } });
  const r = await s.r.resolveEpisode('tt0388629', 1, 2);
  assert.equal(r.ep.rating, 70);
  assert.equal(s.calls.html, 2);
  assert.match(s.calls.urls[1], /\/epizody\/\?page=2$/);
});

test('film místo seriálu → nic, bez stahování seznamu', async () => {
  const s = setup({ pages: { current: [bb()] }, videos: { current: null }, seriesType: 'film' });
  const r = await s.r.resolveEpisode('tt0110912', 1, 1);
  assert.equal(r.reason, 'not-series');
  assert.equal(s.calls.html, 0);
});

// --- HTTP: varianty manifestu a dotazy na díly ---
test('splitVariant', () => {
  assert.deepEqual(splitVariant('/manifest.json'), { episodes: true, path: '/manifest.json' });
  assert.deepEqual(splitVariant('/bez-dilu/manifest.json'), { episodes: false, path: '/manifest.json' });
  assert.deepEqual(splitVariant('/bez-dilu/ratings/series/tt1.json'), { episodes: false, path: '/ratings/series/tt1.json' });
  assert.deepEqual(splitVariant('/bez-dilux'), { episodes: true, path: '/bez-dilux' });
});

test('HTTP: díl v hlavní variantě, seriál v /bez-dilu/, manifest s/bez episodes', async () => {
  const db = openDb(':memory:');
  const seen = [];
  const resolver = { resolve: async (id) => ({ csfdId: 237486, row: { rating: 93 } }) };
  const episodes = {
    resolveEpisode: async (id, s, e) => {
      seen.push([id, s, e]);
      if (s === 9) return { seriesCsfdId: 237486, reason: 'not-found' };
      return { seriesCsfdId: 237486, ep: { season: s, episode: e, rating: 88.6, csfdId: 5, path: '/film/237486-bb/5-pilot/', title: 'Pilot' } };
    },
    stats: {}
  };
  const server = createServer({
    db,
    resolver,
    episodes,
    refresher: { running: false },
    csfdClient: { pending: 0 },
    config: { publicUrl: 'https://csfd.example.cz' },
    version: '1.5.0'
  });
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (p) => (await fetch(base + p)).json();
  try {
    assert.equal((await j('/manifest.json')).ratingSources[0].episodes, true);
    assert.equal('episodes' in (await j('/bez-dilu/manifest.json')).ratingSources[0], false);

    assert.deepEqual(await j('/ratings/series/tt0903747%3A1%3A1.json'), {
      ratings: [{ source: 'csfd', value: 89, url: 'https://www.csfd.cz/film/237486-bb/5-pilot/' }]
    });
    assert.deepEqual(await j('/ratings/series/tt0903747:9:1.json'), { ratings: [] }, 'díl nenalezen → prázdno, ne seriál');
    assert.equal((await j('/ratings/series/tt0903747.json')).ratings[0].value, 93, 'seriál dál jako dřív');
    assert.equal((await j('/bez-dilu/ratings/series/tt0903747:1:1.json')).ratings[0].value, 93, 'bez dílů → seriál');
    assert.equal((await j('/bez-dilu/ratings/movie/tt0110912.json')).ratings[0].value, 93);

    const dbg = await fetch(`${base}/rating/tt0903747?season=1&episode=1`);
    assert.equal(dbg.status, 200);
    assert.equal((await dbg.json()).ratingExact, 88.6);
    const miss = await fetch(`${base}/rating/tt0903747?season=9&episode=1`);
    assert.equal(miss.status, 404);
    assert.equal((await miss.json()).reason, 'not-found');

    assert.deepEqual(seen, [['tt0903747', 1, 1], ['tt0903747', 9, 1], ['tt0903747', 1, 1], ['tt0903747', 9, 1]]);

    const qr = await (await fetch(`${base}/qr.svg?dily=0`)).text();
    assert.match(qr, /^<svg/);
  } finally {
    await new Promise((ok) => server.close(ok));
    db.close();
  }
});
