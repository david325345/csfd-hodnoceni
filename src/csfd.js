// Obal kolem node-csfd-api: fronta požadavků a perzistence Anubis cookie.
import { csfd, CsfdError, getAnubisCookie, setAnubisCookie } from 'node-csfd-api';
import { createLimiter } from './limiter.js';

const COOKIE_KEY = 'anubis_cookie';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function createCsfdClient({
  db,
  concurrency,
  delayMs,
  lib = { csfd, getAnubisCookie, setAnubisCookie },
  fetchImpl = fetch
}) {
  const limiter = createLimiter({ concurrency, delayMs });

  // Cookie platí ~týden a je vázané na IP — po restartu ho načteme z DB.
  const saved = db.kvGet(COOKIE_KEY);
  if (saved) lib.setAnubisCookie(saved);

  const persistCookie = () => {
    const current = lib.getAnubisCookie();
    if (current && current !== db.kvGet(COOKIE_KEY)) db.kvPut(COOKIE_KEY, current);
  };

  const call = (fn) =>
    limiter.run(async () => {
      try {
        return await fn();
      } finally {
        persistCookie();
      }
    });

  return {
    search: (text) => call(() => lib.csfd.search(text)),
    movie: (id) => call(() => lib.csfd.movie(id)),
    /**
     * Stránka ČSFD, kterou knihovna neumí (seznam dílů). Jde přes stejnou frontu
     * a posílá cookie ověření z knihovny. Vrací { status, html }.
     */
    fetchHtml: (url) =>
      call(async () => {
        const res = await fetchImpl(url, {
          headers: { Cookie: lib.getAnubisCookie() || '', 'User-Agent': UA, 'Accept-Language': 'cs-CZ,cs;q=0.9' },
          signal: AbortSignal.timeout(15_000)
        });
        return { status: res.status, html: await res.text() };
      }),
    get pending() {
      return limiter.pending;
    }
  };
}

export const isNotFound = (e) =>
  (e instanceof CsfdError || e?.name === 'CsfdError') && e.reason === 'not-found';
