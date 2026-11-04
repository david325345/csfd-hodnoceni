import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createResolver } from '../src/resolver.js';
import { createEpisodeResolver } from '../src/episodes.js';
import { createCsfdOnly, isCzSk, posterUrl, pickCinemetaHit } from '../src/csfdonly.js';
import { parseCatalogPath, parseMetaPath, parseRatingsPath } from '../src/addon.js';

const DAY = 86400_000;
const NOW = Date.UTC(2026, 10, 4);
const quiet = () => {};
const config = {
  ttlFilmOldDays: 365,
  ttlFilmLastYearDays: 90,
  ttlFilmNewDays: 3,
  ttlSeriesEndedDays: 365,
  ttlSeriesOngoingDays: 3,
  seriesStatusCheckDays: 30,
  missTtlDays: 7,
  ttlEpisodeOldDays: 365,
  ttlEpisodeLastYearDays: 90,
  ttlEpisodeNewDays: 3,
  episodeMaxPages: 6,
  csfdOnlyRecheckDays: 30,
  csfdOnlySearchLimit: 20
};

test('pomocné funkce: země, plakát, shoda v Cinemetě', () => {
  assert.equal(isCzSk(['Československo']), true);
  assert.equal(isCzSk(['Česko', 'Slovensko']), true);
  assert.equal(isCzSk(['USA']), false);
  assert.equal(
    posterUrl('https://image.pmgstatic.com/cache/resized/w60h85/files/images/film/posters/000/008/8959_164d69.jpg'),
    'https://image.pmgstatic.com/cache/resized/w420/files/images/film/posters/000/008/8959_164d69.jpg'
  );
  assert.equal(posterUrl('data:image/gif;base64,R0lG'), null);
  const r = [
    { imdb: 'tt1', name: 'Pelíšky', year: 1999 },
    { imdb: 'tt2', name: 'Pelisky', year: 1970 }
  ];
  assert.equal(pickCinemetaHit(r, ['Pelíšky'], 1999), 'tt1');
  assert.equal(pickCinemetaHit(r, ['Pelíšky'], 1985), null);
  assert.equal(pickCinemetaHit([...r, { imdb: 'tt3', name: 'PELIŠKY', year: 2000 }], ['Pelíšky'], 1999), 'ambiguous');
});

test('cesty: katalog, metadata, hodnocení csfd:', () => {
  assert.deepEqual(parseCatalogPath('/catalog/movie/csfd-only/search=Arabela%20se%20vrac%C3%AD.json'), {
    type: 'movie',
    query: 'Arabela se vrací'
  });
  assert.deepEqual(parseCatalogPath('/catalog/series/csfd-only/search=a+b&skip=0.json'), { type: 'series', query: 'a b' });
  assert.equal(parseCatalogPath('/catalog/movie/jiny/search=x.json'), null);
  assert.deepEqual(parseMetaPath('/meta/series/csfd%3A12345.json'), { type: 'series', csfdId: 12345 });
  assert.equal(parseMetaPath('/meta/movie/tt0110912.json'), null);
  assert.deepEqual(parseRatingsPath('/ratings/movie/csfd:42.json'), { type: 'movie', csfdId: 42 });
  assert.deepEqual(parseRatingsPath('/ratings/series/csfd%3A42%3A2%3A3.json'), { type: 'series', csfdId: 42, season: 2, episode: 3 });
});

// --- hledání s podvrženým ČSFD a Cinemetou ---
const item = (id, title, year, origins, type = 'film') => ({
  id,
  title,
  year,
  type,
  origins,
  poster: `https://image.pmgstatic.com/cache/resized/w60h85/files/p/${id}.jpg`,
  creators: { directors: [], actors: [] }
});

