import type { DatabaseSync } from 'node:sqlite';
import { serper } from '../competitors.ts';
import { registrableDomain } from '../crawl.ts';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export type Evidence = { verified: boolean; serpVerified: boolean; query: string; serpTop10: { url: string; host: string; title: string }[]; paa: string[]; related: string[]; suggestions: string[]; bigBrandCount: number; smallSiteCount: number; ownRank: number | null; ownImpressions60d: number; location: string; bing: BingData | null; trends: TrendData | null; gscVariantImpressions60d: number; trendsRisingMatch: boolean; cluster?: { id: string; gscImpressions: number; bingImpressions: number; sources: string[]; bestPosition: number | null; members: string[] }; fit?: boolean };
type Options = { lang: string; country: string; location?: string; ownHost?: string; ownImpressions60d?: number };
type Budget = { calls: number; max: number };
const big = /(^|\.)(wikipedia|amazon|mercadolibre|youtube|pinterest|facebook|instagram|reddit|quora|yelp|tripadvisor|ebay|etsy|walmart|tiktok|linkedin|fiverr|upwork|theknot|weddingwire)\./i;
const normalize = (s: string) => s.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
export const makeBudget = (value = process.env.TOPIC_SERPER_MAX): Budget => ({ calls: 0, max: value != null && /^\d+$/.test(value) ? Number(value) : 40 });
export async function autocomplete(query: string, opts: Options, fetcher: typeof fetch = fetch): Promise<string[]> {
  try {
    const u = new URL('https://suggestqueries.google.com/complete/search');
    for (const [k, v] of Object.entries({ client: 'firefox', q: query, hl: opts.lang, gl: opts.country })) u.searchParams.set(k, v);
    const r = await fetcher(u.toString()); if (!r.ok) return [];
    const data = await r.json() as any; return Array.isArray(data[1]) ? data[1].filter((x: unknown) => typeof x === 'string') : [];
  } catch { return []; }
}
/** Search responses are cacheable across sites; rank and GSC data are recalculated on every call. */
export async function verifyQuery(query: string, opts: Options, deps: { db?: DatabaseSync; fetch?: typeof fetch; budget?: Budget; apiKey?: string } = {}): Promise<Evidence> {
  const fetcher = deps.fetch ?? fetch, budget = deps.budget ?? makeBudget();
  const key = 'topic-serp:' + JSON.stringify([normalize(query), opts.lang, opts.country, opts.location ?? '']);
  const cached = deps.db?.prepare("SELECT text FROM research_cache WHERE key = ? AND created_at >= datetime('now', '-14 days')").get(key) as { text: string } | undefined;
  let data: any;
  if (cached) { try { data = JSON.parse(cached.text); } catch { /* refetch corrupt cache */ } }
  if (!data && (deps.apiKey ?? process.env.SERPER_API_KEY) && budget.calls < budget.max) {
    budget.calls++;
    try {
      const [serp, suggestions] = await Promise.all([serper('search', query, { city: opts.location || undefined, country: opts.country || undefined }, opts.lang, fetcher), autocomplete(query, opts, fetcher)]);
      if (!Array.isArray(serp.organic) || !serp.organic.length) throw new Error('No organic results');
      data = { organic: serp.organic, paa: serp.peopleAlsoAsk, related: serp.relatedSearches, suggestions };
      deps.db?.prepare("INSERT OR REPLACE INTO research_cache (key, text, created_at) VALUES (?, ?, datetime('now'))").run(key, JSON.stringify(data));
    } catch { /* failures must never be treated as verified */ }
  }
  const serpTop10 = (Array.isArray(data?.organic) ? data.organic : []).slice(0, 10).flatMap((x: any) => { try { const url = String(x.link); return [{ url, host: new URL(url).hostname.toLowerCase(), title: String(x.title ?? '') }]; } catch { return []; } });
  const strings = (xs: any, field: string): string[] => Array.isArray(xs) ? xs.map((x: any) => typeof x === 'string' ? x : x?.[field]).filter((x: any) => typeof x === 'string') : [];
  const own = opts.ownHost ? registrableDomain(opts.ownHost.toLowerCase()) : '';
  const index = own ? serpTop10.findIndex((x: any) => registrableDomain(x.host) === own) : -1;
  const bigBrandCount = serpTop10.filter((x: any) => big.test(x.host)).length;
  return { verified: false, serpVerified: !!data && serpTop10.length > 0, query, serpTop10, paa: strings(data?.paa, 'question'), related: strings(data?.related, 'query'), suggestions: strings(data?.suggestions, ''), bigBrandCount, smallSiteCount: serpTop10.length - bigBrandCount, ownRank: index < 0 ? null : index + 1, ownImpressions60d: opts.ownImpressions60d ?? 0, location: opts.location ?? '', bing: null, trends: null, gscVariantImpressions60d: 0, trendsRisingMatch: false };
}
/* Score rubric: demand 0-5 (GSC, Bing or exact suggestion, plus a second signal),
   winnability 0-3 (brands, small sites, weakly targeted SERP), fit 0-2
   (customer and service match, clear intent and local modifier).
   Unverified or zero demand caps the score at 7; own top 3 is excluded. */
