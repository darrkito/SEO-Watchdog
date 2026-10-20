// Competitor discovery for one own site: profile → keywords (real Search Console demand first) →
// localized search results → visibility score → verified same-service rivals. Top 3 become watched sites.
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseDocument, tokenize, inContent } from './vendor/claude-seo-ai/html.mjs';
import { fetchRaw } from './vendor/claude-seo-ai/fetch.mjs';
import { DATA_DIR, type Site } from './db.ts';
import { registrableDomain } from './crawl.ts';
import { textKey } from './extract.ts';
import { askJson, webSearch, newUsage, costUsd, hasLlm, canWebSearch, MODEL, type Usage, type Loc } from './llm.ts';
import { topQueries } from './gsc.ts';

export type Profile = {
  business_name: string; industry: string; services: string[]; city: string; region: string; country: string;
  scope: 'local' | 'national' | 'online'; languages: string[]; brand_terms: string[];
  keywords: { query: string; lang: string; from_gsc: boolean }[]; evidence: string;
};
export type Candidate = {
  id: number; site_id: number; domain: string; url: string; score: number; types: string[]; status: string;
  evidence: { keywords: { q: string; pos: number }[]; overlap: number; best: number; maps?: { rating: number | null; reviews: number | null; name: string }; reason?: string; quote?: string; kind?: string; national?: boolean; eligible?: boolean };
  competitor_site_id: number | null;
};

// Never competitors: platforms, social, marketplaces, references. Directories are kept as a separate list.
const PLATFORMS = /(^|\.)(google|youtube|facebook|instagram|tiktok|x|twitter|linkedin|pinterest|reddit|wikipedia|wikimedia|amazon|mercadolibre|mercadolibre\.com|ebay|aliexpress|temu|shein|walmart|apple|microsoft|bing|yahoo|quora|medium|github|whatsapp|t\.me|canva|etsy)\.[a-z.]+$/i;
const DIRECTORIES = /(^|\.)(yelp|tripadvisor|bodas|zankyou|weddingwire|theknot|paginasamarillas|seccionamarilla|cylex|hotfrog|foursquare|clutch|sortlist|goodfirms|designrush|trustpilot|glassdoor|indeed|computrabajo|occ|doctoralia|habitissimo|homify|cronoshare|fiverr|upwork|99designs|behance|dribbble|opensea|magiceden|coinmarketcap|coingecko)\.[a-z.]+$/i;
const CTR = [0.3, 0.15, 0.1, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.015];
const UA = 'Mozilla/5.0 (compatible; SEOWatchdog/0.1)';

/** Network/LLM calls discover() makes; tests swap them for fakes. */
export type Deps = { askJson: typeof askJson; search: typeof search; fetchRaw: typeof fetchRaw; topQueries: typeof topQueries };
const realDeps = (): Deps => ({ askJson, search, fetchRaw, topQueries });

// ---------- site facts from the latest crawl ----------
function siteFacts(db: DatabaseSync, site: Site) {
  const run = db.prepare("SELECT id FROM runs WHERE site_id = ? AND status = 'ok' ORDER BY id DESC LIMIT 1").get(site.id) as { id: number } | undefined;
  if (!run) throw new Error('Run a check on this site first, so the watchdog knows what it is about.');
  const snaps = db.prepare('SELECT p.url, s.html_hash, s.extract_json FROM snapshots s JOIN pages p ON p.id = s.page_id WHERE s.run_id = ?').all(run.id) as { url: string; html_hash: string | null; extract_json: string }[];
  const home = snaps.find((s) => s.url.replace(/\/$/, '') === site.url.replace(/\/$/, '')) ?? snaps[0];
  const titles = snaps.map((s) => JSON.parse(s.extract_json).title).filter(Boolean).slice(0, 100);
  const langs = [...new Set(snaps.map((s) => JSON.parse(s.extract_json).lang).filter(Boolean).map((l: string) => l.slice(0, 2).toLowerCase()))];
  let text = '', business: Record<string, unknown>[] = [];
  const file = home?.html_hash && join(DATA_DIR, 'html', home.html_hash + '.gz');
  if (file && existsSync(file)) {
    const html = gunzipSync(readFileSync(file)).toString();
    const tokens = tokenize(html);
    for (const t of tokens) if (t.kind === 'text' && inContent(t)) text += ' ' + t.text;
    const doc = parseDocument(html, home.url, { tokens });
    const walk = (n: any) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      const types = [].concat(n['@type'] ?? []).join(' ');
      if (/Business|Organization|Store|Service|Corporation|LocalBusiness/i.test(types))
        business.push({ type: types, name: n.name, address: n.address, areaServed: n.areaServed, telephone: n.telephone, geo: n.geo });
      Object.values(n).forEach(walk);
    };
    doc.jsonld.filter((b: any) => b.ok).forEach((b: any) => walk(b.data));
  }
  return { titles, langs, text: text.replace(/\s+/g, ' ').trim().slice(0, 6000), business: business.slice(0, 5) };
}

