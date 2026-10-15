// Kontrola párů nalezených fallbackem (tabulka own_map).
// Každý pár se znovu spáruje přísnou cestou: oba endpointy Cinemety, přijme se jen jednoznačná shoda.
// Pár, který neodpovídá (jiné ČSFD ID, nejednoznačné, nenalezeno), je podezřelý.
//
//   node --disable-warning=ExperimentalWarning scripts/check-own-map.mjs            # jen výpis (DRY-RUN)
//   APPLY=1 node --disable-warning=ExperimentalWarning scripts/check-own-map.mjs    # podezřelé smaže
//
// Smazaný pár se při příštím dotazu z Nuvia (s typem) najde znovu, správně.
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createCsfdClient } from '../src/csfd.js';
import { getMeta, getMetas } from '../src/cinemeta.js';
import { createResolver } from '../src/resolver.js';

const apply = process.env.APPLY === '1';
const db = openDb(config.dbPath);
const csfdClient = createCsfdClient({ db, concurrency: 1, delayMs: config.csfdDelayMs });
const resolver = createResolver({ db, csfdClient, getMeta, getMetas, config, log: () => {} });

const rows = db.ownAll();
console.log(`${apply ? 'APPLY' : 'DRY-RUN'}: kontroluji ${rows.length} párů z own_map\n`);
const bad = [];
for (const row of rows) {
  let verdict;
  try {
    const r = await resolver.findMatch(row.imdb);
    if (r.match?.id === row.csfd) verdict = 'OK';
    else if (r.match) verdict = `JINÉ ID → ${r.match.id} "${r.match.title}"`;
    else verdict = r.reason;
  } catch (e) {
    console.log(`  ${row.imdb}  ${row.csfd}  "${row.title}"  CHYBA: ${e.message} (ponechávám)`);
    continue;
  }
  const ok = verdict === 'OK';
  if (!ok) bad.push(row);
  console.log(`  ${ok ? 'ok ' : 'XX '} ${row.imdb}  ČSFD ${row.csfd}  "${row.title}" (${row.year})  [${row.matched_by}]  → ${verdict}`);
}

console.log(`\nPodezřelých: ${bad.length} z ${rows.length}`);
if (apply) {
  for (const row of bad) db.ownDel(row.imdb);
  console.log(`Smazáno: ${bad.length}`);
} else if (bad.length) {
  console.log('Nic se nesmazalo. Pro smazání spusť znovu s APPLY=1.');
}
db.close();
