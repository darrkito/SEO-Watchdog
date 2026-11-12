import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildDemandPool, clusterQueries, replayReport, type PoolEntry, minTopicScore, scoreTopic as scoreV2 } from '../src/agents/topicdata.ts';

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

test('expanded queries require two non-geo words in one reference', async () => {
  const db = database(); insert(db, 'oficinas moviles guadalajara', 10, 8);
  const fetcher = async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes('bing.com') ? { d: new URL(String(input)).pathname.endsWith('GetKeyword') ? { Impressions: 0, BroadImpressions: 0 } : ['hoteles en guadalajara', 'clima en guadalajara jalisco', 'oficinas moviles precio'].map((Query) => ({ Query, Impressions: 12, BroadImpressions: 12 })) } : ['', []]));
  const old = process.env.BING_WEBMASTER_API_KEY; process.env.BING_WEBMASTER_API_KEY = 'test';
  try { const pool = await buildDemandPool(db, 1, { lang: 'es', country: 'MX', services: ['Renta de oficinas móviles'], geoWords: ['Guadalajara', 'Jalisco', 'México'] }, { fetch: fetcher as typeof fetch }); assert.ok(pool.some((e) => e.query === 'oficinas moviles precio')); assert.ok(!pool.some((e) => /hoteles|clima/.test(e.query))); }
  finally { if (old === undefined) delete process.env.BING_WEBMASTER_API_KEY; else process.env.BING_WEBMASTER_API_KEY = old; db.close(); }
});
test('picks use pool queries and rescore uses cluster demand', async () => {
  const { acceptPicks, rescoreVerdict, clusterId } = await import('../src/agents/topicdata.ts');
  const entry: PoolEntry = { query: 'oficinas móviles', sources: ['gsc'], gscImpressions: 10, gscPosition: 14, bingImpressions: 0, suggestedBy: [] };
  const clusters = clusterQueries([entry]), pick = { clusterId: clusters[0].id, title: 'Title', slug: 'title', action: 'new', why: 'reason', fit: true, query: 'invented' };
  const accepted = acceptPicks([{ ...pick, clusterId: 'invented' }, pick, { ...pick, slug: 'another' }], clusters, []);
  assert.equal(accepted.length, 1); assert.equal(accepted[0].query, entry.query); assert.equal(clusterId('móviles oficinas'), clusters[0].id);
  assert.equal(rescoreVerdict(clusters[0]), 'keep'); assert.equal(rescoreVerdict({ ...clusters[0], gscImpressions: 9 }), 'reject'); assert.equal(rescoreVerdict(undefined), 'reject');
});

test('PAA uses market locale, caches seeds and limits uncached calls', async () => {
  const db = database(); insert(db, 'oficinas moviles', 20, 8); insert(db, 'banos portatiles', 10, 8); let bodies: any[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('serper.dev')) { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ peopleAlsoAsk: [{ question: `${bodies.at(-1).q} precio` }], relatedSearches: [{ query: `${bodies.at(-1).q} costos` }, { query: 'clima guadalajara' }] })); }
    return new Response(JSON.stringify(['', []]));
  };
  const opts = { lang: 'es', country: 'MX' }, deps = { fetch: fetcher as typeof fetch, apiKey: 'key', paaMax: 1 };
  const first = await buildDemandPool(db, 1, opts, deps); assert.deepEqual(bodies, [{ q: 'oficinas moviles', hl: 'es-419' }]);
  assert.ok(first.some((e) => e.sources.includes('paa') && e.suggestedBy.includes('oficinas moviles'))); assert.ok(!first.some((e) => e.query === 'clima guadalajara'));
  bodies = []; await buildDemandPool(db, 1, opts, { ...deps, paaMax: 0 }); assert.equal(bodies.length, 0);
  await buildDemandPool(db, 1, opts, deps); assert.deepEqual(bodies, [{ q: 'banos portatiles', hl: 'es-419' }]);
  bodies = []; await buildDemandPool(db, 1, { lang: 'en', country: 'US' }, deps); assert.deepEqual(bodies, [{ q: 'oficinas moviles', gl: 'us', hl: 'en' }]); db.close();
});

test('head terms and trend selection use significant cluster words', async () => {
  const { headTerms, trendForCluster } = await import('../src/agents/topicdata.ts');
  const entry = (query: string, n: number): PoolEntry => ({ query, sources: ['gsc'], gscImpressions: n, gscPosition: 8, bingImpressions: 0, suggestedBy: [] });
  const clusters = clusterQueries([entry('oficinas moviles guadalajara precio', 30), entry('oficinas moviles', 20), entry('baños portatiles', 10)]);
  assert.deepEqual(headTerms(clusters, ['móviles oficinas', 'industrial maintenance', 'one']), ['oficinas moviles', 'baños portatiles', 'industrial maintenance']);
  const trend = (mean: number, noData = false) => ({ mean, last8Mean: mean, slope: 'flat' as const, rising: [], top: [], noData });
  const trends = new Map([['oficinas moviles', trend(20)], ['moviles guadalajara', trend(50)], ['precio oficinas', trend(90, true)], ['other term', trend(100)]]);
  assert.equal(trendForCluster(clusters[0], trends)?.mean, 50); assert.equal(trendForCluster(clusters[2], trends), null);
});

test('threshold defaults to 8 and a local business query with own GSC demand earns the local point', () => {
  assert.equal(minTopicScore(undefined), 8); assert.equal(minTopicScore('5'), 8); assert.equal(minTopicScore('9'), 9); assert.equal(minTopicScore('x'), 8);
  const e: any = { verified: true, serpVerified: true, query: 'banos moviles', serpTop10: [], paa: [], related: [], suggestions: [], bigBrandCount: 0, smallSiteCount: 0, ownRank: null, ownImpressions60d: 0, location: 'Guadalajara', bing: null, trends: null, gscVariantImpressions60d: 0, trendsRisingMatch: false, cluster: { id: 'bano-movil', gscImpressions: 9, bingImpressions: 0, sources: ['gsc'], bestPosition: 6, members: ['banos moviles'] } };
  const opts = { isLocalBusiness: true, serviceWords: [] };
  const without = scoreV2(e, opts); e.cluster.gscImpressions = 10;
  assert.equal(scoreV2(e, opts), without + 2); // 9 -> 10 impressions: demand 2 -> 3 and the local point
});

test('a much longer taken slug does not hide a short head query', async () => {
  const { openDb } = await import('../src/db.ts'); const db = openDb(':memory:');
  db.prepare("INSERT INTO metrics (site_id, source, date, query, impressions, position) VALUES (1, 'gsc', date('now'), 'oficinas moviles en renta guadalajara', 50, 40)").run();
  const opts = { lang: 'es', country: 'MX' };
  assert.equal((await buildDemandPool(db, 1, { ...opts, taken: ['oficina-prefabricada-o-movil-para-nave-industrial-en-guadalajara'] }, { expand: false })).length, 1);
  assert.equal((await buildDemandPool(db, 1, { ...opts, taken: ['renta-de-oficinas-moviles-guadalajara'] }, { expand: false })).length, 0);
});