const PROFILE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['business_name', 'industry', 'services', 'city', 'region', 'country', 'scope', 'languages', 'brand_terms', 'keywords', 'evidence'],
  properties: {
    business_name: { type: 'string' }, industry: { type: 'string' },
    services: { type: 'array', items: { type: 'string' } },
    city: { type: 'string' }, region: { type: 'string' }, country: { type: 'string', description: 'ISO 3166-1 alpha-2, or empty if unknown' },
    scope: { type: 'string', enum: ['local', 'national', 'online'] },
    languages: { type: 'array', items: { type: 'string' } }, brand_terms: { type: 'array', items: { type: 'string' } },
    keywords: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['query', 'lang', 'from_gsc'], properties: { query: { type: 'string' }, lang: { type: 'string' }, from_gsc: { type: 'boolean' } } } },
    evidence: { type: 'string' },
  },
};

async function buildProfile(d: Deps, u: Usage, site: Site, facts: ReturnType<typeof siteFacts>, gsc: { query: string; impressions: number }[] | null): Promise<Profile> {
  const system = 'You profile a business from its own website so its real competitors can be found. Use only facts supported by the material given. If something is not supported, leave it empty rather than guessing.';
  const prompt = `Website: ${site.url}
Countries it sells to (owner input): ${site.market || 'not given'}
Page languages: ${facts.langs.join(', ') || 'unknown'}
Structured data about the business: ${JSON.stringify(facts.business) || 'none'}
Page titles on the site:\n${facts.titles.map((t: string) => '- ' + t).join('\n')}
Homepage text:\n${facts.text}
${gsc ? `\nReal Google searches that showed this site (query → impressions, last 90 days):\n${gsc.slice(0, 150).map((q) => `${q.query} → ${q.impressions}`).join('\n')}` : '\nNo Search Console data is available.'}

Return the business profile. For "keywords": choose 8-12 searches a potential customer would type to find and hire/buy this business's MAIN services — the searches where its direct competitors also appear.
- Prefer exact queries copied from the real Google searches list above (from_gsc=true). Skip queries about the brand itself, informational/news/event queries, and services the site no longer offers.
- If fewer than 6 real queries qualify, add generated "service + location" queries (from_gsc=false) in the site's languages.
- "scope": local if it serves a city/region, national if a whole country, online if location doesn't matter.
- "evidence": one sentence quoted from the homepage text that shows what the business sells.`;
  const p = await d.askJson<Profile>(u, system, prompt, PROFILE_SCHEMA, 'medium');
  // The model may only *select* GSC queries; anything not in the real list is marked generated.
  const real = new Set((gsc ?? []).map((q) => q.query.toLowerCase()));
  p.keywords = p.keywords.slice(0, 12).map((k) => ({ ...k, from_gsc: k.from_gsc && real.has(k.query.toLowerCase()) }));
  p.country = /^[A-Za-z]{2}$/.test(p.country) ? p.country.toUpperCase() : '';
  return p;
}

// ---------- search results ----------
type Hit = { url: string; position: number; title?: string };
type Place = { website: string; name: string; rating: number | null; reviews: number | null };