export function demandPoints(e: Evidence): number {
  const g = Math.max(e.cluster?.gscImpressions ?? 0, e.ownImpressions60d + e.gscVariantImpressions60d);
  const b = Math.max(e.bing?.impressions ?? 0, e.bing?.relatedDemand?.impressions ?? 0, e.cluster?.bingImpressions ?? 0);
  const suggest = (e.cluster?.sources.includes('autocomplete') || e.cluster?.sources.includes('paa')) || [...e.suggestions, ...e.paa, ...e.related].some((s) => poolKey(s) === poolKey(e.query));
  const gscPts = g >= 50 ? 5 : g >= 20 ? 4 : g >= 10 ? 3 : g >= 1 ? 2 : 0;
  const bingPts = b >= 50 ? 4 : b >= 10 ? 3 : 0;
  let demand = Math.max(gscPts, bingPts, suggest ? 3 : 0);
  if (demand > 0 && ([g >= 1, b >= 10, !!suggest].filter(Boolean).length >= 2 || !!e.trends && e.trends.mean > 0 && e.trends.slope !== 'down')) demand++;
  return Math.min(5, demand);
}
export function scoreTopic(e: Evidence, opts: { isLocalBusiness: boolean; serviceWords: string[] }): number {
  const demand = demandPoints(e), qwords = [...new Set(wordsOf(e.query).filter((w) => !STOPWORDS.has(w)))];
  let score = demand;
  if (e.serpTop10.length >= 5 && e.bigBrandCount <= 2) score++;
  if (e.smallSiteCount >= 3) score++;
  if (e.serpTop10.some((x) => /(^|\.)(reddit|quora)\./i.test(x.host) || /\b(forum|foro)\b/i.test(x.url + ' ' + x.title)) || e.serpTop10.filter((x) => { const words = new Set(wordsOf(x.title)); return qwords.length > 0 && qwords.every((w) => words.has(w)); }).length < 3) score++;
  const service = new Set(opts.serviceWords.flatMap(clusterWords));
  if (e.fit === true && clusterWords(e.query).some((w) => service.has(w))) score++;
  if (wordsOf(e.query).length >= 2 && (!opts.isLocalBusiness || !!e.location && poolKey(e.query).includes(poolKey(e.location)))) score++;
  return Math.max(1, Math.min(e.verified && demand > 0 ? 10 : 7, score));
}
export type DropReason = 'unverified' | 'own top3' | 'no measured demand' | `score<${number}`;
export function topicDropReason(e: Evidence, score: number, min: number): DropReason | null {
  if (!e.verified) return 'unverified';
  if (e.ownRank != null && e.ownRank <= 3) return 'own top3';
  if (!measuredDemand(e)) return 'no measured demand';
  return score < min ? `score<${min}` : null;
}
export function recordTopicCandidate(db: DatabaseSync, siteId: number, e: Evidence, score: number, reason: DropReason | null): void {
  db.prepare('INSERT INTO topic_candidates (site_id, query, score, dropReason, evidence) VALUES (?, ?, ?, ?, ?)').run(siteId, e.query, score, reason, JSON.stringify(e));
}
export type ScoredCandidate = { query: string; score: number; reason: DropReason | null };
export function droppedSummary(rows: ScoredCandidate[]): string {
  const best = rows.filter((r) => r.reason !== null).sort((a, b) => b.score - a.score).slice(0, 5);
  return `dropped best: ${best.length ? best.map((r) => `${r.query} (${r.score}, ${r.reason})`).join('; ') : 'none'}`;
}
export function keepTopic(e: Evidence, score: number, min: number): boolean { return topicDropReason(e, score, min) === null; }
export function evidenceLine(e: Evidence): string { return `Demand: GSC ${e.cluster ? `cluster ${e.cluster.gscImpressions} imp/60d (${e.cluster.members.length} variants, best pos ${e.cluster.bestPosition == null ? '-' : e.cluster.bestPosition.toFixed(1)})` : `${e.ownImpressions60d + e.gscVariantImpressions60d} imp/60d`}; ${e.cluster?.sources.includes('autocomplete') ? 'autocomplete; ' : ''}${e.cluster?.sources.includes('paa') ? 'questions; ' : ''}Bing ${e.bing?.impressions ?? 'unavailable'} imp/40d${e.bing?.relatedDemand ? ` (related: ${e.bing.relatedDemand.query}, ${e.bing.relatedDemand.impressions} imp)` : ''}; Trends ${e.trends ? `12m avg ${e.trends.mean} ${e.trends.slope}${e.trends.noData ? ' (no data)' : ''}` : 'not measured (optional)'}; SERP #1: ${e.serpTop10[0]?.host ?? 'none'}; big brands: ${e.bigBrandCount}; PAA: ${e.paa.length}`; }

