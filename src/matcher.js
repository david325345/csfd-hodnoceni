// Párování titulu z Cinemety s výsledky hledání na ČSFD.
// Shoda se uzná jen při shodě typu a roku (±1) a zároveň
// shodě tvůrce (režisér/herec) nebo názvu při přesném roce.

const MOVIE_TYPES = new Set(['film', 'tv-film']);
const SERIES_TYPES = new Set(['series', 'tv-show']);

/** Malá písmena, bez diakritiky, jen písmena/číslice oddělené mezerou. */
export const normalize = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Jméno jako seřazená slova — snese prohozené pořadí (např. asijská jména). */
const personKey = (name) => normalize(name).split(' ').filter(Boolean).sort().join(' ');

const overlap = (a, b) => {
  const set = new Set(a.map(personKey).filter(Boolean));
  return b.map(personKey).filter((k) => k && set.has(k)).length;
};

/**
 * @param meta  výstup cinemeta.getMeta
 * @param search výstup csfd.search (movies[], tvSeries[])
 * @returns { candidate, score, reasons } | { candidate: null, reason }
 */
export function pickMatch(meta, search) {
  const pool = meta.type === 'series' ? search?.tvSeries ?? [] : search?.movies ?? [];
  const allowed = meta.type === 'series' ? SERIES_TYPES : MOVIE_TYPES;

  const scored = [];
  for (const c of pool) {
    if (!allowed.has(c.type)) continue;

    const cYear = Number.isFinite(c.year) && c.year > 0 ? c.year : null;
    let yearExact = false;
    if (meta.year && cYear) {
      const diff = Math.abs(meta.year - cYear);
      if (diff > 1) continue;
      yearExact = diff === 0;
    }

    const dirHits = overlap(meta.directors, c.creators?.directors?.map((p) => p.name) ?? []);
    const castHits = overlap(meta.cast, c.creators?.actors?.map((p) => p.name) ?? []);
    const personMatch = dirHits > 0 || castHits > 0;
    const titleMatch = normalize(meta.name) !== '' && normalize(meta.name) === normalize(c.title);

    // Rok neznámý na některé straně → vyžaduj shodu tvůrce.
    const yearKnown = Boolean(meta.year && cYear);
    const accepted = personMatch || (titleMatch && yearExact && yearKnown);
    if (!accepted) continue;

    const score = dirHits * 3 + castHits * 2 + (titleMatch ? 1 : 0) + (yearExact ? 1 : 0);
    const reasons = [];
    if (dirHits) reasons.push(`director:${dirHits}`);
    if (castHits) reasons.push(`cast:${castHits}`);
    if (titleMatch) reasons.push('title');
    reasons.push(yearExact ? 'year' : yearKnown ? 'year±1' : 'year?');
    scored.push({ candidate: c, score, reasons });
  }

  if (!scored.length) return { candidate: null, reason: 'no-match' };
  scored.sort((a, b) => b.score - a.score);
  if (scored.length > 1 && scored[0].score === scored[1].score && scored[0].candidate.id !== scored[1].candidate.id) {
    return { candidate: null, reason: 'ambiguous' };
  }
  return scored[0];
}