async function serper(path: 'search' | 'places', q: string, loc: Loc, lang: string) {
  const location = [loc.city, loc.region, loc.country && new Intl.DisplayNames('en', { type: 'region' }).of(loc.country)].filter(Boolean).join(', ');
  const r = await fetch(`https://google.serper.dev/${path}`, {
    method: 'POST', headers: { 'X-API-KEY': process.env.SERPER_API_KEY!, 'content-type': 'application/json' },
    body: JSON.stringify({ q, ...(loc.country && { gl: loc.country.toLowerCase() }), ...(lang && { hl: lang }), ...(location && { location }), num: 10 }),
  });
  if (!r.ok) throw new Error(`Serper ${path}: HTTP ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
}

async function search(u: Usage, q: string, loc: Loc, lang: string, wantMaps: boolean): Promise<{ organic: Hit[]; places: Place[] }> {
  if (process.env.SERPER_API_KEY) {
    const [o, p] = await Promise.all([serper('search', q, loc, lang), wantMaps ? serper('places', q, loc, lang) : Promise.resolve({ places: [] })]);
    return {
      organic: (o.organic ?? []).map((x: any) => ({ url: x.link, position: x.position, title: x.title })),
      places: (p.places ?? []).filter((x: any) => x.website).map((x: any) => ({ website: x.website, name: x.title, rating: x.rating ?? null, reviews: x.ratingCount ?? null })),
    };
  }
  return { organic: await webSearch(u, q, loc), places: [] }; // no Maps without a SERP API
}

// ---------- verification ----------
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['candidates'],
  properties: { candidates: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['domain', 'kind', 'same_service', 'same_market', 'national', 'reason', 'quote'],
    properties: {
      domain: { type: 'string' }, kind: { type: 'string', enum: ['competitor', 'directory', 'marketplace', 'media', 'unrelated'] },
      same_service: { type: 'boolean' }, same_market: { type: 'string', enum: ['yes', 'no', 'unknown'] }, national: { type: 'boolean' },
      reason: { type: 'string' }, quote: { type: 'string', description: 'exact words copied from that site text' },
    } } } },
};
type Verdict = { domain: string; kind: string; same_service: boolean; same_market: string; national: boolean; reason: string; quote: string };

async function verify(d: Deps, u: Usage, p: Profile, cands: { domain: string; url: string }[]): Promise<Map<string, Verdict & { quoted: boolean }>> {
  const pages = await Promise.all(cands.map(async (c) => {
    const r = await d.fetchRaw(c.url, { ua: UA, timeoutMs: 15_000, retries: 0 });
    let text = '';
    if (r.ok && /html/i.test(r.headers['content-type'] || '')) {
      const doc = parseDocument(r.body.text, r.final_url);
      text = `${doc.title.value ?? ''} — ${doc.metas.find((m: any) => m.name === 'description')?.content ?? ''} — ${doc.text_sample}`.slice(0, 2500);
    }
    return { ...c, text };
  }));
  const res = await d.askJson<{ candidates: Verdict[] }>(u,
    'You decide which websites are direct competitors of a business. A direct competitor sells the same main service to the same kind of customer in the same market. Directories, marketplaces, review sites, news/blogs and unrelated sites are not competitors. Judge only from the text given.',
    `The business: ${p.business_name} — ${p.industry}. Services: ${p.services.join('; ')}. Market: ${[p.city, p.region, p.country].filter(Boolean).join(', ') || 'unknown'} (${p.scope}).

Candidate websites (text from their homepage):
${pages.map((c) => `### ${c.domain}\n${c.text || '(could not load the page)'}`).join('\n\n')}

Return one entry per candidate, using the domain exactly as given. "quote" must be copied word for word from that candidate's text.`,
    VERIFY_SCHEMA);
  const out = new Map<string, Verdict & { quoted: boolean }>();
  for (const v of res.candidates) {
    const page = pages.find((c) => c.domain === v.domain);
    if (!page) continue;
    // Anti-hallucination guard: a verdict whose quote isn't on the page is not trusted as a competitor.
    const quoted = !!v.quote && !!page.text && textKey(page.text).includes(textKey(v.quote));
    out.set(v.domain, { ...v, quoted });
  }
  return out;
}