export type BingData = { impressions: number; broadImpressions: number; related: { query: string; impressions: number; broadImpressions: number }[]; relatedDemand?: { query: string; impressions: number } | null };
export type TrendData = { mean: number; last8Mean: number; slope: 'up' | 'flat' | 'down'; rising: string[]; top: string[]; noData?: boolean };
export function marketLocale(country: string): { country: string; language: string } | null {
  const c = country.toUpperCase(); return c === 'MX' ? { country: 'mx', language: 'es-MX' } : c === 'US' ? { country: 'us', language: 'en-US' } : null;
}
function cacheGet(db: DatabaseSync | undefined, key: string): any {
  try { const row = db?.prepare("SELECT text FROM research_cache WHERE key = ? AND created_at >= datetime('now', '-14 days')").get(key) as { text: string } | undefined; return row ? JSON.parse(row.text) : null; } catch { return null; }
}
function cachePut(db: DatabaseSync | undefined, key: string, data: unknown) { db?.prepare("INSERT OR REPLACE INTO research_cache (key, text, created_at) VALUES (?, ?, datetime('now'))").run(key, JSON.stringify(data)); }
export async function bingKeyword(query: string, country: string, deps: { db?: DatabaseSync; fetch?: typeof fetch; apiKey?: string; now?: Date } = {}): Promise<BingData | null> {
  const locale = marketLocale(country), key = 'topic-bing:' + JSON.stringify([normalize(query), locale]);
  if (!locale) return null;
  const cached = cacheGet(deps.db, key); if (cached) return cached;
  const apiKey = deps.apiKey ?? process.env.BING_WEBMASTER_API_KEY; if (!apiKey) return null;
  const now = deps.now ?? new Date(), endDate = now.toISOString().slice(0, 10), startDate = new Date(now.getTime() - 40 * 86400000).toISOString().slice(0, 10);
  try {
    const get = async (method: string) => {
      const u = new URL(`https://ssl.bing.com/webmaster/api.svc/json/${method}`);
      for (const [k, v] of Object.entries({ apikey: apiKey, q: query, ...locale, startDate, endDate })) u.searchParams.set(k, v);
      const r = await (deps.fetch ?? fetch)(u.toString()); if (!r.ok) throw Error('Bing unavailable'); return (await r.json() as any).d;
    };
    const [stats, related] = await Promise.all([get('GetKeyword'), get('GetRelatedKeywords')]);
    const valid = (v: any) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    if (!stats || !valid(stats.Impressions) || !valid(stats.BroadImpressions) || !Array.isArray(related)) return null;
    const data: BingData = { impressions: stats.Impressions, broadImpressions: stats.BroadImpressions, related: related.filter((x: any) => typeof x.Query === 'string' && valid(x.Impressions) && valid(x.BroadImpressions)).map((x: any) => ({ query: x.Query, impressions: x.Impressions, broadImpressions: x.BroadImpressions })) };
    cachePut(deps.db, key, data); return data;
  } catch { return null; }
}
export function parseTrend(value: any): TrendData | null {
  const valid = (x: any) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  if (!value || !valid(value.mean) || !valid(value.last8Mean) || !['up', 'flat', 'down'].includes(value.slope) || !Array.isArray(value.rising) || !value.rising.every((x: any) => typeof x === 'string') || !Array.isArray(value.top) || !value.top.every((x: any) => typeof x === 'string')) return null;
  if (value.noData !== undefined && typeof value.noData !== 'boolean') return null;
  return { mean: value.mean, last8Mean: value.last8Mean, slope: value.slope, rising: value.rising, top: value.top, ...(value.noData === true ? { noData: true } : {}) };
}
// Compare whole normalized words; repeated words cannot inflate overlap. Prefixes must contain three words.
const STOPWORDS = new Set('a al ante bajo con contra de del desde durante el en entre es la las lo los para por que se sin sobre su un una unas uno unos y the a an and at by for from in of on or the to with'.split(' '));
const wordsOf = (s: string) => (s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
export function relatedDemand(query: string, related: BingData['related']): { query: string; impressions: number } | null {
  const words = wordsOf(query), significant = new Set(words.filter((w) => !STOPWORDS.has(w)));
  let best: { query: string; impressions: number } | null = null;
  for (const item of related) {
    const candidate = wordsOf(item.query), overlap = new Set(candidate.filter((w) => significant.has(w)));
    const prefix = words.length >= 3 && candidate.length >= 3 && words.slice(0, 3).every((word, i) => candidate[i] === word);
    if ((overlap.size >= 2 || prefix) && (!best || item.impressions > best.impressions)) best = { query: item.query, impressions: item.impressions };
  }
  return best;
}
export function setDemandEvidence(e: Evidence, bing: BingData | null, trends: TrendData | null): void {
  e.bing = bing ? { ...bing, relatedDemand: relatedDemand(e.query, bing.related) } : null; e.trends = trends; e.verified = e.serpVerified && bing !== null;
}
export function measuredDemand(e: Evidence): boolean { return demandPoints(e) > 0; }
/** Cached queries do not consume the per-run allowance. */
export async function trendsFor(queries: string[], country: string, deps: { db?: DatabaseSync; max?: number; run?: (queries: string[], country: string, onResult: (query: string, data: unknown, noData?: boolean) => void, onBlocked: () => void) => Promise<void> } = {}): Promise<Map<string, TrendData> & { paused: boolean }> {
  const out = Object.assign(new Map<string, TrendData>(), { paused: false });
  const blocked = deps.db?.prepare("SELECT 1 FROM research_cache WHERE key = 'topic-trends-blocked' AND created_at > datetime('now', '-60 minutes')").get();
  if (blocked) { out.paused = true; return out; }
  const locale = marketLocale(country); if (!locale) return out;
  const cacheKey = (q: string) => 'topic-trends:' + JSON.stringify([normalize(q), locale]);
  const missing: string[] = [];
  for (const q of [...new Set(queries)]) { const data = parseTrend(cacheGet(deps.db, cacheKey(q))); if (data) out.set(q, data); else missing.push(q); }
  const envMax = process.env.TOPIC_TRENDS_MAX, max = deps.max ?? (envMax != null && /^\d+$/.test(envMax) ? Number(envMax) : 12);
  const selected = missing.slice(0, max);
  if (selected.length) try {
    await (deps.run ?? runTrends)(selected, country, (query, raw, noData) => { if (!selected.includes(query)) return; const data = parseTrend(noData === true && raw && typeof raw === 'object' ? { ...raw, noData: true } : raw); if (data) { out.set(query, data); cachePut(deps.db, cacheKey(query), data); } }, () => { out.paused = true; cachePut(deps.db, 'topic-trends-blocked', { reason: '429' }); });
  } catch (err) {
    if (/429|TooManyRequestsError/i.test(String(err))) { out.paused = true; cachePut(deps.db, 'topic-trends-blocked', { reason: '429' }); }
  }
  return out;
}
async function runTrends(queries: string[], country: string, onResult: (query: string, data: unknown, noData?: boolean) => void, onBlocked: () => void): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(process.env.TRENDS_PY || '/home/darrkito/Yume/.trends-venv/bin/python3', [join(import.meta.dirname, 'trends.py')], { stdio: ['pipe', 'pipe', 'ignore'] });
    let pending = '';
    const timer = setTimeout(() => child.kill(), Math.min(30 * 60_000, queries.length * 90_000 + 30_000));
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => { pending += chunk; const lines = pending.split('\n'); pending = lines.pop()!; for (const line of lines) try { const result = JSON.parse(line); if (result.event === 'rate_limited') onBlocked(); else onResult(result.query, result.data, result.noData); } catch { /* ignore invalid output */ } });
    child.on('error', () => { clearTimeout(timer); resolve(); }); child.on('close', () => { clearTimeout(timer); resolve(); });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ queries, country }));
  });
}

