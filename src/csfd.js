// Obal kolem node-csfd-api: fronta požadavků a perzistence Anubis cookie.
import { csfd, CsfdError, getAnubisCookie, setAnubisCookie } from 'node-csfd-api';
import { createLimiter } from './limiter.js';

const COOKIE_KEY = 'anubis_cookie';

export function createCsfdClient({ db, concurrency, delayMs, lib = { csfd, getAnubisCookie, setAnubisCookie } }) {
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
    get pending() {
      return limiter.pending;
    }
  };
}

export const isNotFound = (e) =>
  (e instanceof CsfdError || e?.name === 'CsfdError') && e.reason === 'not-found';
