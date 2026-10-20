// "How to win": for each search, where the own site ranks, who beats it, and what their ranking page has
// that ours lacks. Built only from collected data (search results, crawls, Search Console), no model guesses.
import type { DatabaseSync } from 'node:sqlite';
import { domainToUnicode } from 'node:url';
import type { Site } from './db.ts';
import { registrableDomain } from './crawl.ts';
import { textKey, type Extract } from './extract.ts';
import type { Serp } from './competitors.ts';

const show = (d: string) => domainToUnicode(d) || d; // xn--… → readable, for sentences
const STOP = new Set('de la el los las en y para con por del un una al lo le su sus tu que es se mas the of and for in to on with your our you are from how what'.split(' '));
const stem = (w: string) => (w.length > 4 ? w.replace(/(es|s)$/, '') : w);
export const terms = (s: string | null | undefined) => [...new Set(textKey(s ?? '').split(' ').filter((w) => w.length > 2 && !STOP.has(w)).map(stem))];
/** Share of `want` stems present in `text` (1 = every word of the search is there). */
export const coverage = (text: string | null | undefined, want: string[]) => {
  if (!want.length) return 1;
  const have = new Set(terms(text));
  return want.filter((w) => have.has(w)).length / want.length;
};
const missing = (text: string | null | undefined, want: string[]) => { const have = new Set(terms(text)); return want.filter((w) => !have.has(w)); };
const urlKey = (u: string) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '')).toLowerCase(); } catch { return u; } };
const firstPart = (t: string | null) => (t ?? '').split(/\s[|–—-]\s/)[0].trim(); // drop "| Brand" suffixes
// Only schema types that earn something in Google count as advice; the Article family is one type (BlogPosting = Article).
// Found live: "add Article" to a blog full of BlogPosting, and QAPage/ItemPage/WebApplication suggestions.
const USEFUL = new Set(['FAQPage', 'Product', 'Offer', 'AggregateRating', 'Review', 'LocalBusiness', 'Store', 'Service', 'HowTo', 'VideoObject', 'Event', 'Article', 'BreadcrumbList']);
const kind = (t: string) => (/^(Article|BlogPosting|NewsArticle|TechArticle|Report)$/.test(t) ? 'Article' : t);
const useful = (types: string[]) => new Set(types.map(kind).filter((t) => USEFUL.has(t)));

export type Page = Extract & { key: string };
export function latestPages(db: DatabaseSync, siteId: number): Page[] {
  const run = db.prepare("SELECT id FROM runs WHERE site_id = ? AND status = 'ok' ORDER BY id DESC LIMIT 1").get(siteId) as { id: number } | undefined;
  if (!run) return [];
  return (db.prepare('SELECT p.url, s.extract_json FROM snapshots s JOIN pages p ON p.id = s.page_id WHERE s.run_id = ?').all(run.id) as { url: string; extract_json: string }[])
    .map((r) => ({ ...(JSON.parse(r.extract_json) as Extract), key: urlKey(r.url) }))
    .filter((p) => p.is_html && p.status === 200 && !p.noindex);
}

export type Issue = { text: string; fix: string };
export type KeywordRow = {
  query: string; gsc?: Serp[string]['gsc']; ownRank: number | null; ownUrl: string | null;
  above: { rank: number; domain: string; url: string; watched: boolean }[];
  rival?: { domain: string; url: string; rank: number; title: string | null };
  ownPage?: { url: string; title: string | null }; issues: Issue[]; score: number;
};
export type Battle = {
  at: string; keywords: KeywordRow[]; reviews?: { own: { rating: number | null; reviews: number | null } | null; rivals: { domain: string; name: string; rating: number | null; reviews: number | null }[] };
  schemaGaps: { type: string; domains: string[] }[]; topicGaps: { title: string; url: string; domain: string; theirs: number; ours: number }[];
  actions: (Issue & { query?: string; score: number })[];
};