// ---------- discovery ----------
export async function discover(db: DatabaseSync, site: Site, log = (_: string) => {}, deps: Partial<Deps> = {}) {
  const d = { ...realDeps(), ...deps };
  if (site.kind !== 'own') throw new Error('Competitor discovery runs on your own sites.');
  if (!deps.askJson && !hasLlm()) throw new Error('Set ANTHROPIC_API_KEY in SEO-Watchdog/.env to enable competitor discovery.');
  if (!deps.search && !process.env.SERPER_API_KEY && !canWebSearch) throw new Error(`Set SERPER_API_KEY in SEO-Watchdog/.env: ${MODEL} can't search the web itself.`);
  const u = newUsage();
  const facts = siteFacts(db, site);
  let gsc: Awaited<ReturnType<typeof topQueries>> | null = null;
  if (site.gsc_key && site.gsc_property) {
    try { gsc = await d.topQueries(site.gsc_key, site.gsc_property); log(`Search Console: ${gsc.length} real queries`); }
    catch (e) { log(`Search Console unavailable (${(e as Error).message}); using generated keywords`); }
  }
  const saved = db.prepare('SELECT data_json, source FROM site_profiles WHERE site_id = ?').get(site.id) as { data_json: string; source: string } | undefined;
  const profile: Profile = saved?.source === 'user' ? JSON.parse(saved.data_json) : await buildProfile(d, u, site, facts, gsc);
  if (saved?.source !== 'user') db.prepare("INSERT INTO site_profiles (site_id, data_json, source, updated_at) VALUES (?, ?, 'auto', datetime('now')) ON CONFLICT(site_id) DO UPDATE SET data_json = excluded.data_json, source = 'auto', updated_at = excluded.updated_at").run(site.id, JSON.stringify(profile));
  log(`Profile: ${profile.industry} · ${[profile.city, profile.country].filter(Boolean).join(', ')} · ${profile.keywords.length} keywords`);

  const loc: Loc = { city: profile.city || undefined, region: profile.region || undefined, country: profile.country || site.market.split(',')[0] || undefined };
  const impressions = new Map((gsc ?? []).map((q) => [q.query.toLowerCase(), q.impressions]));
  const maxImp = Math.max(1, ...profile.keywords.map((k) => impressions.get(k.query.toLowerCase()) ?? 0));
  const own = new Set((db.prepare("SELECT url FROM sites WHERE kind = 'own'").all() as { url: string }[]).map((s) => registrableDomain(new URL(s.url).hostname)));
  const agg = new Map<string, { domain: string; url: string; score: number; kws: { q: string; pos: number }[]; maps?: Place; mapsHits: number; best: number }>();
  const add = (rawUrl: string, kw: string, pos: number, weight: number, place?: Place) => {
    let h: URL; try { h = new URL(rawUrl); } catch { return; }
    const d = registrableDomain(h.hostname);
    if (own.has(d) || PLATFORMS.test(h.hostname)) return;
    const a = agg.get(d) ?? { domain: d, url: `${h.protocol}//${h.hostname}/`, score: 0, kws: [], mapsHits: 0, best: 99 };
    if (place) { a.mapsHits++; a.maps ??= place; a.score += weight * 0.15; }
    else if (!a.kws.some((k) => k.q === kw)) { a.kws.push({ q: kw, pos }); a.score += weight * (CTR[pos - 1] ?? 0.01); a.best = Math.min(a.best, pos); }
    agg.set(d, a);
  };
  for (const [i, k] of profile.keywords.entries()) {
    log(`Searching ${i + 1}/${profile.keywords.length}: ${k.query}`);
    const weight = 0.5 + (impressions.get(k.query.toLowerCase()) ?? 0) / maxImp; // real demand counts more
    const r = await d.search(u, k.query, loc, k.lang, profile.scope === 'local');
    const seen = new Set<string>();
    let rank = 0;
    for (const hit of r.organic) { // position = rank among distinct domains, so one site's 3 results don't push others down
      let d: string; try { d = registrableDomain(new URL(hit.url).hostname); } catch { continue; }
      if (seen.has(d)) continue;
      seen.add(d); add(hit.url, k.query, ++rank, weight);
    }
    for (const pl of r.places) add(pl.website, k.query, 0, weight, pl);
  }

  const ranked = [...agg.values()].sort((a, b) => b.score - a.score);
  const directories = ranked.filter((c) => DIRECTORIES.test(c.domain));
  const toCheck = ranked.filter((c) => !DIRECTORIES.test(c.domain)).slice(0, 12);
  log(`Checking ${toCheck.length} candidate websites`);
  const verdicts = toCheck.length ? await verify(d, u, profile, toCheck) : new Map();

  const discId = Number(db.prepare('INSERT INTO discoveries (site_id, provider, model, keywords_json, stats_json) VALUES (?, ?, ?, ?, ?)')
    .run(site.id, process.env.SERPER_API_KEY ? 'serper' : 'claude-web-search', MODEL, JSON.stringify(profile.keywords), '{}').lastInsertRowid);
  const upsert = db.prepare(`INSERT INTO competitor_candidates (site_id, domain, url, score, types_json, evidence_json, status, discovery_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(site_id, domain) DO UPDATE SET url = excluded.url, score = excluded.score, types_json = excluded.types_json,
    evidence_json = excluded.evidence_json, discovery_id = excluded.discovery_id,
    status = CASE WHEN competitor_candidates.status IN ('active', 'pinned', 'excluded', 'user_added') THEN competitor_candidates.status ELSE excluded.status END`);
  db.exec('BEGIN');
  // Candidates absent from this discovery keep their status but drop to score 0, so stale ones sink.
  db.prepare("UPDATE competitor_candidates SET score = 0 WHERE site_id = ? AND status NOT IN ('user_added')").run(site.id);
  for (const c of [...toCheck, ...directories]) {
    const v = verdicts.get(c.domain);
    const isDir = DIRECTORIES.test(c.domain) || v?.kind === 'directory'; // a store or blog is just not a competitor
    const eligible = !!v && v.kind === 'competitor' && v.same_service && v.same_market !== 'no' && v.quoted;
    const types = [c.kws.length ? 'search' : '', c.mapsHits ? 'local' : ''].filter(Boolean);
    upsert.run(site.id, c.domain, c.url, +c.score.toFixed(4), JSON.stringify(types),
      JSON.stringify({ keywords: c.kws, overlap: c.kws.length, best: c.best === 99 ? null : c.best, maps: c.maps && { rating: c.maps.rating, reviews: c.maps.reviews, name: c.maps.name }, reason: v?.reason, quote: v?.quoted ? v.quote : undefined, kind: v?.kind, national: v?.national, eligible: !isDir && eligible }),
      isDir ? 'directory' : eligible ? 'suggested' : 'rejected', discId);
  }
  // First discovery for this site: switch the top 3 on with no clicks needed. Later ones only propose.
  const firstTime = (db.prepare('SELECT COUNT(*) n FROM discoveries WHERE site_id = ?').get(site.id) as { n: number }).n === 1;
  const activated: string[] = [];
  if (firstTime) {
    const watched = (db.prepare("SELECT COUNT(*) n FROM competitor_candidates WHERE site_id = ? AND status IN ('active', 'pinned', 'user_added')").get(site.id) as { n: number }).n;
    const top = db.prepare("SELECT * FROM competitor_candidates WHERE site_id = ? AND status = 'suggested' ORDER BY score DESC LIMIT ?").all(site.id, Math.max(0, 3 - watched)) as any[];
    for (const c of top) { activate(db, site, c.id); activated.push(c.domain); }
  }
  const stats = { keywords: profile.keywords.length, gsc_keywords: profile.keywords.filter((k) => k.from_gsc).length, candidates: ranked.length, checked: toCheck.length,
    eligible: [...verdicts.values()].filter((v) => v.kind === 'competitor' && v.same_service && v.same_market !== 'no' && v.quoted).length,
    directories: directories.length, activated, usage: u, cost_usd: costUsd(u) };
  db.prepare('UPDATE discoveries SET stats_json = ? WHERE id = ?').run(JSON.stringify(stats), discId);
  db.exec('COMMIT');
  return { discoveryId: discId, profile, stats };
}

