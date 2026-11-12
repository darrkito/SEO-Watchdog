import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { verifyQuery, scoreTopic, keepTopic, makeBudget, bingKeyword, trendsFor, parseTrend, setDemandEvidence } from '../src/agents/topicdata.ts';

const organic = ['small.test', 'reddit.com', 'other.test', 'third.test', 'fourth.test'].map((host) => ({ link: `https://${host}/page`, title: host }));
const fake = async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes('serper.dev') ? { organic, peopleAlsoAsk: [{ question: 'how to paint' }], relatedSearches: [{ query: 'paint tips' }] } : ['how to paint', ['how to paint']]), { status: 200 });
const opts = { lang: 'en', country: 'US', ownHost: 'third.test', ownImpressions60d: 20 };
test('parses evidence, caches responses, and recalculates site data', async () => {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE research_cache (key TEXT PRIMARY KEY, text TEXT, created_at TEXT)');
  const budget = makeBudget('1');
  const e = await verifyQuery('how to paint', opts, { db, budget, fetch: fake as typeof fetch, apiKey: 'test' });
  assert.equal(e.verified, false); assert.equal(e.serpVerified, true); assert.equal(e.ownRank, 4); assert.equal(e.bigBrandCount, 1); assert.equal(e.smallSiteCount, 4); assert.deepEqual(e.paa, ['how to paint']); assert.deepEqual(e.related, ['paint tips']); assert.deepEqual(e.suggestions, ['how to paint']);
  const cached = await verifyQuery('how to paint', { ...opts, ownHost: 'small.test', ownImpressions60d: 5 }, { db, budget, fetch: fake as typeof fetch });
  assert.equal(cached.ownRank, 1); assert.equal(cached.ownImpressions60d, 5); assert.equal(budget.calls, 1);
  const capped = await verifyQuery('another query', opts, { db, budget, fetch: fake as typeof fetch, apiKey: 'test' });
  assert.equal(capped.verified, false); assert.equal(budget.calls, 1);
  const missing = await verifyQuery('missing key', opts, { budget: makeBudget('2'), apiKey: '', fetch: fake as typeof fetch }); assert.equal(missing.verified, false);
  db.close();
});
test('Bing parses both responses, locale and caches real zeroes', async () => {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE research_cache (key TEXT PRIMARY KEY, text TEXT, created_at TEXT)');
  let calls = 0;
  const fetcher = async (input: string | URL | Request) => {
    calls++; const url = new URL(String(input));
    assert.equal(url.searchParams.get('country'), 'mx'); assert.equal(url.searchParams.get('language'), 'es-MX');
    assert.equal(url.searchParams.get('startDate'), '2026-10-03'); assert.equal(url.searchParams.get('endDate'), '2026-11-12');
    return new Response(JSON.stringify({ d: url.pathname.endsWith('GetKeyword') ? { Impressions: 0, BroadImpressions: 24 } : [{ Query: 'pintar casa', Impressions: 14, BroadImpressions: 20 }] }));
  };
  const deps = { db, fetch: fetcher as typeof fetch, apiKey: 'test', now: new Date('2026-11-12T12:00:00Z') };
  const result = await bingKeyword('pintar', 'MX', deps);
  assert.deepEqual(result, { impressions: 0, broadImpressions: 24, related: [{ query: 'pintar casa', impressions: 14, broadImpressions: 20 }] });
  assert.deepEqual(await bingKeyword('pintar', 'MX', deps), result); assert.equal(calls, 2);
  assert.equal(await bingKeyword('x', 'GB', deps), null);
  assert.equal(await bingKeyword('x', 'US', { apiKey: '', fetch: fetcher as typeof fetch }), null);
  db.close();
});
test('Trends contract, limit and cache preserve completed results on failure', async () => {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE research_cache (key TEXT PRIMARY KEY, text TEXT, created_at TEXT)');
  const trend = { mean: 31, last8Mean: 35, slope: 'up', rising: ['other query'], top: [] };
  assert.deepEqual(parseTrend(trend), trend); assert.equal(parseTrend({ ...trend, slope: 'rising' }), null);
  let selected: string[] = [];
  const run = async (queries: string[], _country: string, onResult: (query: string, data: unknown) => void) => { selected = queries; onResult(queries[0], trend); throw Error('network unavailable'); };
  const first = await trendsFor(['a', 'b', 'c'], 'US', { db, max: 2, run });
  assert.deepEqual(selected, ['a', 'b']); assert.deepEqual(first.get('a'), trend); assert.equal(first.has('b'), false);
  const second = await trendsFor(['a', 'b'], 'US', { db, max: 0, run }); assert.deepEqual(second.get('a'), trend); assert.equal(second.has('b'), false);
  db.close();
});
test('related Bing demand uses meaningful token overlap or a three-word prefix', async () => {
  const { relatedDemand, measuredDemand, evidenceLine } = await import('../src/agents/topicdata.ts');
  const rows = [
    { query: 'oficina y para', impressions: 500, broadImpressions: 500 },
    { query: 'mantenimiento industrial en planta', impressions: 15, broadImpressions: 20 },
    { query: 'mantenimiento planta oficinas', impressions: 40, broadImpressions: 50 },
  ];
  assert.deepEqual(relatedDemand('oficina para mantenimiento en planta', rows), { query: 'mantenimiento planta oficinas', impressions: 40 });
  assert.equal(relatedDemand('oficina para mantenimiento en planta', [rows[0]]), null);
  assert.deepEqual(relatedDemand('the office for repairs', [{ query: 'the office for rent', impressions: 12, broadImpressions: 15 }]), { query: 'the office for rent', impressions: 12 });
  assert.equal(relatedDemand('paint house', [{ query: 'paint paint the', impressions: 100, broadImpressions: 100 }]), null);
  const e = await verifyQuery('oficina para mantenimiento en planta', { ...opts, ownImpressions60d: 0 }, { fetch: fake as typeof fetch, apiKey: 'test' });
  const zero = { mean: 0, last8Mean: 0, slope: 'flat' as const, rising: [], top: [], noData: true };
  setDemandEvidence(e, { impressions: 0, broadImpressions: 0, related: rows }, zero);
  assert.equal(e.verified, true); assert.equal(measuredDemand(e), true);
  assert.deepEqual(e.bing?.relatedDemand, { query: 'mantenimiento planta oficinas', impressions: 40 });
  assert.match(evidenceLine(e), /mantenimiento planta oficinas, 40 imp/);
  setDemandEvidence(e, { impressions: 0, broadImpressions: 0, related: [rows[0]] }, zero);
  assert.equal(measuredDemand(e), false); assert.ok(scoreTopic(e, { serviceWords: [], isLocalBusiness: false }) <= 7);
  setDemandEvidence(e, e.bing, null); assert.equal(e.verified, true);
});