/** Own page vs the best-ranked crawled rival page above it, for one search. */
export function comparePages(query: string, own: Page | undefined, rival: Page | undefined, rivalLabel: string): Issue[] {
  const want = terms(query);
  if (!own) return [{ text: `You have no page aimed at “${query}”.${rival ? ` ${rivalLabel} ranks with “${firstPart(rival.title)}”.` : ''}`, fix: `Create a page for this search, with “${query}” in its title and main heading, and link to it from your homepage.` }];
  if (!rival) return [];
  const out: Issue[] = [];
  for (const [field, label, a, b] of [['title', 'title', own.title, rival.title], ['h1', 'main heading (H1)', own.h1[0], rival.h1[0]], ['meta', 'description', own.meta_description, rival.meta_description]] as const) {
    const mine = coverage(a, want), theirs = coverage(b, want);
    if (mine < 1 && mine < theirs) out.push({ text: `Your ${label} is missing “${missing(a, want).join(', ')}” for “${query}”; ${rivalLabel}'s has ${theirs === 1 ? 'every word' : 'more of them'}${b ? `: “${b}”` : ''}.`, fix: field === 'meta' ? `Rewrite the description to include “${query}” naturally.` : `Put “${query}” in your ${label}.` });
  }
  if (rival.word_count > 300 && own.word_count < rival.word_count * 0.6) out.push({ text: `${rivalLabel}'s page has ${rival.word_count} words; yours has ${own.word_count}.`, fix: 'Add useful detail: prices or what is included, coverage area, process, photos with captions, FAQs.' });
  const ownSchema = useful(own.jsonld_types);
  const extra = [...useful(rival.jsonld_types)].filter((t) => !ownSchema.has(t));
  if (extra.length) out.push({ text: `${rivalLabel}'s page has structured data you don't: ${extra.join(', ')}.`, fix: `Add ${extra.join(', ')} JSON-LD to your page (only for content that is really on it).` });
  if (rival.faq_questions.length && !own.faq_questions.length) out.push({ text: `${rivalLabel} answers ${rival.faq_questions.length} questions on that page; yours has no FAQ.`, fix: 'Add a short FAQ with the questions customers really ask, visible on the page and marked up as FAQPage.' });
  return out;
}

