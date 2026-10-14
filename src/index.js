import { config } from './config.js';
import { openDb } from './db.js';
import { createCsfdClient } from './csfd.js';
import { getMeta, getSeriesStatus } from './cinemeta.js';
import { createResolver } from './resolver.js';
import { createRefresher } from './refresh.js';
import { createServer } from './server.js';
import { loadIcon } from './addon.js';
import { readFileSync } from 'node:fs';

const log = (...a) => console.log(new Date().toISOString(), ...a);

const db = openDb(config.dbPath);
const csfdClient = createCsfdClient({
  db,
  concurrency: config.csfdConcurrency,
  delayMs: config.csfdDelayMs
});
const resolver = createResolver({ db, csfdClient, getMeta, getSeriesStatus, config, log });
const refresher = createRefresher({ db, config, log });
const icon = loadIcon(config.iconPath);
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const installPage = readFileSync(new URL('./web/index.html', import.meta.url), 'utf8');
const server = createServer({ db, resolver, refresher, csfdClient, config, icon, installPage, version });

server.listen(config.port, () => {
  log(`[http] csfd-ratings ${version} poslouchá na portu ${config.port}, Wikidata párů: ${db.wdCount()}`);
  log(`[addon] manifest: /manifest.json, ikona: ${icon ? config.iconPath : 'není (Nuvio ukáže hvězdičku)'}`);
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