test('measured zero survives Trends cache, and funnel reports each stage', async () => {
  const { researchFunnel } = await import('../src/agents/topicdata.ts');
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE research_cache (key TEXT PRIMARY KEY, text TEXT, created_at TEXT)');
  const zero = { mean: 0, last8Mean: 0, slope: 'flat', rising: [], top: [] };
  const run = async (queries: string[], _country: string, onResult: (query: string, data: unknown, noData?: boolean) => void) => onResult(queries[0], zero, true);
  const first = await trendsFor(['a', 'b'], 'US', { db, max: 2, run });
  assert.deepEqual(first.get('a'), { ...zero, noData: true }); assert.equal(first.has('b'), false);
  const cached = await trendsFor(['a'], 'US', { db, max: 0 }); assert.deepEqual(cached.get('a'), first.get('a'));
  const e = await verifyQuery('how to paint', { ...opts, ownImpressions60d: 0 }, { fetch: fake as typeof fetch, apiKey: 'test' });
  setDemandEvidence(e, { impressions: 20, broadImpressions: 20, related: [] }, first.get('a')!);
  const missing = { ...e, trends: null, verified: false, bing: null, serpVerified: false };
  assert.equal(researchFunnel([e, missing], 1, 9), 'candidates 2; serp ok 1; bing ok 1; trends measured 1 (noData 1, unmeasured 1); demand-gated 1; kept 1 (>=9)');
  db.close();
});