export function battle(db: DatabaseSync, site: Site): Battle | null {
  const disc = db.prepare('SELECT at, serp_json FROM discoveries WHERE site_id = ? AND serp_json IS NOT NULL ORDER BY id DESC LIMIT 1').get(site.id) as { at: string; serp_json: string } | undefined;
  if (!disc) return null;
  const serp: Serp = JSON.parse(disc.serp_json);
  const ownDomain = registrableDomain(new URL(site.url).hostname);
  const ownPages = latestPages(db, site.id);
  const ownByKey = new Map(ownPages.map((p) => [p.key, p]));
  const watched = db.prepare("SELECT domain, competitor_site_id FROM competitor_candidates WHERE site_id = ? AND status IN ('active','pinned','user_added') AND competitor_site_id IS NOT NULL").all(site.id) as { domain: string; competitor_site_id: number }[];
  const rivalPages = new Map(watched.map((w) => [w.domain, latestPages(db, w.competitor_site_id)]));
  const rivalByKey = new Map([...rivalPages.values()].flat().map((p) => [p.key, p]));

  const keywords: KeywordRow[] = Object.entries(serp).map(([query, s]) => {
    const mine = s.organic.find((o) => o.domain === ownDomain);
    const above = s.organic.filter((o) => o.domain !== ownDomain && (!mine || o.rank < mine.rank)).slice(0, 5).map((o) => ({ ...o, watched: rivalPages.has(o.domain) }));
    const want = terms(query);
    // Our page for this search: the one Google shows, else the page whose title/H1 best covers the search.
    let ownPage = mine ? ownByKey.get(urlKey(mine.url)) : undefined;
    if (!ownPage) {
      const best = ownPages.map((p) => ({ p, c: Math.max(coverage(p.title, want), coverage(p.h1[0], want)) })).sort((a, b) => b.c - a.c || b.p.word_count - a.p.word_count)[0];
      if (best && best.c >= 0.6) ownPage = best.p;
    }
    const r = above.find((o) => rivalByKey.has(urlKey(o.url)));
    const rivalPage = r && rivalByKey.get(urlKey(r.url));
    const issues = mine && mine.rank === 1 ? [] : comparePages(query, ownPage, rivalPage, show(r?.domain ?? above[0]?.domain ?? 'The top result'));
    const gap = mine ? mine.rank - (above[0]?.rank ?? mine.rank) : 10;
    return { query, gsc: s.gsc, ownRank: mine?.rank ?? null, ownUrl: mine?.url ?? null, above, issues, score: ((s.gsc?.impressions ?? 0) + 10) * Math.max(gap, 0),
      ...(r && rivalPage && { rival: { domain: r.domain, url: r.url, rank: r.rank, title: rivalPage.title } }),
      ...(ownPage && { ownPage: { url: ownPage.url, title: ownPage.title } }) };
  }).sort((a, b) => b.score - a.score);

  // Google Maps: own listing vs rivals, best figures seen across all searches.
  // Maps also lists venues and other non-rivals: compare only with businesses verified as competitors.
  const rivalDomains = new Set((db.prepare("SELECT domain FROM competitor_candidates WHERE site_id = ? AND status IN ('active','pinned','user_added','suggested')").all(site.id) as { domain: string }[]).map((r) => r.domain));
  const places = Object.values(serp).flatMap((s) => s.places).filter((p) => p.domain === ownDomain || rivalDomains.has(p.domain));
  let reviews: Battle['reviews'];
  if (places.length) {
    const best = new Map<string, (typeof places)[number]>();
    for (const p of places) if ((p.reviews ?? 0) >= (best.get(p.domain)?.reviews ?? -1)) best.set(p.domain, p);
    const own = best.get(ownDomain);
    reviews = { own: own ? { rating: own.rating, reviews: own.reviews } : null, rivals: [...best.values()].filter((p) => p.domain !== ownDomain).sort((a, b) => (b.reviews ?? 0) - (a.reviews ?? 0)).slice(0, 6) };
  }

  const ownTypes = useful(ownPages.flatMap((p) => p.jsonld_types));
  const typeDomains = new Map<string, Set<string>>();
  for (const [domain, ps] of rivalPages) for (const t of useful(ps.flatMap((p) => p.jsonld_types))) if (!ownTypes.has(t)) typeDomains.set(t, (typeDomains.get(t) ?? new Set()).add(domain));
  const schemaGaps = [...typeDomains].map(([type, ds]) => ({ type, domains: [...ds] })).sort((a, b) => b.domains.length - a.domains.length);

  // Topics = the search words a page title uses. Counting pages per topic, theirs vs ours, shows where a rival
  // simply has more content (26 "service + city" pages, a 200-post blog) without claiming we have none.
  const vocab = new Set(Object.keys(serp).flatMap((q) => terms(q)));
  const ownTitles = ownPages.map((p) => new Set(terms(`${p.title ?? ''} ${p.h1[0] ?? ''}`)));
  const groups = new Map<string, Battle['topicGaps'][number] & { sig: string[] }>();
  for (const [domain, ps] of rivalPages) for (const p of ps) {
    const title = firstPart(p.h1[0] || p.title);
    const sig = terms(title).filter((w) => vocab.has(w)).sort();
    if (sig.length < 2) continue;
    const key = domain + ' ' + sig.join(' ');
    const g = groups.get(key);
    if (g) g.theirs++; else groups.set(key, { title, url: p.url, domain, theirs: 1, ours: 0, sig });
  }
  for (const g of groups.values()) g.ours = ownTitles.filter((o) => g.sig.every((w) => o.has(w))).length;
  const topicGaps = [...groups.values()].filter((g) => g.ours === 0 || g.theirs >= g.ours * 3)
    .sort((a, b) => b.theirs - b.ours - (a.theirs - a.ours)).map(({ sig: _, ...g }) => g);

  // Same advice for several searches becomes one action listing them.
  const merged = new Map<string, Battle['actions'][number] & { queries: string[] }>();
  for (const k of keywords) for (const i of k.issues) {
    const m = merged.get(i.text + i.fix);
    if (m) { m.queries.push(k.query); m.score += k.score; } else merged.set(i.text + i.fix, { ...i, query: k.query, queries: [k.query], score: k.score });
  }
  const actions: Battle['actions'] = [...merged.values()].map(({ queries, ...a }) => ({ ...a, query: queries.join('”, “') }));
  if (reviews) {
    const top = reviews.rivals[0], own = reviews.own;
    if (!own) actions.push({ text: `Your business does not appear in the Google Maps results for these searches${top ? `; ${top.name} does, with ${top.reviews ?? 0} reviews` : ''}.`, fix: 'Claim/complete your Google Business Profile (category, service area, website link, photos) and ask recent customers for reviews.', score: 500 });
    else if (top && (top.reviews ?? 0) > (own.reviews ?? 0) * 1.5) actions.push({ text: `${top.name} has ${top.reviews} Google reviews (${top.rating}★); you have ${own.reviews ?? 0}${own.rating ? ` (${own.rating}★)` : ''}.`, fix: 'Ask every recent customer for a review (send the direct review link by WhatsApp) and reply to each one.', score: 400 });
  }
  for (const g of topicGaps.filter((t) => t.theirs >= 5).slice(0, 2)) actions.push({ text: `${show(g.domain)} has ${g.theirs} pages on this topic (e.g. “${g.title}”); you have ${g.ours}.`, fix: 'Cover it with more pages that each answer a specific need (an area you serve, a variant, a question customers ask), each with real, distinct content, not copies with one word swapped.', score: 20 * (g.theirs - g.ours) });
  for (const g of schemaGaps.filter((g) => !actions.some((a) => a.text.includes(g.type))).slice(0, 3)) actions.push({ text: `${g.domains.map(show).join(', ')} use ${g.type} structured data; no page of yours does.`, fix: `Add ${g.type} JSON-LD where that content really exists on your site.`, score: 50 * g.domains.length });
  actions.sort((a, b) => b.score - a.score);
  return { at: disc.at, keywords, reviews, schemaGaps, topicGaps: topicGaps.slice(0, 15), actions: actions.slice(0, 12) };
}
