import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMatch, normalize } from '../src/matcher.js';

const person = (name) => ({ id: 1, name, url: '' });
const cand = (o) => ({
  id: o.id,
  title: o.title,
  year: o.year,
  type: o.type ?? 'film',
  creators: { directors: (o.directors ?? []).map(person), actors: (o.actors ?? []).map(person) }
});

test('normalize odstraní diakritiku a interpunkci', () => {
  assert.equal(normalize('Pán prstenů: Společenstvo'), 'pan prstenu spolecenstvo');
  assert.equal(normalize('Fast & Furious'), 'fast and furious');
});

test('shoda podle režiséra a roku', () => {
  const meta = { type: 'movie', name: 'Inception', year: 2010, directors: ['Christopher Nolan'], cast: [] };
  const r = pickMatch(meta, {
    movies: [cand({ id: 10, title: 'Počátek', year: 2010, directors: ['Christopher Nolan'] })],
    tvSeries: []
  });
  assert.equal(r.candidate.id, 10);
});

test('rok mimo ±1 se odmítne i při shodě režiséra', () => {
  const meta = { type: 'movie', name: 'Dune', year: 2021, directors: ['Denis Villeneuve'], cast: [] };
  const r = pickMatch(meta, {
    movies: [cand({ id: 1, title: 'Duna', year: 2024, directors: ['Denis Villeneuve'] })],
    tvSeries: []
  });
  assert.equal(r.candidate, null);
});

test('remake se stejným názvem se rozliší rokem a režisérem', () => {
  const meta = { type: 'movie', name: 'Dune', year: 1984, directors: ['David Lynch'], cast: [] };
  const r = pickMatch(meta, {
    movies: [
      cand({ id: 1, title: 'Duna', year: 2021, directors: ['Denis Villeneuve'] }),
      cand({ id: 2, title: 'Duna', year: 1984, directors: ['David Lynch'] })
    ],
    tvSeries: []
  });
  assert.equal(r.candidate.id, 2);
});

test('seriál se páruje přes herce, film-typy se ignorují', () => {
  const meta = { type: 'series', name: 'Breaking Bad', year: 2008, directors: [], cast: ['Bryan Cranston', 'Aaron Paul'] };
  const r = pickMatch(meta, {
    movies: [cand({ id: 5, title: 'Breaking Bad', year: 2008, actors: ['Bryan Cranston'] })],
    tvSeries: [
      cand({ id: 7, title: 'Perníkový táta', year: 2008, type: 'series', actors: ['Bryan Cranston', 'Aaron Paul'] }),
      cand({ id: 8, title: 'Perníkový táta - Pilot', year: 2008, type: 'episode', actors: ['Bryan Cranston'] })
    ]
  });
  assert.equal(r.candidate.id, 7);
});

test('jen shoda názvu stačí pouze s přesným rokem', () => {
  const meta = { type: 'movie', name: 'Kolja', year: 1996, directors: [], cast: [] };
  const ok = pickMatch(meta, { movies: [cand({ id: 3, title: 'Kolja', year: 1996 })], tvSeries: [] });
  assert.equal(ok.candidate.id, 3);
  const off = pickMatch(meta, { movies: [cand({ id: 3, title: 'Kolja', year: 1997 })], tvSeries: [] });
  assert.equal(off.candidate, null);
});

test('neznámý rok na ČSFD vyžaduje shodu tvůrce', () => {
  const meta = { type: 'series', name: 'Dark', year: 2017, directors: [], cast: ['Louis Hofmann'] };
  const noPerson = pickMatch(meta, { movies: [], tvSeries: [cand({ id: 4, title: 'Dark', year: NaN, type: 'series' })] });
  assert.equal(noPerson.candidate, null);
  const withPerson = pickMatch(meta, {
    movies: [],
    tvSeries: [cand({ id: 4, title: 'Dark', year: NaN, type: 'series', actors: ['Louis Hofmann'] })]
  });
  assert.equal(withPerson.candidate.id, 4);
});

test('prohozené pořadí jména se pozná', () => {
  const meta = { type: 'movie', name: 'X', year: 2001, directors: ['Hayao Miyazaki'], cast: [] };
  const r = pickMatch(meta, { movies: [cand({ id: 9, title: 'Y', year: 2001, directors: ['Miyazaki Hayao'] })], tvSeries: [] });
  assert.equal(r.candidate.id, 9);
});

test('dva stejně dobří kandidáti → ambiguous', () => {
  const meta = { type: 'movie', name: 'Twin', year: 2000, directors: ['John Doe'], cast: [] };
  const r = pickMatch(meta, {
    movies: [
      cand({ id: 1, title: 'A', year: 2000, directors: ['John Doe'] }),
      cand({ id: 2, title: 'B', year: 2000, directors: ['John Doe'] })
    ],
    tvSeries: []
  });
  assert.equal(r.candidate, null);
  assert.equal(r.reason, 'ambiguous');
});