function setup({ results, cinemeta = {}, details = {} }) {
  const db = openDb(':memory:');
  let clock = NOW;
  const calls = { search: 0, cinemeta: [], movie: 0, html: 0 };
  const csfdClient = {
    search: async () => {
      calls.search++;
      return results;
    },
    movie: async (id) => {
      calls.movie++;
      if (!details[id]) throw Object.assign(new Error('404'), { name: 'CsfdError', reason: 'not-found' });
      return details[id];
    },
    fetchHtml: async () => {
      calls.html++;
      return {
        status: 200,
        html:
          '<title>Seriál | Epizody | ČSFD.cz</title><table>' +
          '<tr><td><a href="/film/500-s/501-a/prehled/" class="film-title-name">Díl 1</a><span class="info">(S01E01)</span></td><td class="td-rating"> 81,4% </td></tr>' +
          '<tr><td><a href="/film/500-s/502-b/prehled/" class="film-title-name">Díl 2</a><span class="info">(S01E02)</span></td><td class="td-rating"> 75% </td></tr></table>'
      };
    }
  };
  const searchCinemeta = async (type, q) => {
    calls.cinemeta.push(q);
    const v = cinemeta[q];
    if (v instanceof Error) throw v;
    return v ?? [];
  };
  const now = () => clock;
  const resolver = createResolver({ db, csfdClient, getMeta: async () => null, config, now, log: quiet });
  const episodes = createEpisodeResolver({ db, csfdClient, resolver, config, now, log: quiet });
  const only = createCsfdOnly({ db, csfdClient, episodes, searchCinemeta, config, now, log: quiet });
  return { db, only, resolver, episodes, calls, tick: (ms) => (clock += ms) };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

test('hledání: vyřadí tituly s IMDb (Wikidata, Cinemeta), ukáže české bez IMDb', async () => {
  const s = setup({
    results: {
      movies: [
        item(10, 'Pelíšky', 1999, ['Česko']), // Wikidata
        item(11, 'Kulový blesk', 1978, ['Československo']), // Cinemeta podle názvu
        item(12, 'Malý film', 1985, ['Československo']), // jen ČSFD
        item(13, 'Epizoda', 1990, ['Česko'], 'episode') // díl → pryč
      ],
      tvSeries: []
    },
    cinemeta: { 'Kulový blesk': [{ imdb: 'tt0077822', name: 'Kulový blesk', year: 1979 }] }
  });
  s.db.replaceWdMap([['tt0167116', 10]]);
  const metas = await s.only.search('movie', 'film');
  assert.deepEqual(metas.map((m) => m.id), ['csfd:12']);
  assert.equal(metas[0].poster, 'https://image.pmgstatic.com/cache/resized/w420/files/p/12.jpg');
  assert.equal(metas[0].releaseInfo, '1985');
  // nalezený pár se uloží i pro hodnocení
  assert.equal(s.db.ownGet('tt0077822').csfd, 11);
  // podruhé už bez Cinemety
  const before = s.calls.cinemeta.length;
  await s.only.search('movie', 'film');
  assert.equal(s.calls.cinemeta.length, before);
  // po 31 dnech se titul bez IMDb ověří znovu
  s.tick(31 * DAY);
  await s.only.search('movie', 'film');
  assert.deepEqual(s.calls.cinemeta.slice(before), ['Malý film']);
});

test('hledání: cizí titul se ověří přes originální název na pozadí', async () => {
  const s = setup({
    results: { movies: [item(20, 'Smrtonosná past', 1988, ['USA']), item(21, 'Neznámý film', 2001, ['Francie'])], tvSeries: [] },
    cinemeta: { 'Die Hard': [{ imdb: 'tt0095016', name: 'Die Hard', year: 1988 }] },
    details: {
      20: { title: 'Smrtonosná past', year: 1988, type: 'film', titlesOther: [{ country: 'USA', title: 'Die Hard' }], rating: 90 },
      21: { title: 'Neznámý film', year: 2001, type: 'film', titlesOther: [{ country: 'Francie', title: 'Un film' }], rating: 60 }
    }
  });
  assert.deepEqual(await s.only.search('movie', 'x'), [], 'napoprvé se cizí tituly neukážou');
  await flush();
  assert.deepEqual((await s.only.search('movie', 'x')).map((m) => m.id), ['csfd:21']);
  assert.equal(s.db.ownGet('tt0095016').csfd, 20);
});

test('Cinemeta nedostupná: česká produkce se ukáže, ale neuloží', async () => {
  const s = setup({
    results: { movies: [item(30, 'Film', 1980, ['Československo'])], tvSeries: [] },
    cinemeta: { Film: new Error('timeout') }
  });
  assert.deepEqual((await s.only.search('movie', 'f')).map((m) => m.id), ['csfd:30']);
  assert.equal(s.db.classGet(30), undefined);
});

test('metadata seriálu s díly a hodnocení z jednoho stažení detailu', async () => {
  const s = setup({
    results: { movies: [], tvSeries: [] },
    details: {
      500: {
        title: 'Starý seriál',
        year: 1975,
        type: 'series',
        poster: 'https://image.pmgstatic.com/cache/resized/w1080/files/p.jpg',
        photo: '//image.pmgstatic.com/cache/resized/w1326/files/f.jpg',
        descriptions: ['Popis'],
        genres: ['Komedie'],
        origins: ['Československo'],
        duration: 55,
        creators: { directors: [{ name: 'Režisér' }], actors: [{ name: 'Herec' }] },
        titlesOther: [],
        rating: 77,
        ratingCount: 1200
      }
    }
  });
  const m = await s.only.meta('series', 500);
  assert.equal(m.id, 'csfd:500');
  assert.equal(m.type, 'series');
  assert.equal(m.background, 'https://image.pmgstatic.com/cache/resized/w1326/files/f.jpg');
  assert.deepEqual(m.director, ['Režisér']);
  assert.equal(m.runtime, '55 min');
  assert.deepEqual(m.videos.map((v) => [v.id, v.title]), [['csfd:500:1:1', 'Díl 1'], ['csfd:500:1:2', 'Díl 2']]);
  assert.equal(m.videos[0].released, '1975-01-01T00:00:00.000Z');

  const r = await s.resolver.ratingByCsfd(500);
  assert.equal(r.row.rating, 77);
  assert.equal(s.calls.movie, 1, 'hodnocení z uloženého detailu');
  const ep = await s.only.episodeRating(500, 1, 1);
  assert.equal(ep.ep.rating, 81.4);
  assert.equal(s.calls.html, 1, 'díly z uloženého seznamu');
  await s.only.meta('series', 500);
  assert.equal(s.calls.movie, 1, 'metadata z DB');
});

test('HTTP: katalog, metadata a hodnocení csfd:', async () => {
  const db = openDb(':memory:');
  const csfdOnly = {
    search: async (type, q) => [{ id: 'csfd:12', type, name: q }],
    meta: async (type, id) => ({ id: `csfd:${id}`, type, name: 'X' }),
    episodeRating: async (id, s, e) => ({ seriesCsfdId: id, ep: { season: s, episode: e, rating: 70.4, path: '/film/1-a/2-b/' } }),
    stats: {}
  };
  const resolver = { resolve: async () => null, ratingByCsfd: async (id) => ({ csfdId: id, row: { rating: 66 } }) };
  const server = createServer({
    db,
    resolver,
    episodes: { resolveEpisode: async () => ({}), stats: {} },
    csfdOnly,
    refresher: { running: false },
    csfdClient: { pending: 0 },
    config: { publicUrl: '' }
  });
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (p) => (await fetch(base + p)).json();
  try {
    assert.deepEqual(await j('/catalog/series/csfd-only/search=Arabela.json'), {
      metas: [{ id: 'csfd:12', type: 'series', name: 'Arabela' }]
    });
    assert.deepEqual(await j('/catalog/movie/csfd-only.json'), { metas: [] });
    assert.equal((await j('/meta/movie/csfd:9.json')).meta.id, 'csfd:9');
    assert.equal((await fetch(`${base}/meta/movie/tt0110912.json`)).status, 404);
    assert.equal((await j('/ratings/movie/csfd:9.json')).ratings[0].value, 66);
    assert.deepEqual((await j('/ratings/series/csfd:9:1:2.json')).ratings[0], {
      source: 'csfd',
      value: 70,
      url: 'https://www.csfd.cz/film/1-a/2-b/'
    });
    assert.deepEqual(await j('/bez-dilu/ratings/series/csfd:9:1:2.json'), { ratings: [] }, 'bez dílů: díl nic');
    assert.equal((await j('/bez-dilu/catalog/movie/csfd-only/search=a.json')).metas.length, 1);
  } finally {
    await new Promise((ok) => server.close(ok));
    db.close();
  }
});

// --- plakáty: fotka místo plakátu, vygenerovaný náhled ---
import { wrapTitle, posterSvg, createPosterRenderer } from '../src/poster.js';

test('náhled: zalomení názvu, escapování, PNG', () => {
  assert.deepEqual(wrapTitle('Historie jedné inscenace', 13, 7), ['Historie', 'jedné', 'inscenace']);
  const long = wrapTitle('a b c d e f g h i j k l m n o p', 3, 2);
  assert.equal(long.length, 2);
  assert.match(long[1], /…$/);
  const svg = posterSvg({ title: 'Tom & Jerry <test>', year: 1987, series: true });
  assert.match(svg, />Tom &amp; Jerry</);
  assert.match(svg, />&lt;test&gt;</);
  assert.match(svg, />Seriál</);
  assert.match(svg, />1987</);
  const r = createPosterRenderer({ fontFiles: ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'] });
  if (r.available) {
    const png = r.render({ title: 'Strašidla', year: 1987, series: false });
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
  }
  assert.equal(createPosterRenderer({ fontFiles: ['/neexistuje.ttf'] }).available, false);
});

test('hledání a detail: bez plakátu fotka, bez fotky vygenerovaný náhled', async () => {
  const db = openDb(':memory:');
  const details = {
    41: { title: 'S fotkou', year: 1987, type: 'film', poster: null, photo: '//image.pmgstatic.com/cache/resized/w1326/f41.jpg', titlesOther: [] },
    42: { title: 'Bez ničeho', year: 1986, type: 'film', poster: null, photo: null, titlesOther: [] },
    43: { title: 'S plakátem', year: 1980, type: 'film', poster: 'https://image.pmgstatic.com/cache/resized/w1080/p43.jpg', photo: null, titlesOther: [] }
  };
  const csfdClient = {
    search: async () => ({
      movies: [
        { ...item(41, 'S fotkou', 1987, ['Česko']), poster: 'data:image/gif;base64,R0lG' },
        { ...item(42, 'Bez ničeho', 1986, ['Slovensko']), poster: 'data:image/gif;base64,R0lG' },
        item(44, 'S miniaturou', 1990, ['Česko'])
      ],
      tvSeries: []
    }),
    movie: async (id) => details[id]
  };
  let rendered = 0;
  const posterRenderer = { available: true, render: () => (rendered++, Buffer.from('PNG')) };
  const only = createCsfdOnly({
    db,
    csfdClient,
    episodes: {},
    searchCinemeta: async () => [],
    posterRenderer,
    config,
    now: () => NOW,
    log: quiet
  });
  const metas = await only.search('movie', 'x', { baseUrl: 'https://csfd.example.cz' });
  assert.deepEqual(metas.map((m) => m.poster), [
    'https://image.pmgstatic.com/cache/resized/w1326/f41.jpg',
    'https://csfd.example.cz/poster/csfd-42.png',
    'https://image.pmgstatic.com/cache/resized/w420/files/p/44.jpg'
  ]);
  assert.equal(only.stats.posterDetails, 2, 'detail jen u výsledků bez plakátu');

  const m41 = await only.meta('movie', 41, { baseUrl: 'https://csfd.example.cz' });
  assert.equal(m41.poster, 'https://image.pmgstatic.com/cache/resized/w1326/f41.jpg');
  assert.equal(m41.background, 'https://image.pmgstatic.com/cache/resized/w1326/f41.jpg');
  const m43 = await only.meta('movie', 43, { baseUrl: 'https://csfd.example.cz' });
  assert.equal(m43.background, 'https://image.pmgstatic.com/cache/resized/w1080/p43.jpg', 'bez fotky plakát jako pozadí');
  const m42 = await only.meta('movie', 42, { baseUrl: 'https://csfd.example.cz' });
  assert.equal(m42.poster, 'https://csfd.example.cz/poster/csfd-42.png');
  assert.equal(m42.background, undefined);

  assert.equal((await only.posterPng(42)).toString(), 'PNG');
  await only.posterPng(42);
  assert.equal(rendered, 1, 'náhled z paměti');

  const off = createCsfdOnly({ db, csfdClient, episodes: {}, searchCinemeta: async () => [], config, now: () => NOW, log: quiet });
  assert.equal((await off.meta('movie', 42, { baseUrl: 'https://x' })).poster, undefined, 'bez písma žádný náhled');
});

test('HTTP: /poster/csfd-ID.png', async () => {
  const db = openDb(':memory:');
  const csfdOnly = { posterPng: async (id) => (id === 42 ? Buffer.from([0x89, 0x50, 0x4e, 0x47]) : null), stats: {} };
  const server = createServer({ db, resolver: {}, csfdOnly, refresher: { running: false }, csfdClient: { pending: 0 }, config: { publicUrl: '' } });
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/poster/csfd-42.png`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/poster/csfd-1.png`)).status, 404);
  } finally {
    await new Promise((ok) => server.close(ok));
    db.close();
  }
});