test('Python Trends emits measured zero for empty and missing frames, stops on 429', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'trends-fake-'));
  try {
    mkdirSync(join(dir, 'pytrends')); writeFileSync(join(dir, 'pytrends', '__init__.py'), '');
    writeFileSync(join(dir, 'pytrends', 'request.py'), `class Frame:\n    def __init__(self, query): self.empty = query == 'empty'\n    def __contains__(self, key): return key == 'empty'\nclass TrendReq:\n    def __init__(self, **kwargs): pass\n    def _get_data(self, *args, **kwargs): pass\n    def build_payload(self, queries, **kwargs):\n        self.query = queries[0]\n        if queries[0] == 'limited': raise Exception('429')\n    def interest_over_time(self): return Frame(self.query)\n`);
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('/usr/bin/python3', ['src/agents/trends.py'], { cwd: process.cwd(), env: { ...process.env, PYTHONPATH: dir } });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({ country: 'MX', queries: ['empty', 'missing', 'limited', 'later'] }));
    });
    assert.equal(result.code, 0, result.stderr);
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines, [...['empty', 'missing'].map((query) => ({ query, data: { mean: 0, last8Mean: 0, slope: 'flat', rising: [], top: [] }, noData: true })), { event: 'rate_limited' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('429 pauses future runs for an hour and preserves results obtained first', async () => {
  const { researchFunnel, evidenceLine } = await import('../src/agents/topicdata.ts');
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE research_cache (key TEXT PRIMARY KEY, text TEXT, created_at TEXT)');
  const trend = { mean: 25, last8Mean: 25, slope: 'flat', rising: [], top: [] };
  let calls = 0;
  const run = async (queries: string[], _country: string, onResult: (q: string, data: unknown) => void, onBlocked: () => void) => { calls++; onResult(queries[0], trend); onBlocked(); };
  const first = await trendsFor(['a', 'b'], 'US', { db, run });
  assert.equal(first.paused, true); assert.deepEqual(first.get('a'), trend); assert.equal(calls, 1);
  assert.ok(db.prepare("SELECT 1 FROM research_cache WHERE key = 'topic-trends-blocked'").get());
  const paused = await trendsFor(['a', 'b'], 'US', { db, run }); assert.equal(paused.paused, true); assert.equal(paused.size, 0); assert.equal(calls, 1);
  assert.match(researchFunnel([], 0, 9, paused.paused), /trends paused/);
  db.prepare("UPDATE research_cache SET created_at = datetime('now', '-61 minutes') WHERE key = 'topic-trends-blocked'").run();
  const again = await trendsFor(['a', 'b'], 'US', { db, run }); assert.equal(calls, 2); assert.deepEqual(again.get('a'), trend);
  const e = await verifyQuery('how to paint', { ...opts, ownImpressions60d: 0 }, { fetch: fake as typeof fetch, apiKey: 'test' });
  setDemandEvidence(e, { impressions: 10, broadImpressions: 10, related: [] }, null);
  assert.match(evidenceLine(e), /Trends not measured \(optional\)/); assert.equal(keepTopic(e, 9, 9), true);
  db.close();
});

test('Python emits interest before a related-queries 429 and then stops', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'trends-related-'));
  try {
    mkdirSync(join(dir, 'pytrends')); writeFileSync(join(dir, 'pytrends', '__init__.py'), '');
    writeFileSync(join(dir, 'pytrends', 'request.py'), `class Series:\n    def tolist(self): return [10, 20]\nclass Frame:\n    empty = False\n    def __contains__(self, key): return True\n    def __getitem__(self, key): return Series()\nclass TrendReq:\n    def __init__(self, **kwargs): pass\n    def _get_data(self, *args, **kwargs): pass\n    def build_payload(self, queries, **kwargs): pass\n    def interest_over_time(self): return Frame()\n    def related_queries(self): raise Exception('429')\n`);
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn('/usr/bin/python3', ['src/agents/trends.py'], { cwd: process.cwd(), env: { ...process.env, PYTHONPATH: dir } });
      let stdout = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.on('error', reject); child.on('close', (code) => resolve({ code, stdout }));
      child.stdin.end(JSON.stringify({ country: 'US', queries: ['first', 'later'] }));
    });
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout.trim().split('\n').map((line) => JSON.parse(line)), [
      { query: 'first', data: { mean: 15, last8Mean: 15, slope: 'flat', rising: [], top: [] } }, { event: 'rate_limited' },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('score v2 rubric points and caps', async () => {
  const raw = await verifyQuery('industrial maintenance checklist', { ...opts, ownImpressions60d: 0 }, { fetch: fake as typeof fetch, apiKey: 'test' });
  const base = { ...raw, verified: true, serpTop10: [], bigBrandCount: 5, smallSiteCount: 0, suggestions: [], paa: [], related: [], ownImpressions60d: 0, location: '', fit: false };
  const cluster = (g: number, sources: string[] = [], bingImpressions = 0) => ({ id: 'x', gscImpressions: g, bingImpressions, sources, bestPosition: 14.2, members: ['a', 'b', 'c'] });
  const sites = Array.from({ length: 5 }, (_, i) => ({ host: `site${i}.test`, url: `https://site${i}.test`, title: 'unrelated' }));
  const args = { isLocalBusiness: true, serviceWords: ['industrial maintenance'] };
  const cases = [
    ['no demand', {}, 1], ['gsc 1', { cluster: cluster(1) }, 3], ['gsc 10', { cluster: cluster(10) }, 4], ['gsc 20', { cluster: cluster(20) }, 5], ['gsc 50', { cluster: cluster(50) }, 6],
    ['bing 10', { cluster: cluster(0, [], 10) }, 4], ['bing 50', { cluster: cluster(0, [], 50) }, 5],
    ['exact suggestion', { suggestions: ['INDUSTRIAL MAINTENANCE CHECKLIST'] }, 4], ['second source', { cluster: cluster(1, ['autocomplete']) }, 5],
    ['trends bonus', { cluster: cluster(10), trends: { mean: 1, last8Mean: 1, slope: 'flat' as const, rising: [], top: [] } }, 5],
    ['brand and small sites', { cluster: cluster(10), serpTop10: sites, bigBrandCount: 2, smallSiteCount: 3 }, 6],
    ['targeted titles', { cluster: cluster(10), serpTop10: sites.map((x) => ({ ...x, title: 'industrial maintenance checklist' })) }, 3],
    ['forum', { cluster: cluster(10), serpTop10: sites.map((x, i) => ({ ...x, host: i ? x.host : 'reddit.com', title: 'industrial maintenance checklist' })) }, 4],
    ['service fit', { cluster: cluster(10), fit: true }, 5], ['local intent', { cluster: cluster(10), location: 'maintenance' }, 5],
    ['autocomplete only full', { cluster: cluster(0, ['autocomplete']), serpTop10: sites, bigBrandCount: 0, smallSiteCount: 5, fit: true, location: 'maintenance' }, 8],
    ['gsc and autocomplete full with one fit', { cluster: cluster(20, ['autocomplete']), serpTop10: sites, bigBrandCount: 0, smallSiteCount: 5, fit: true }, 9],
    ['unverified cap', { cluster: cluster(50, ['autocomplete']), serpTop10: sites, bigBrandCount: 0, smallSiteCount: 5, fit: true, location: 'maintenance', verified: false }, 7],
  ];
  for (const [name, changes, expected] of cases) assert.equal(scoreTopic({ ...base, ...changes }, args), expected, String(name));
});

test('audit records candidates and reports highest scoring drops', async () => {
  const { openDb } = await import('../src/db.ts');
  const { recordTopicCandidate, topicDropReason, droppedSummary } = await import('../src/agents/topicdata.ts');
  const db = openDb(':memory:');
  const e = await verifyQuery('maintenance checklist', { ...opts, ownImpressions60d: 0 }, { fetch: fake as typeof fetch, apiKey: 'test' });
  assert.equal(topicDropReason(e, 7, 9), 'unverified');
  recordTopicCandidate(db, 9, e, 7, 'unverified');
  setDemandEvidence(e, { impressions: 20, broadImpressions: 20, related: [] }, null);
  assert.equal(topicDropReason(e, 8, 9), 'score<9');
  recordTopicCandidate(db, 9, e, 8, 'score<9');
  e.ownRank = 2; assert.equal(topicDropReason(e, 10, 9), 'own top3');
  e.ownRank = null; assert.equal(topicDropReason(e, 9, 9), null); recordTopicCandidate(db, 9, e, 9, null);
  e.bing!.impressions = 0; e.suggestions = []; e.paa = []; e.related = []; assert.equal(topicDropReason(e, 7, 9), 'no measured demand');
  const records = db.prepare('SELECT * FROM topic_candidates ORDER BY id').all() as any[];
  assert.equal(records.length, 3); assert.equal(records[0].dropReason, 'unverified'); assert.equal(records[1].score, 8); assert.equal(records[2].dropReason, null); assert.equal(JSON.parse(records[2].evidence).bing.impressions, 20); assert.ok(records[0].run_date);
  assert.equal(droppedSummary([{ query: 'low', score: 4, reason: 'unverified' }, { query: 'best', score: 8, reason: 'score<9' }, { query: 'kept', score: 10, reason: null }]), 'dropped best: best (8, score<9); low (4, unverified)');
  const many = Array.from({ length: 7 }, (_, i) => ({ query: `query${i}`, score: i, reason: 'score<9' as const }));
  const summary = droppedSummary(many); assert.match(summary, /query6/); assert.doesNotMatch(summary, /query1|query0/);
  db.close();
});

test('three distinct research angles collect candidates and stop safely on later account limits', async () => {
  const { collectResearchAngles } = await import('../src/agents/topicdata.ts');
  const angles = ['questions', 'rivals', 'seasonal']; let calls: string[] = [];
  assert.deepEqual(await collectResearchAngles(angles, async (angle) => { calls.push(angle); return [angle]; }, () => false, () => {}), angles);
  assert.deepEqual(calls, angles);
  assert.equal((await collectResearchAngles(['one'], async () => Array.from({ length: 20 }, (_, i) => i), () => false, () => {})).length, 12);
  calls = []; let limited = 0;
  const partial = await collectResearchAngles(angles, async (angle) => { calls.push(angle); if (angle === 'rivals') throw new Error('limit'); return [angle]; }, (err) => (err as Error).message === 'limit', () => limited++);
  assert.deepEqual(partial, ['questions']); assert.deepEqual(calls, ['questions', 'rivals']); assert.equal(limited, 1);
  await assert.rejects(collectResearchAngles(angles, async () => { throw Error('limit'); }, () => true, () => {}), /limit/);
  await assert.rejects(collectResearchAngles(angles, async (angle) => { if (angle === 'rivals') throw Error('failure'); return [angle]; }, () => false, () => {}), /failure/);
});

test('PAA cluster supplies suggestion demand and evidence', async () => {
  const { demandPoints, evidenceLine } = await import('../src/agents/topicdata.ts');
  const e = await verifyQuery('industrial maintenance', opts, { apiKey: '', fetch: fake as typeof fetch });
  e.cluster = { id: 'industrial-maintenance', gscImpressions: 0, bingImpressions: 0, sources: ['paa'], bestPosition: null, members: ['industrial maintenance'] }; e.ownImpressions60d = 0;
  assert.equal(demandPoints(e), 3); assert.match(evidenceLine(e), /questions; /);
});

test('taken slugs and published outcomes use site, status, score and query clusters', async () => {
  const { openDb } = await import('../src/db.ts'); const { takenSlugs, researchOutcomes } = await import('../src/agents/topicdata.ts');
  const db = openDb(':memory:');
  const topic = db.prepare('INSERT INTO topics (site_id, title, slug, query, score, status) VALUES (?, ?, ?, ?, ?, ?)');
  topic.run(1, 'a', 'a', ' Oficinas móviles ', 9, 'published'); topic.run(1, 'b', 'b', 'no demand', 8, 'published'); topic.run(1, 'c', 'c', 'other term', 6, 'published'); topic.run(1, 'd', 'd', '', 10, 'published'); topic.run(1, 'e', 'e', 'pending topic', 9, 'new'); topic.run(1, 'f', 'f', 'pending low', 8, 'new'); topic.run(1, 'g', 'g', 'draft term', 1, 'drafted'); topic.run(2, 'h', 'h', 'oficinas moviles', 10, 'published');
  const metric = db.prepare("INSERT INTO metrics (site_id, source, date, query, impressions) VALUES (?, ?, ?, ?, ?)");
  metric.run(1, 'gsc', new Date().toISOString().slice(0, 10), 'OFICINAS MÓVILES', 5); metric.run(1, 'gsc', new Date().toISOString().slice(0, 10), 'moviles oficinas', 7); metric.run(1, 'gsc', '2000-01-01', 'oficinas moviles', 100); metric.run(1, 'bing', new Date().toISOString().slice(0, 10), 'other term', 100);
  assert.deepEqual(takenSlugs(db, 1).sort(), ['a', 'b', 'c', 'd', 'e', 'g']);
  assert.deepEqual(researchOutcomes(db, 1), [{ siteId: 1, bucket: '9-10', topics: 1, withImpressions: 1, impressions: 12 }, { siteId: 1, bucket: '7-8', topics: 1, withImpressions: 0, impressions: 0 }, { siteId: 1, bucket: '<7', topics: 1, withImpressions: 0, impressions: 0 }]);
  assert.equal(researchOutcomes(db).length, 4); db.close();
});