/** Funnel counts are over valid, deduplicated candidates submitted for verification. */
export function researchFunnel(evidence: Evidence[], kept: number, min: number, trendsPaused = false): string {
  const serp = evidence.filter((e) => e.serpVerified).length, bing = evidence.filter((e) => e.bing !== null).length;
  const measured = evidence.filter((e) => e.trends !== null).length, noData = evidence.filter((e) => e.trends?.noData === true).length;
  const demand = evidence.filter((e) => e.verified && measuredDemand(e)).length;
  return `candidates ${evidence.length}; serp ok ${serp}; bing ok ${bing}; trends ${trendsPaused ? 'paused; trends ' : ''}measured ${measured} (noData ${noData}, unmeasured ${evidence.length - measured}); demand-gated ${demand}; kept ${kept} (>=${min})`;
}

/** Run distinct angles in order; a later account limit preserves earlier candidates. */
export async function collectResearchAngles<T>(angles: string[], askAngle: (angle: string) => Promise<T[]>, isLimit: (err: unknown) => boolean, onLimit: () => void): Promise<T[]> {
  const all: T[] = [];
  for (const [index, angle] of angles.entries()) {
    try { all.push(...(await askAngle(angle)).slice(0, 12)); }
    catch (err) { if (index > 0 && isLimit(err)) { onLimit(); break; } throw err; }
  }
  return all;
}

