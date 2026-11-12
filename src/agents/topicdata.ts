import type { DatabaseSync } from 'node:sqlite';
import { serper } from '../competitors.ts';
import { registrableDomain } from '../crawl.ts';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export type Evidence = { verified: boolean; serpVerified: boolean; query: string; serpTop10: { url: string; host: string; title: string }[]; paa: string[]; related: string[]; suggestions: string[]; bigBrandCount: number; smallSiteCount: number; ownRank: number | null; ownImpressions60d: number; location: string; bing: BingData | null; trends: TrendData | null; gscVariantImpressions60d: number; trendsRisingMatch: boolean };
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
/* Rubric (maximum 10):
   Base                                      1
   Exact query in autocomplete, PAA or related 2
   GSC impressions >= 10                     1
   Matched competitor topic gap              1
   At most 2 big brands among >= 5 results   1
   At least 3 non-brand sites                 1
   Forum result                              1
   Clear intent (2+ words)                   1
   Local query mentions its location, or non-local business 1
   Measured demand required: GSC > 0, Bing >= 10, or Trends > 0 and flat/up or rising.
   All three sources must be available; unverified/zero-demand capped at 7; top 3 excluded. */
export function scoreTopic(e: Evidence, opts: { gscImpressions: number; competitorGap: boolean; isLocalBusiness: boolean }): number {
  const q = normalize(e.query);
  let score = 1;
  if ([...e.suggestions, ...e.paa, ...e.related].some((s) => normalize(s) === q)) score += 2;
  if (opts.gscImpressions >= 10) score++;
  if (opts.competitorGap) score++;
  if (e.serpTop10.length >= 5 && e.bigBrandCount <= 2) score++;
  if (e.smallSiteCount >= 3) score++;
  if (e.serpTop10.some((x) => /(^|\.)(reddit|quora)\./i.test(x.host) || /\b(forum|foro)\b/i.test(x.url + ' ' + x.title))) score++;
  if (q.split(/\s+/).length >= 2) score++;
  if (!opts.isLocalBusiness || (e.location && q.includes(normalize(e.location)))) score++;
  return Math.max(1, Math.min(e.verified && measuredDemand(e) ? 10 : 7, score));
}
export function keepTopic(e: Evidence, score: number, min: number): boolean { return e.verified && measuredDemand(e) && !(e.ownRank != null && e.ownRank <= 3) && score >= min; }
export function evidenceLine(e: Evidence): string { return `Bing ${e.bing?.impressions ?? 'unavailable'} imp/40d${e.bing?.relatedDemand ? ` (related: ${e.bing.relatedDemand.query}, ${e.bing.relatedDemand.impressions} imp)` : ''}; Trends 12m avg ${e.trends?.mean ?? 'unavailable'} ${e.trends?.slope ?? ''}; GSC ${e.ownImpressions60d + e.gscVariantImpressions60d} imp/60d; SERP #1: ${e.serpTop10[0]?.host ?? 'none'}; big brands: ${e.bigBrandCount}; PAA: ${e.paa.length}`; }

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
  e.bing = bing ? { ...bing, relatedDemand: relatedDemand(e.query, bing.related) } : null; e.trends = trends; e.verified = e.serpVerified && bing !== null && trends !== null;
}
export function measuredDemand(e: Evidence): boolean {
  return e.ownImpressions60d + e.gscVariantImpressions60d > 0 || Math.max(e.bing?.impressions ?? 0, e.bing?.relatedDemand?.impressions ?? 0) >= 10 || !!e.trends && ((e.trends.mean > 0 && e.trends.slope !== 'down') || (e.trendsRisingMatch || e.trends.rising.some((q) => normalize(q) === normalize(e.query))));
}
/** Cached queries do not consume the per-run allowance. */
export async function trendsFor(queries: string[], country: string, deps: { db?: DatabaseSync; max?: number; run?: (queries: string[], country: string, onResult: (query: string, data: unknown, noData?: boolean) => void) => Promise<void> } = {}): Promise<Map<string, TrendData>> {
  const out = new Map<string, TrendData>(), locale = marketLocale(country); if (!locale) return out;
  const cacheKey = (q: string) => 'topic-trends:' + JSON.stringify([normalize(q), locale]);
  const missing: string[] = [];
  for (const q of [...new Set(queries)]) { const data = parseTrend(cacheGet(deps.db, cacheKey(q))); if (data) out.set(q, data); else missing.push(q); }
  const envMax = process.env.TOPIC_TRENDS_MAX, max = deps.max ?? (envMax != null && /^\d+$/.test(envMax) ? Number(envMax) : 12);
  const selected = missing.slice(0, max);
  if (selected.length) try {
    await (deps.run ?? runTrends)(selected, country, (query, raw, noData) => { if (!selected.includes(query)) return; const data = parseTrend(noData === true && raw && typeof raw === 'object' ? { ...raw, noData: true } : raw); if (data) { out.set(query, data); cachePut(deps.db, cacheKey(query), data); } });
  } catch { /* unavailable */ }
  return out;
}
async function runTrends(queries: string[], country: string, onResult: (query: string, data: unknown, noData?: boolean) => void): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(process.env.TRENDS_PY || '/home/darrkito/Yume/.trends-venv/bin/python3', [join(import.meta.dirname, 'trends.py')], { stdio: ['pipe', 'pipe', 'ignore'] });
    let pending = '';
    const timer = setTimeout(() => child.kill(), Math.min(30 * 60_000, queries.length * 90_000 + 30_000));
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => { pending += chunk; const lines = pending.split('\n'); pending = lines.pop()!; for (const line of lines) try { const result = JSON.parse(line); onResult(result.query, result.data, result.noData); } catch { /* ignore invalid output */ } });
    child.on('error', () => { clearTimeout(timer); resolve(); }); child.on('close', () => { clearTimeout(timer); resolve(); });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ queries, country }));
  });
}

/** Funnel counts are over valid, deduplicated candidates submitted for verification. */
export function researchFunnel(evidence: Evidence[], kept: number, min: number): string {
  const serp = evidence.filter((e) => e.serpVerified).length, bing = evidence.filter((e) => e.bing !== null).length;
  const measured = evidence.filter((e) => e.trends !== null).length, noData = evidence.filter((e) => e.trends?.noData === true).length;
  const demand = evidence.filter((e) => e.verified && measuredDemand(e)).length;
  return `candidates ${evidence.length}; serp ok ${serp}; bing ok ${bing}; trends measured ${measured} (noData ${noData}, unmeasured ${evidence.length - measured}); demand-gated ${demand}; kept ${kept} (>=${min})`;
}