/** Watch a candidate: creates (or links) a competitor site. Returns the competitor site id. */
export function activate(db: DatabaseSync, site: Site, candidateId: number, status: 'active' | 'pinned' | 'user_added' = 'active'): number {
  const c = db.prepare('SELECT * FROM competitor_candidates WHERE id = ? AND site_id = ?').get(candidateId, site.id) as any;
  if (!c) throw new Error('Unknown candidate');
  let compId = c.competitor_site_id as number | null;
  if (!compId || !db.prepare('SELECT 1 FROM sites WHERE id = ?').get(compId)) {
    const existing = (db.prepare('SELECT id, url FROM sites').all() as { id: number; url: string }[]).find((s) => registrableDomain(new URL(s.url).hostname) === c.domain);
    compId = existing?.id ?? Number(db.prepare("INSERT INTO sites (url, kind, parent_site_id, market, page_limit) VALUES (?, 'competitor', ?, '', 300)").run(c.url, site.id).lastInsertRowid);
  }
  db.prepare('UPDATE competitor_candidates SET status = ?, competitor_site_id = ? WHERE id = ?').run(status, compId, c.id);
  return compId;
}

/** Stop watching a candidate. `exclude` also means: never suggest it again. Deletes its change history. */
export function deactivate(db: DatabaseSync, site: Site, candidateId: number, exclude: boolean) {
  const c = db.prepare('SELECT * FROM competitor_candidates WHERE id = ? AND site_id = ?').get(candidateId, site.id) as any;
  if (!c) throw new Error('Unknown candidate');
  if (c.competitor_site_id) db.prepare("DELETE FROM sites WHERE id = ? AND kind = 'competitor'").run(c.competitor_site_id);
  db.prepare('UPDATE competitor_candidates SET status = ?, competitor_site_id = NULL WHERE id = ?').run(exclude ? 'excluded' : 'suggested', c.id);
}

