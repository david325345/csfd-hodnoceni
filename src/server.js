import http from 'node:http';

const IMDB_RE = /^\/rating\/(tt\d{5,10})\/?$/;

const send = (res, status, body, extraHeaders = {}) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders
  });
  res.end(JSON.stringify(body));
};

export function createServer({ db, resolver, refresher, csfdClient, config, startedAt = Date.now() }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization'
        });
        return res.end();
      }

      const m = req.method === 'GET' && path.match(IMDB_RE);
      if (m) {
        const imdbId = m[1];
        const r = await resolver.resolve(imdbId);
        if (!r) return send(res, 404, { imdbId, found: false }, { 'Cache-Control': 'public, max-age=3600' });
        const row = r.row;
        return send(
          res,
          200,
          {
            imdbId,
            found: true,
            csfdId: r.csfdId,
            rating: row.rating,
            ratingCount: row.rating_count,
            colorRating: row.color,
            title: row.title,
            year: row.year,
            type: row.type,
            url: `https://www.csfd.cz/film/${r.csfdId}/`,
            source: r.source,
            stale: r.stale,
            fetchedAt: new Date(row.fetched_at).toISOString()
          },
          { 'Cache-Control': 'public, max-age=3600' }
        );
      }

      if (req.method === 'GET' && path === '/health') {
        return send(res, 200, { ok: true, wikidataPairs: db.wdCount() });
      }

      if (req.method === 'GET' && path === '/stats') {
        const ts = (k) => {
          const v = Number(db.kvGet(k) || 0);
          return v ? new Date(v).toISOString() : null;
        };
        return send(res, 200, {
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          wikidata: {
            pairs: db.wdCount(),
            imdbWithMultipleCsfd: db.wdAmbiguousCount(),
            lastFull: ts('wd_last_full'),
            lastSync: ts('wd_last_sync'),
            lastMode: db.kvGet('wd_last_mode'),
            lastDeltaItems: db.kvGet('wd_last_delta_items') == null ? null : Number(db.kvGet('wd_last_delta_items')),
            lastAttempt: ts('wd_last_attempt'),
            lastError: db.kvGet('wd_last_error') || null,
            refreshRunning: refresher.running
          },
          tables: {
            ownMappings: db.ownCount(),
            missCached: db.missCount(),
            ratingsCached: db.ratingCount()
          },
          csfdQueue: csfdClient.pending,
          resolver: resolver.stats
        });
      }

      if (req.method === 'POST' && path === '/admin/refresh-wikidata') {
        if (!config.adminToken || req.headers.authorization !== `Bearer ${config.adminToken}`) {
          return send(res, 403, { error: 'forbidden' });
        }
        const mode = url.searchParams.get('mode') === 'incremental' ? 'incremental' : 'full';
        const force = url.searchParams.get('force') === '1';
        if (refresher.running) return send(res, 409, { error: 'refresh already running' });
        refresher.refresh({ mode, force }); // běží na pozadí
        return send(res, 202, { started: true, mode, force });
      }

      return send(res, 404, { error: 'not found' });
    } catch (e) {
      console.error(`[http] ${req.method} ${path}: ${e.stack || e.message}`);
      return send(res, 503, { error: 'upstream unavailable', detail: e.message });
    }
  });
}
