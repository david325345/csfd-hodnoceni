// Ověří, že skutečná node-csfd-api vrací z uložených stránek ČSFD data ve tvaru,
// se kterým počítá párování. Síť se nepoužívá — fetch se podvrhne PŘED načtením knihovny.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const pages = { search: fixture('search-matrix.html'), movie: fixture('movie-lotr.html') };

globalThis.fetch = async (url) => {
  const u = String(url);
  const body = u.includes('/hledat') ? pages.search : pages.movie;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
};

const { csfd } = await import('node-csfd-api');
const { pickMatch } = await import('../src/matcher.js');

test('search vrací rok, typ a tvůrce', async () => {
  const s = await csfd.search('matrix');
  assert.ok(s.movies.length > 0);
  const m = s.movies[0];
  assert.equal(typeof m.id, 'number');
  assert.equal(typeof m.year, 'number');
  assert.equal(m.type, 'film');
  assert.ok(m.creators.directors.length > 0, 'režiséři ve výsledku hledání');
  assert.ok(s.tvSeries.length > 0);
});

test('Matrix (Cinemeta) se spáruje s výsledkem hledání přes režiséry', async () => {
  const s = await csfd.search('matrix');
  const meta = {
    type: 'movie',
    name: 'The Matrix',
    year: 1999,
    directors: ['Lana Wachowski', 'Lilly Wachowski'],
    cast: ['Keanu Reeves', 'Laurence Fishburne', 'Carrie-Anne Moss']
  };
  const r = pickMatch(meta, s);
  assert.ok(r.candidate, `očekávána shoda, dostal ${r.reason}`);
  assert.equal(r.candidate.year, 1999);
  assert.ok(r.reasons.some((x) => x.startsWith('director')));
});

test('movie vrací hodnocení', async () => {
  const m = await csfd.movie(4711);
  assert.ok(Number.isFinite(m.rating), 'rating je číslo');
  assert.ok(m.ratingCount > 0);
  assert.equal(m.type, 'film');
});
