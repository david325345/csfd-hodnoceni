import { config } from './config.js';
import { openDb } from './db.js';
import { createCsfdClient } from './csfd.js';
import { getMeta } from './cinemeta.js';
import { createResolver } from './resolver.js';
import { createRefresher } from './refresh.js';
import { createServer } from './server.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);

const db = openDb(config.dbPath);
const csfdClient = createCsfdClient({
  db,
  concurrency: config.csfdConcurrency,
  delayMs: config.csfdDelayMs
});
const resolver = createResolver({ db, csfdClient, getMeta, config, log });
const refresher = createRefresher({ db, config, log });
const server = createServer({ db, resolver, refresher, csfdClient, config });

server.listen(config.port, () => {
  log(`[http] csfd-ratings poslouchá na portu ${config.port}, Wikidata párů: ${db.wdCount()}`);
});

// Obnova mapování při startu (pokud je potřeba) a pak kontrola každou hodinu.
refresher.refreshIfDue();
const timer = setInterval(() => refresher.refreshIfDue(), 3600_000);

const shutdown = (sig) => {
  log(`[app] ${sig}, ukončuji`);
  clearInterval(timer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
