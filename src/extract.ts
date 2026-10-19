// Turn one fetched page into the flat record every rule and diff works from. Pure: no I/O.
import { createHash } from 'node:crypto';
import { parseDocument, tokenize, inContent } from './vendor/claude-seo-ai/html.mjs';
import { decodeEntities } from './vendor/claude-seo-ai/entities.mjs';
import { normalizeUrl, hostKey } from './vendor/claude-seo-ai/urlnorm.mjs';

export type Fetched = {
  url: string;
  status: number;
  final_url: string;
  error: string | null;
  headers: Record<string, string>;
  status_chain: { url: string; status: number; location: string | null }[];
  redirects: { hops: number; loop: boolean };
  body: { text: string };
};

export type Extract = {
  url: string;
  final_url: string;
  status: number;
  error: string | null;
  timed_out: boolean;
  redirect_hops: number;
  redirect_loop: boolean;
  is_html: boolean;
  title: string | null;
  title_count: number;
  meta_description: string | null;
  h1: string[];
  canonical: string | null;
  canonical_count: number;
  og_url: string | null;
  noindex: boolean;
  robots: string;
  lang: string | null;
  hreflang: { lang: string; href: string }[];
  jsonld_types: string[];
  jsonld_invalid: number;
  faq_questions: string[];
  faq_not_visible: string[];
  word_count: number;
  app_shell_empty: boolean;
  text_hash: string | null;
  links: string[];
};

const ASSET = /\.(jpe?g|png|gif|webp|avif|svg|ico|pdf|zip|mp4|webm|mp3|css|js|json|xml|txt|woff2?)$/i;

export const norm = (u: string, base?: string) => normalizeUrl(u, { base, stripTrailingSlash: true });

/** Text-match key: entities decoded, lowercased, punctuation and whitespace collapsed (`'` vs `&#x27;` safe). */
export const textKey = (s: string) =>
  decodeEntities(String(s)).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Copy-change fingerprint: sorted words, numbers dropped. Found live: streamed SSR reorders sections
 * between requests (Luvory) and live-data pages tick prices/counts (Blockchains.click) — neither is a rewrite.
 */
export const contentHash = (text: string) =>
  createHash('sha256').update(textKey(text).split(' ').filter((w) => w && !/\d/.test(w)).sort().join(' ')).digest('hex').slice(0, 16);

function faqQuestions(data: unknown, out: string[] = []): string[] {
  if (Array.isArray(data)) { for (const d of data) faqQuestions(d, out); return out; }
  if (!data || typeof data !== 'object') return out;
  const o = data as Record<string, unknown>;
  const types = ([] as unknown[]).concat(o['@type'] ?? []);
  if (types.includes('Question') && typeof o.name === 'string') out.push(o.name);
  for (const k of Object.keys(o)) if (k !== 'name') faqQuestions(o[k], out);
  return out;
}

export function extractPage(f: Fetched): Extract {
  const ctype = f.headers['content-type'] || '';
  const is_html = f.status >= 200 && f.status < 300 && (/html/i.test(ctype) || (!ctype && /<html/i.test(f.body.text)));
  const base: Extract = {
    url: f.url, final_url: f.final_url, status: f.status, error: f.error,
    timed_out: /timeout|aborted/i.test(f.error || ''),
    redirect_hops: f.redirects.hops, redirect_loop: f.redirects.loop, is_html,
    title: null, title_count: 0, meta_description: null, h1: [], canonical: null, canonical_count: 0, og_url: null,
    noindex: false, robots: '', lang: null, hreflang: [], jsonld_types: [], jsonld_invalid: 0,
    faq_questions: [], faq_not_visible: [], word_count: 0, app_shell_empty: false, text_hash: null, links: [],
  };
  const xRobots = (f.headers['x-robots-tag'] || '').toLowerCase();
  base.robots = xRobots;
  base.noindex = /noindex|none/.test(xRobots);
  if (!is_html) return base;

  const html = f.body.text;
  const tokens = tokenize(html);
  const doc = parseDocument(html, f.final_url, { tokens });
  const meta = (n: string) => doc.metas.find((m: any) => m.name === n)?.content ?? null;
  const robots = [xRobots, ...doc.robots_meta.map((r: any) => String(r.content || '').toLowerCase())].filter(Boolean).join(', ');

  // Full visible text (nav/footer included: a FAQ can live anywhere visible). Raw elements are separate tokens.
  // Content text (no nav/footer/aside) feeds the change hash, so a menu tweak doesn't flag every page.
  let visible = '', content = '';
  for (const t of tokens) {
    if (t.kind !== 'text' || (t.parent >= 0 && ['title', 'head'].includes(tokens[t.parent].name))) continue;
    visible += ' ' + t.text;
    if (inContent(t)) content += ' ' + t.text;
  }
  const visibleKey = textKey(visible);

  const faq = doc.jsonld.filter((b: any) => b.ok).flatMap((b: any) => faqQuestions(b.data));
  const host = hostKey(f.final_url);
  const links = new Set<string>();
  for (const a of doc.anchors) {
    if (!a.abs || a.fragment_only || hostKey(a.abs) !== host) continue;
    const n = normalizeUrl(a.abs); // trailing slash kept: this is the URL we fetch; keys use norm()
    if (n && !ASSET.test(new URL(n).pathname)) links.add(n);
  }

  return {
    ...base,
    title: doc.title.value, title_count: doc.title.count,
    meta_description: meta('description'),
    h1: doc.headings.filter((h: any) => h.level === 1).map((h: any) => h.text),
    canonical: doc.canonicals[0]?.abs ?? null, canonical_count: doc.canonicals.length,
    og_url: doc.metas.find((m: any) => m.property === 'og:url')?.content ?? null,
    robots, noindex: /noindex|(^|[\s,])none([\s,]|$)/.test(robots),
    lang: doc.lang,
    hreflang: doc.hreflang.map((h: any) => ({ lang: String(h.hreflang).toLowerCase(), href: h.abs || h.href })),
    jsonld_types: [...new Set<string>(doc.jsonld.flatMap((b: any) => b.type))].sort(),
    jsonld_invalid: doc.jsonld.filter((b: any) => !b.ok).length,
    faq_questions: faq,
    faq_not_visible: faq.filter((q: string) => !visibleKey.includes(textKey(q))),
    word_count: doc.word_count,
    app_shell_empty: doc.word_count < 50 && (doc.markers.app_root_empty === true || doc.markers.next_root_empty === true),
    text_hash: contentHash(content),
    links: [...links].sort(),
  };
}
