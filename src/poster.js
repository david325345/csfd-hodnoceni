// Náhradní plakát (PNG 600×900) pro tituly bez plakátu i fotky na ČSFD: název, rok a typ.
// Kreslí se z SVG přes resvg; písmo DejaVu (v Dockeru balík fonts-dejavu-core).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const W = 600;
const H = 900;
const PAD = 48;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Zalomí text na řádky o nejvýš `max` znacích; dlouhá slova rozdělí, přebytek zakončí „…“. */
export function wrapTitle(text, max, maxLines) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (let w of words) {
    while (w.length > max) {
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push(w.slice(0, max - 1) + '-');
      w = w.slice(max - 1);
    }
    if (!line) line = w;
    else if (line.length + 1 + w.length <= max) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = cut[maxLines - 1].replace(/[\s-]*$/, '').slice(0, max - 1) + '…';
    return cut;
  }
  return lines;
}

/** SVG náhledu (samostatně kvůli testům). */
export function posterSvg({ title, year, series }) {
  const len = String(title ?? '').length;
  const [size, max] = len > 70 ? [44, 19] : len > 36 ? [52, 16] : [64, 13];
  const lines = wrapTitle(title || 'Bez názvu', max, 7);
  const lh = Math.round(size * 1.18);
  const blockH = lines.length * lh + (year ? 70 : 0);
  let y = Math.max(220, Math.round((H - blockH) / 2) + size);
  const text = lines
    .map((l, i) => `<text x="${PAD}" y="${y + i * lh}" font-size="${size}" font-weight="bold" fill="#eaf1ef">${esc(l)}</text>`)
    .join('');
  y += lines.length * lh;
  const yearText = year ? `<text x="${PAD}" y="${y + 30}" font-size="40" fill="#94aeab">${esc(year)}</text>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#1b3d46"/><stop offset="1" stop-color="#0b1a1e"/></linearGradient></defs>' +
    `<rect width="${W}" height="${H}" fill="url(#g)"/>` +
    `<text x="${PAD}" y="96" font-size="36" font-weight="bold" fill="#e5383f">ČSFD</text>` +
    `<rect x="${PAD}" y="118" width="64" height="6" fill="#e5383f"/>` +
    text +
    yearText +
    `<text x="${PAD}" y="${H - 56}" font-size="30" fill="#94aeab">${series ? 'Seriál' : 'Film'}</text>` +
    '</svg>'
  );
}

/**
 * Vrací { available, render({ title, year, series }) → Buffer PNG }.
 * Bez písma nebo knihovny je `available` false a náhledy se negenerují.
 */
export function createPosterRenderer({ fontFiles }) {
  const files = (fontFiles ?? []).filter((f) => f && existsSync(f));
  let Resvg = null;
  try {
    ({ Resvg } = require('@resvg/resvg-js'));
  } catch {
    Resvg = null;
  }
  const available = Boolean(Resvg && files.length);
  return {
    available,
    render(info) {
      if (!available) return null;
      const r = new Resvg(posterSvg(info), {
        font: { fontFiles: files, loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' }
      });
      return r.render().asPng();
    }
  };
}
