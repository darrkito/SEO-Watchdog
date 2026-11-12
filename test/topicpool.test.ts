import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildDemandPool, clusterQueries, replayReport, type PoolEntry } from '../src/agents/topicdata.ts';

const database = () => { const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE metrics (site_id INTEGER, source TEXT, date TEXT, query TEXT, impressions REAL, position REAL); CREATE TABLE research_cache (key TEXT PRIMARY KEY, text TEXT, created_at TEXT)'); return db; };
const insert = (db: DatabaseSync, query: string, impressions: number, position: number) => db.prepare("INSERT INTO metrics VALUES (1, 'gsc', date('now'), ?, ?, ?)").run(query, impressions, position);
test('pool filters weighted winners, brands, taken and irrelevant or denied queries', async () => {
  const db = database(); insert(db, 'banos moviles', 10, 2); insert(db, 'banos moviles', 10, 4); insert(db, 'marca baños', 20, 8); insert(db, 'oficinas moviles', 15, 6); insert(db, 'oficinas guadalajara', 12, 7); insert(db, 'oficinas fortnite', 20, 8);
  const pool = await buildDemandPool(db, 1, { lang: 'es', country: 'MX', brandTerms: ['mârca'], taken: ['guia-oficinas-moviles'] }, { expand: false, fetch: (() => { throw Error('network'); }) as typeof fetch });
  assert.deepEqual(pool.map((e) => e.query), ['oficinas guadalajara']); db.close();
});
test('autocomplete and Bing merge and cache all responses', async () => {
  const db = database(); insert(db, 'oficinas moviles', 20, 7); let calls = 0;
  const old = process.env.BING_WEBMASTER_API_KEY; process.env.BING_WEBMASTER_API_KEY = 'test';
  const fetcher = async (input: string | URL | Request) => { calls++; const url = new URL(String(input)); if (url.hostname.includes('bing.com')) return new Response(JSON.stringify({ d: url.pathname.endsWith('GetKeyword') ? { Impressions: 0, BroadImpressions: 0 } : [{ Query: 'oficinas móviles precio', Impressions: 12, BroadImpressions: 20 }] })); return new Response(JSON.stringify(['', ['oficinas móviles precio', 'oficinas moviles fortnite', 'irrelevant query']])); };
  try {
    const opts = { lang: 'es', country: 'MX', services: ['oficinas moviles'] }; const deps = { fetch: fetcher as typeof fetch };
    const pool = await buildDemandPool(db, 1, opts, deps); const e = pool.find((x) => x.query === 'oficinas móviles precio')!;
    assert.deepEqual(e.sources, ['autocomplete', 'bing']); assert.deepEqual(e.suggestedBy, ['oficinas moviles']); assert.equal(e.bingImpressions, 12); assert.equal(pool.length, 2); assert.ok(calls > 0);
    calls = 0; assert.deepEqual(await buildDemandPool(db, 1, opts, deps), pool); assert.equal(calls, 0);
  } finally { if (old === undefined) delete process.env.BING_WEBMASTER_API_KEY; else process.env.BING_WEBMASTER_API_KEY = old; db.close(); }
});
test('clusters variants and plurals and reports demand thresholds', () => {
  const entry = (query: string, gscImpressions: number, sources: PoolEntry['sources'] = ['gsc']): PoolEntry => ({ query, gscImpressions, sources, gscPosition: 7, bingImpressions: 0, suggestedBy: [] });
  const pool = [entry('oficinas moviles guadalajara', 13), entry('oficinas moviles en guadalajara', 21, ['gsc', 'bing']), entry('renta de oficinas móviles guadalajara', 11), entry('office rentals', 10), entry('offices rental', 10)];
  const clusters = clusterQueries(pool); assert.equal(clusters.length, 2); assert.equal(clusters[0].gscImpressions, 45); assert.equal(clusters[0].primary, 'oficinas moviles en guadalajara'); assert.equal(clusters[1].gscImpressions, 20);
  const report = replayReport(clusters, pool); assert.match(report, /Pool: 5; gsc 5; autocomplete 0; bing 1/); assert.match(report, />=50 0; >=20 2; >=10 2; 2\+ sources 1/);
});