export type PoolEntry = { query: string; sources: ('gsc' | 'autocomplete' | 'bing' | 'paa')[]; gscImpressions: number; gscPosition: number | null; bingImpressions: number; suggestedBy: string[] };
export type Cluster = { id: string; primary: string; members: PoolEntry[]; gscImpressions: number; bingImpressions: number; sources: string[]; bestPosition: number | null };
export const DEMAND_DENYLIST = ['fortnite', 'minecraft', 'roblox', 'dibujo', 'png', 'gif', 'meme'];
const poolKey = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
const clusterWords = (s: string) => [...new Set(wordsOf(s).filter((w) => !STOPWORDS.has(w)).map((w) => w.length > 4 ? w.endsWith('ces') ? w.slice(0, -1) : w.replace(/(?:es|s)$/, '') : w).filter((w) => !['renta', 'alquiler', 'rent', 'rental'].includes(w)))].sort();
export async function buildDemandPool(db: DatabaseSync, siteId: number, opts: { lang: string; country: string; location?: string; services?: string[]; brandTerms?: string[]; geoWords?: string[]; taken?: string[] }, deps: { fetch?: typeof fetch; expand?: boolean; maxSeeds?: number; apiKey?: string; paaMax?: number } = {}): Promise<PoolEntry[]> {
  const rows = db.prepare("SELECT query, SUM(impressions) impressions, SUM(position * impressions) / NULLIF(SUM(impressions), 0) position FROM metrics WHERE site_id = ? AND source = 'gsc' AND date >= date('now', '-60 days') AND date <= date('now') GROUP BY query HAVING SUM(impressions) >= 1 ORDER BY impressions DESC").all(siteId) as { query: string; impressions: number; position: number | null }[];
  const excluded = new Set(rows.filter((r) => r.position != null && r.position <= 3).map((r) => poolKey(r.query)));
  const brands = (opts.brandTerms ?? []).map(poolKey).filter(Boolean);
  const entries = new Map<string, PoolEntry>();
  const add = (query: string, source: PoolEntry['sources'][number]) => {
    const key = poolKey(query); if (!key || excluded.has(key) || brands.some((b) => key.includes(b))) return null;
    let entry = entries.get(key); if (!entry) { entry = { query: query.trim(), sources: [], gscImpressions: 0, gscPosition: null, bingImpressions: 0, suggestedBy: [] }; entries.set(key, entry); }
    if (!entry.sources.includes(source)) entry.sources.push(source); return entry;
  };
  for (const row of rows) { const e = add(row.query, 'gsc'); if (e) { const total = e.gscImpressions + row.impressions; e.gscPosition = e.gscPosition == null ? row.position : row.position == null ? e.gscPosition : (e.gscPosition * e.gscImpressions + row.position * row.impressions) / total; e.gscImpressions = total; } }
  const gscKeys = new Set([...entries.keys()]);
  const seeds = [...new Map([...entries.values()].sort((a, b) => b.gscImpressions - a.gscImpressions).map((e) => [poolKey(e.query), e.query]).concat((opts.services ?? []).map((s) => [poolKey(s), s] as [string, string]))).values()].filter(Boolean).slice(0, deps.maxSeeds ?? 12);
  if (deps.expand !== false) {
    const modifiers = opts.lang.toLowerCase().startsWith('es') ? ['para', 'precio', 'cuanto', 'como', 'que', 'vs', ...(opts.location ? [opts.location] : [])] : ['for', 'cost', 'how', 'what', 'vs', 'near me'];
    const envMax = process.env.TOPIC_PAA_MAX, paaMax = deps.paaMax ?? (envMax != null && /^\d+$/.test(envMax) ? Number(envMax) : 8);
    const apiKey = deps.apiKey ?? process.env.SERPER_API_KEY; let paaCalls = 0;
    for (const seed of seeds) {
      for (const query of [seed, ...modifiers.map((m) => `${seed} ${m}`)]) {
        const key = 'topic-ac:' + JSON.stringify([poolKey(query), opts.lang, opts.country]);
        let suggestions = cacheGet(db, key); if (!Array.isArray(suggestions)) { suggestions = await autocomplete(query, opts, deps.fetch); cachePut(db, key, suggestions); }
        for (const suggestion of suggestions) { if (typeof suggestion !== 'string' || (poolKey(suggestion) === poolKey(seed) && !gscKeys.has(poolKey(seed)))) continue; const e = add(suggestion, 'autocomplete'); if (e && !e.suggestedBy.includes(seed)) e.suggestedBy.push(seed); }
      }
      if (apiKey) {
        const key = 'topic-paa:' + JSON.stringify([normalize(seed), opts.lang]);
        let data = cacheGet(db, key);
        if ((!data || !Array.isArray(data.paa) || !Array.isArray(data.related)) && paaCalls < paaMax) {
          paaCalls++;
          try {
            const body = opts.lang.toLowerCase().startsWith('es') ? { q: seed, hl: 'es-419' } : { q: seed, gl: 'us', hl: 'en' };
            const response = await (deps.fetch ?? fetch)('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': apiKey, 'content-type': 'application/json' }, body: JSON.stringify(body) });
            if (!response.ok) throw Error('Serper unavailable');
            const raw = await response.json() as any;
            const strings = (items: any, field: string): string[] => Array.isArray(items) ? items.map((x: any) => typeof x === 'string' ? x : x?.[field]).filter((x: any) => typeof x === 'string') : [];
            data = { paa: strings(raw.peopleAlsoAsk, 'question'), related: strings(raw.relatedSearches, 'query') }; cachePut(db, key, data);
          } catch { data = null; }
        }
        if (data && Array.isArray(data.paa) && Array.isArray(data.related)) for (const query of [...data.paa, ...data.related]) if (typeof query === 'string') { const e = add(query, 'paa'); if (e && !e.suggestedBy.includes(seed)) e.suggestedBy.push(seed); }
      }
      const bing = await bingKeyword(seed, opts.country, { db, fetch: deps.fetch });
      for (const item of bing?.related ?? []) if (item.impressions >= 1) { const e = add(item.query, 'bing'); if (e) e.bingImpressions = Math.max(e.bingImpressions, item.impressions); }
    }
  }
  const geo = new Set((opts.geoWords ?? []).flatMap(clusterWords));
  const reference = [...rows.map((r) => r.query), ...(opts.services ?? [])].map((s) => new Set(clusterWords(s).filter((w) => !geo.has(w))));
  const taken = (opts.taken ?? []).map((s) => new Set(clusterWords(s)));
  return [...entries.values()].filter((e) => { const words = clusterWords(e.query); return wordsOf(e.query).length >= 2 && !wordsOf(e.query).some((w) => DEMAND_DENYLIST.includes(w)) && reference.some((ref) => words.filter((w) => !geo.has(w) && ref.has(w)).length >= (e.sources.includes('gsc') ? 1 : 2)) && !(words.length >= 2 && taken.some((t) => words.every((w) => t.has(w)))); });
}
export const clusterId = (query: string) => clusterWords(query).join('-');
export function clusterQueries(pool: PoolEntry[]): Cluster[] {
  const groups = new Map<string, PoolEntry[]>();
  for (const entry of pool) { const id = clusterId(entry.query); const members = groups.get(id) ?? []; members.push(entry); groups.set(id, members); }
  return [...groups].map(([id, members]) => {
    const primary = [...members].sort((a, b) => b.gscImpressions - a.gscImpressions || b.sources.length - a.sources.length || a.query.length - b.query.length)[0].query;
    const positions = members.flatMap((m) => m.gscPosition == null ? [] : [m.gscPosition]);
    return { id, primary, members, gscImpressions: members.reduce((n, m) => n + m.gscImpressions, 0), bingImpressions: members.reduce((n, m) => n + m.bingImpressions, 0), sources: [...new Set(members.flatMap((m) => m.sources))], bestPosition: positions.length ? Math.min(...positions) : null };
  }).sort((a, b) => b.gscImpressions - a.gscImpressions || b.sources.length - a.sources.length);
}
export function headTerms(clusters: Cluster[], services: string[], max = 5): string[] {
  const candidates = [...[...clusters].sort((a, b) => b.gscImpressions - a.gscImpressions).map((c) => c.primary), ...services];
  const seen = new Set<string>();
  return candidates.filter((term) => { const count = wordsOf(term).filter((w) => !STOPWORDS.has(w)).length, id = clusterId(term); if (count < 2 || count > 3 || !id || seen.has(id)) return false; seen.add(id); return true; }).slice(0, max);
}
export function trendForCluster(cluster: Cluster, trends: Map<string, TrendData>): TrendData | null {
  const words = new Set(cluster.id.split('-')); let best: TrendData | null = null;
  for (const [term, trend] of trends) { const head = clusterWords(term); if (!trend.noData && head.length && head.every((w) => words.has(w)) && (!best || trend.mean > best.mean)) best = trend; }
  return best;
}
export function takenSlugs(db: DatabaseSync, siteId: number): string[] {
  return (db.prepare("SELECT slug FROM topics WHERE site_id = ? AND (status IN ('drafted','published') OR (status = 'new' AND score >= 9))").all(siteId) as { slug: string }[]).map((r) => r.slug);
}
export function researchOutcomes(db: DatabaseSync, siteId?: number): { siteId: number; bucket: string; topics: number; withImpressions: number; impressions: number }[] {
  const topics = db.prepare("SELECT site_id, query, score FROM topics WHERE status = 'published' AND trim(query) != '' AND (? IS NULL OR site_id = ?)").all(siteId ?? null, siteId ?? null) as { site_id: number; query: string; score: number }[];
  const metrics = db.prepare("SELECT site_id, query, SUM(impressions) impressions FROM metrics WHERE source = 'gsc' AND date >= date('now', '-27 days') AND date <= date('now') AND (? IS NULL OR site_id = ?) GROUP BY site_id, query").all(siteId ?? null, siteId ?? null) as { site_id: number; query: string; impressions: number }[];
  const groups = new Map<string, { siteId: number; bucket: string; topics: number; withImpressions: number; impressions: number }>();
  for (const topic of topics) {
    const bucket = topic.score >= 9 ? '9-10' : topic.score >= 7 ? '7-8' : '<7', key = `${topic.site_id}:${bucket}`, id = clusterId(topic.query), exact = normalize(topic.query);
    const impressions = metrics.filter((m) => m.site_id === topic.site_id && (normalize(m.query) === exact || !!id && clusterId(m.query) === id)).reduce((n, m) => n + m.impressions, 0);
    const row = groups.get(key) ?? { siteId: topic.site_id, bucket, topics: 0, withImpressions: 0, impressions: 0 }; row.topics++; if (impressions > 0) row.withImpressions++; row.impressions += impressions; groups.set(key, row);
  }
  return [...groups.values()].sort((a, b) => a.siteId - b.siteId || ['9-10', '7-8', '<7'].indexOf(a.bucket) - ['9-10', '7-8', '<7'].indexOf(b.bucket));
}
export function replayReport(clusters: Cluster[], pool: PoolEntry[]): string {
  const counts = ['gsc', 'autocomplete', 'bing', 'paa'].map((s) => `${s} ${pool.filter((e) => e.sources.includes(s as PoolEntry['sources'][number])).length}`).join('; ');
  const lines = clusters.slice(0, 25).map((c) => `${c.gscImpressions}\t${c.bestPosition == null ? '-' : c.bestPosition.toFixed(1)}\t${c.sources.join(',')}\t${c.members.length}\t${c.primary}`);
  return [`Pool: ${pool.length}; ${counts}`, `Clusters: ${clusters.length}`, 'GSC impressions\tBest position\tSources\tMembers\tPrimary', ...lines, `Clusters: >=50 ${clusters.filter((c) => c.gscImpressions >= 50).length}; >=20 ${clusters.filter((c) => c.gscImpressions >= 20).length}; >=10 ${clusters.filter((c) => c.gscImpressions >= 10).length}; 2+ sources ${clusters.filter((c) => new Set(c.sources).size >= 2).length}`].join('\n');
}

