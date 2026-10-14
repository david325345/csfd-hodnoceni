import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { buildManifest, parseRatingsPath, publicBaseUrl, ratingsPayload } from '../src/addon.js';

test('parseRatingsPath: film, seriál, epizoda, neplatné', () => {
  assert.deepEqual(parseRatingsPath('/ratings/movie/tt0110912.json'), { type: 'movie', imdbId: 'tt0110912' });
  assert.deepEqual(parseRatingsPath('/ratings/series/tt0903747.json'), { type: 'series', imdbId: 'tt0903747' });
  assert.deepEqual(parseRatingsPath('/ratings/series/tt0903747%3A1%3A2.json'), { type: 'series', imdbId: 'tt0903747' });
  assert.deepEqual(parseRatingsPath('/ratings/series/tt0903747:1:2.json'), { type: 'series', imdbId: 'tt0903747' });
  assert.equal(parseRatingsPath('/ratings/movie/kitsu:123.json'), null);
  assert.equal(parseRatingsPath('/ratings/tv/tt0110912.json'), null);
  assert.equal(parseRatingsPath('/ratings/movie/tt0110912'), null);
  assert.equal(parseRatingsPath('/ratings/movie/%E0%A4%A.json'), null);
});

test('manifest odpovídá formátu Nuvia (ratings resource + ratingSources)', () => {
  const m = buildManifest({ baseUrl: 'https://csfd.example.cz', hasIcon: true, version: '1.1.0' });
  assert.equal(m.resources[0].name, 'ratings');
  assert.deepEqual(m.resources[0].types, ['movie', 'series']);
  assert.deepEqual(m.resources[0].idPrefixes, ['tt']);
  assert.deepEqual(m.ratingSources, [
    { source: 'csfd', name: 'ČSFD', max: 100, icon: 'https://csfd.example.cz/icon.png' }
  ]);
  const noIcon = buildManifest({ baseUrl: 'https://x', hasIcon: false, version: '1' });
  assert.equal('icon' in noIcon.ratingSources[0], false);
  assert.equal('logo' in noIcon, false);
});

test('publicBaseUrl: PUBLIC_URL, jinak hlavičky reverse proxy', () => {
  assert.equal(publicBaseUrl({ headers: {} }, 'https://a.cz/'), 'https://a.cz');
  assert.equal(
    publicBaseUrl({ headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'csfd.example.cz', host: 'internal:7020' } }, ''),
    'https://csfd.example.cz'
  );
  assert.equal(publicBaseUrl({ headers: { host: 'localhost:7020' } }, ''), 'http://localhost:7020');
});

test('ratingsPayload: hodnota, null hodnocení, nenalezeno', () => {
  assert.deepEqual(ratingsPayload({ csfdId: 8852, row: { rating: 91 } }), {
    ratings: [{ source: 'csfd', value: 91, url: 'https://www.csfd.cz/film/8852/' }]
  });
  assert.deepEqual(ratingsPayload({ csfdId: 1, row: { rating: null } }), { ratings: [] });
  assert.deepEqual(ratingsPayload(null), { ratings: [] });
});

// --- HTTP end-to-end nad skutečným serverem s podvrženým resolverem ---
async function withServer(opts, fn) {
  const db = openDb(':memory:');
  const server = createServer({
    db,
    resolver: opts.resolver,
    refresher: { running: false, refresh() {} },
    csfdClient: { pending: 0 },
    config: { publicUrl: '', adminToken: '' },
    icon: opts.icon ?? null,
    version: '1.1.0'
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
}

const resolver = {
  async resolve(id) {
    if (id === 'tt0110912') return { csfdId: 8852, row: { rating: 91 } };
    if (id === 'tt0903747') return { csfdId: 237486, row: { rating: 93 } };
    if (id === 'tt0000500') throw new Error('ČSFD blocked');
    return null;
  }
};

test('HTTP: manifest, hodnocení, epizoda, nenalezeno, chyba, ikona', async () => {
  await withServer({ resolver, icon: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }, async (base) => {
    const man = await (await fetch(`${base}/manifest.json`, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'csfd.example.cz' } })).json();
    assert.equal(man.ratingSources[0].icon, 'https://csfd.example.cz/icon.png');

    const film = await fetch(`${base}/ratings/movie/tt0110912.json`);
    assert.equal(film.status, 200);
    assert.equal(film.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await film.json(), { ratings: [{ source: 'csfd', value: 91, url: 'https://www.csfd.cz/film/8852/' }] });

    const ep = await (await fetch(`${base}/ratings/series/tt0903747%3A2%3A5.json`)).json();
    assert.equal(ep.ratings[0].value, 93);

    for (const p of ['/ratings/movie/tt9999999.json', '/ratings/movie/tt0000500.json', '/ratings/movie/kitsu:1.json']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      assert.deepEqual(await r.json(), { ratings: [] }, p);
    }

    const ico = await fetch(`${base}/icon.png`);
    assert.equal(ico.status, 200);
    assert.equal(ico.headers.get('content-type'), 'image/png');
  });
});

test('HTTP: bez ikony /icon.png neexistuje a manifest ji neuvádí', async () => {
  await withServer({ resolver }, async (base) => {
    assert.equal((await fetch(`${base}/icon.png`)).status, 404);
    const man = await (await fetch(`${base}/manifest.json`)).json();
    assert.equal(man.ratingSources[0].icon, undefined);
  });
});

test('HTTP: instalační stránka a QR kód s adresou manifestu', async () => {
  const db = openDb(':memory:');
  const server = createServer({
    db,
    resolver,
    refresher: { running: false, refresh() {} },
    csfdClient: { pending: 0 },
    config: { publicUrl: 'https://csfd.example.cz', adminToken: '' },
    installPage: '<!doctype html><title>ČSFD</title>',
    version: '1.2.0'
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const qr = await fetch(`${base}/qr.svg`);
    assert.equal(qr.status, 200);
    assert.equal(qr.headers.get('content-type'), 'image/svg+xml');
    assert.match(await qr.text(), /^<svg/);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});