/** A competitor the user typed in themselves. */
export async function addOwnCompetitor(db: DatabaseSync, site: Site, input: string): Promise<number> {
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : 'https://' + input.trim()); } catch { throw new Error(`Not a website address: ${input}`); }
  if (!url.hostname.includes('.')) throw new Error(`Not a website address: ${input}`);
  const domain = registrableDomain(url.hostname);
  if (domain === registrableDomain(new URL(site.url).hostname)) throw new Error("That's your own site.");
  const probe = await fetchRaw(url.href, { ua: UA, timeoutMs: 20_000 });
  if (probe.status === 0) throw new Error(`Can't reach ${url.hostname}: ${probe.error}`);
  const final = new URL(probe.final_url);
  db.prepare(`INSERT INTO competitor_candidates (site_id, domain, url, score, types_json, evidence_json, status) VALUES (?, ?, ?, 0, '["manual"]', '{}', 'suggested')
    ON CONFLICT(site_id, domain) DO UPDATE SET url = excluded.url`).run(site.id, domain, `${final.protocol}//${final.hostname}/`);
  const id = (db.prepare('SELECT id FROM competitor_candidates WHERE site_id = ? AND domain = ?').get(site.id, domain) as { id: number }).id;
  return activate(db, site, id, 'user_added');
}

export function candidates(db: DatabaseSync, siteId: number): Candidate[] {
  return (db.prepare('SELECT * FROM competitor_candidates WHERE site_id = ? ORDER BY score DESC').all(siteId) as any[])
    .map((c) => ({ ...c, types: JSON.parse(c.types_json || '[]'), evidence: JSON.parse(c.evidence_json || '{}') }));
}
