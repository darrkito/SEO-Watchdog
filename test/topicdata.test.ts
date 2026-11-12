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
test('scores signals deterministically and filters weak, unverified, and top-three results', async () => {
  const e = await verifyQuery('how to paint', opts, { fetch: fake as typeof fetch, apiKey: 'test' });
  e.verified = true;
  const args = { gscImpressions: 20, competitorGap: true, isLocalBusiness: false };
  const score = scoreTopic(e, args); assert.ok(score >= 9); assert.equal(keepTopic(e, score, 9), true);
  assert.equal(keepTopic({ ...e, ownRank: 3 }, score, 9), false);
  const weak = { ...e, serpTop10: [], suggestions: [], paa: [], related: [], bigBrandCount: 0, smallSiteCount: 0 };
  assert.ok(scoreTopic(weak, { gscImpressions: 0, competitorGap: false, isLocalBusiness: true }) < 7);
  const unverified = { ...e, verified: false }; assert.ok(scoreTopic(unverified, args) <= 7); assert.equal(keepTopic(unverified, 10, 9), false); assert.equal(keepTopic(e, 8, 9), false);
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
  const run = async (queries: string[], _country: string, onResult: (query: string, data: unknown) => void) => { selected = queries; onResult(queries[0], trend); throw Error('429'); };
  const first = await trendsFor(['a', 'b', 'c'], 'US', { db, max: 2, run });
  assert.deepEqual(selected, ['a', 'b']); assert.deepEqual(first.get('a'), trend); assert.equal(first.has('b'), false);
  const second = await trendsFor(['a', 'b'], 'US', { db, max: 0, run }); assert.deepEqual(second.get('a'), trend); assert.equal(second.has('b'), false);
  db.close();
});
test('measured demand gates a high score', async () => {
  const e = await verifyQuery('how to paint', { ...opts, ownImpressions60d: 0 }, { fetch: fake as typeof fetch, apiKey: 'test' });
  setDemandEvidence(e, null, null); assert.equal(e.verified, false);
  setDemandEvidence(e, { impressions: 0, broadImpressions: 0, related: [] }, null); assert.equal(e.verified, false);
  setDemandEvidence(e, { impressions: 0, broadImpressions: 0, related: [] }, { mean: 0, last8Mean: 0, slope: 'flat', rising: [], top: [] }); assert.equal(e.verified, true);
  const args = { gscImpressions: 0, competitorGap: true, isLocalBusiness: false };
  e.bing = { impressions: 0, broadImpressions: 20, related: [] }; e.trends = { mean: 0, last8Mean: 0, slope: 'flat', rising: [], top: [] };
  assert.ok(scoreTopic(e, args) <= 7); assert.equal(keepTopic(e, 10, 9), false);
  e.bing.impressions = 10; assert.equal(keepTopic(e, 9, 9), true);
  e.bing.impressions = 0; e.gscVariantImpressions60d = 1; assert.equal(keepTopic(e, 9, 9), true);
  e.gscVariantImpressions60d = 0; e.trends.mean = 10; e.trends.slope = 'down'; assert.equal(keepTopic(e, 9, 9), false);
  e.trends.slope = 'flat'; assert.equal(keepTopic(e, 9, 9), true);
  e.trends.mean = 0; e.trends.rising = ['how to paint']; assert.equal(keepTopic(e, 9, 9), true);
});