export type ResearchPick = { clusterId: string; title: string; slug: string; action: string; why: string; fit: boolean };
export function acceptPicks(picks: unknown, shortlist: Cluster[], takenSlugs: Iterable<string>): (ResearchPick & { query: string; cluster: Cluster })[] {
  const taken = new Set(takenSlugs), seen = new Set<string>(), clusters = new Map(shortlist.map((c) => [c.id, c]));
  if (!Array.isArray(picks)) return [];
  const accepted: (ResearchPick & { query: string; cluster: Cluster })[] = [];
  for (const p of picks) {
    const cluster = clusters.get(p?.clusterId);
    if (!cluster || seen.has(cluster.id) || typeof p.title !== 'string' || !p.title.trim() || typeof p.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.slug) || taken.has(p.slug) || typeof p.fit !== 'boolean' || typeof p.why !== 'string' || typeof p.action !== 'string' || !/^(new|merge:[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(p.action)) continue;
    seen.add(cluster.id); taken.add(p.slug); accepted.push({ ...p, query: cluster.primary, cluster });
    if (accepted.length === 12) break;
  }
  return accepted;
}
export function rescoreVerdict(cluster: Cluster | undefined): 'keep' | 'reject' { return cluster && cluster.gscImpressions >= 10 ? 'keep' : 'reject'; }
