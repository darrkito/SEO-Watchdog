// Findings from extracted state. Pure functions; every rule cites the playbook lesson it encodes.
import { hostKey } from './vendor/claude-seo-ai/urlnorm.mjs';
import { norm, textKey, type Extract } from './extract.ts';

export type Severity = 'critical' | 'warn' | 'info';
export type Finding = { rule: string; severity: Severity; subject: string; message: string; evidence?: unknown; ref?: string };
export type CrawledPage = { ex: Extract; inSitemap: boolean };

const DOUBLE_LANG = /^\/([a-z]{2}(?:-[a-z]{2})?)\/\1(\/|$)/i;
const SOFT_404 = /\b404\b|not found|no encontrad|no existe/i;

export const isIndexable = (ex: Extract) =>
  ex.status === 200 && ex.is_html && !ex.noindex && (!ex.canonical || norm(ex.canonical) === norm(ex.final_url));

const path = (u: string) => { try { return new URL(u).pathname; } catch { return ''; } };

export function pageRules({ ex, inSitemap }: CrawledPage, market: string[] = []): Finding[] {
  const out: Finding[] = [];
  const f = (rule: string, severity: Severity, message: string, evidence?: unknown, ref?: string) =>
    out.push({ rule, severity, subject: ex.url, message, evidence, ref });
  const where = inSitemap ? 'listed in sitemap' : 'linked internally';

  if (ex.timed_out) { f('fetch.timeout', 'critical', `Route hangs: no response (${where})`, ex.error, 'seo-watchdog: Luvory loader-redirect hang'); return out; }
  if (ex.redirect_loop) { f('redirect.loop', 'critical', 'Redirect loop', ex.error, 'seo §25'); return out; }
  if (ex.status === 0) { f('fetch.error', 'critical', `Fetch failed: ${ex.error}`); return out; }
  if (ex.status >= 500) { f('status.5xx', 'critical', `HTTP ${ex.status} (${where})`); return out; }
  if (ex.status >= 400) { f('status.4xx', inSitemap ? 'critical' : 'warn', `HTTP ${ex.status} (${where})`); return out; }

  if (ex.redirect_hops > 1) f('redirect.chain', 'warn', `${ex.redirect_hops}-hop redirect chain to ${ex.final_url}`);
  else if (ex.redirect_hops === 1) f(inSitemap ? 'sitemap.redirect' : 'link.redirect', inSitemap ? 'warn' : 'info',
    `${inSitemap ? 'Sitemap lists' : 'Internal link points to'} a redirecting URL → ${ex.final_url}`);
  if (DOUBLE_LANG.test(path(ex.final_url))) f('url.double_lang_prefix', 'critical', `Doubled language prefix in URL: ${path(ex.final_url)}`, null, 'seo §27 (/en/en/)');
  if (!ex.is_html) return out;

  if (ex.noindex && inSitemap) f('indexability.noindex', 'critical', `noindex on a sitemap URL (${ex.robots})`, null, 'seo §18 (fetch-failure → noindex)');
  if (ex.canonical && hostKey(ex.canonical) !== hostKey(ex.final_url))
    f('canonical.cross_host', 'critical', `Canonical points to another host: ${ex.canonical}`, null, 'Dizayn duplicated SITE_URL');
  else if (ex.canonical && inSitemap && norm(ex.canonical) !== norm(ex.final_url))
    f('canonical.elsewhere', 'warn', `Sitemap URL canonicalizes to ${ex.canonical}`);
  if (ex.canonical_count > 1) f('canonical.multiple', 'warn', `${ex.canonical_count} canonical tags`);
  if (ex.og_url && hostKey(ex.og_url) !== hostKey(ex.final_url)) f('og_url.cross_host', 'warn', `og:url points to another host: ${ex.og_url}`);

  if (ex.jsonld_invalid) f('jsonld.invalid', 'critical', `${ex.jsonld_invalid} JSON-LD block(s) fail to parse`, null, 'seo §22');
  if (ex.faq_not_visible.length) f('faq.schema_not_visible', 'warn',
    `${ex.faq_not_visible.length}/${ex.faq_questions.length} FAQ schema questions are not visible on the page`, ex.faq_not_visible, 'geo §6');

  for (const h of ex.hreflang) {
    if (DOUBLE_LANG.test(path(h.href))) f('url.double_lang_prefix', 'critical', `hreflang ${h.lang} has doubled language prefix: ${h.href}`, null, 'seo §27');
    // Country = a 2-letter subtag after the language (skips x-default, es-419, zh-Hant).
    const region = h.lang === 'x-default' ? undefined : h.lang.split('-').slice(1).find((s) => /^[a-z]{2}$/i.test(s))?.toUpperCase();
    if (market.length && region && !market.includes(region))
      f('hreflang.region_vs_market', 'warn', `hreflang="${h.lang}" targets ${region}, outside the site market (${market.join(',')})`, null, 'seo §29');
  }
  if (ex.hreflang.length && !ex.hreflang.some((h) => h.lang === 'x-default')) f('hreflang.no_x_default', 'info', 'hreflang set has no x-default');
  if (!ex.lang) f('html.lang_missing', 'warn', '<html> has no lang attribute', null, 'seo §28');

  if (!ex.title) f('title.missing', 'warn', 'No <title>');
  else if (ex.title.length > 60) f('title.long', 'info', `Title is ${ex.title.length} chars (>60)`, ex.title, 'seo §24');
  if (ex.title_count > 1) f('title.multiple', 'warn', `${ex.title_count} <title> tags`);
  if (!ex.meta_description) f('meta.description_missing', 'warn', 'No meta description');
  if (!ex.h1.length) f('h1.missing', 'warn', 'No H1');
  if (SOFT_404.test(`${ex.title} ${ex.h1.join(' ')}`)) f('soft404', 'warn', 'Returns 200 but looks like an error page', ex.title, 'seo §28');
  if (ex.app_shell_empty) f('render.empty_shell', 'warn', `Raw HTML is an empty app shell (${ex.word_count} words): content only exists after JavaScript`, null, 'Blockchains.click /swap');
  return out;
}

/** Rules that need the whole crawl: duplicates, hreflang pairs, sitemap coverage. Keys are norm()'d URLs. */
export function crossRules(pages: Map<string, CrawledPage>, { hasSitemap }: { hasSitemap: boolean }): Finding[] {
  const out: Finding[] = [];
  const ok = (p?: CrawledPage) => !!p && p.ex.status === 200 && p.ex.is_html;

  const byTitle = new Map<string, string[]>();
  for (const p of pages.values()) if (isIndexable(p.ex) && p.ex.title) {
    const k = textKey(p.ex.title);
    byTitle.set(k, [...(byTitle.get(k) || []), p.ex.url]);
  }
  for (const urls of byTitle.values()) if (urls.length > 1) for (const u of urls)
    out.push({ rule: 'title.duplicate', severity: 'warn', subject: u, message: `Title shared with ${urls.length - 1} other page(s)`, evidence: urls.filter((x) => x !== u), ref: 'geo §9 (cannibalization)' });

  for (const [key, p] of pages) {
    if (!ok(p)) continue;
    for (const h of p.ex.hreflang) {
      const tk = norm(h.href);
      if (!tk || tk === key || h.lang === 'x-default') continue;
      const t = pages.get(tk);
      if (!t) continue;
      if (!ok(t) || t.ex.redirect_hops > 0) {
        out.push({ rule: 'hreflang.target_broken', severity: 'warn', subject: p.ex.url, message: `hreflang ${h.lang} → ${h.href} returns ${t.ex.status}${t.ex.redirect_hops ? ' via redirect' : ''}` });
        continue;
      }
      if (!t.ex.hreflang.some((b) => norm(b.href) === key))
        out.push({ rule: 'hreflang.not_reciprocal', severity: 'warn', subject: t.ex.url, message: `No return hreflang to ${p.ex.url}` });
      for (const type of ['FAQPage', 'Product', 'Article', 'BlogPosting'])
        if (p.ex.jsonld_types.includes(type) && !t.ex.jsonld_types.includes(type))
          out.push({ rule: 'schema.missing_in_alternate', severity: 'warn', subject: t.ex.url, message: `${type} schema present on ${h.lang === t.ex.lang ? 'its' : 'the'} alternate ${p.ex.url} but missing here`, ref: 'geo §6 (language-swap drops schema)' });
    }
  }

  if (hasSitemap) for (const p of pages.values()) if (!p.inSitemap && isIndexable(p.ex))
    out.push({ rule: 'sitemap.missing_indexable', severity: 'warn', subject: p.ex.url, message: 'Indexable page reachable by links but not in the sitemap', ref: 'seo §18 (Blockchains.click)' });
  return dedupe(out);
}

export type SiteState = {
  robotsMode: 'parsed' | 'allow-all' | 'disallow-all';
  robotsReason: string | null;
  googleAllowed: boolean;
  sitemapFound: number;
  sslDaysLeft: number | null;
  sslError: string | null;
  domainDaysLeft: number | null;
};

export function siteRules(s: SiteState): Finding[] {
  const out: Finding[] = [];
  const f = (rule: string, severity: Severity, message: string) => out.push({ rule, severity, subject: '', message });
  if (s.robotsMode === 'disallow-all') f('robots.unavailable', 'critical', `robots.txt: ${s.robotsReason}`);
  else if (!s.googleAllowed) f('robots.blocks_google', 'critical', 'robots.txt disallows Googlebot from /');
  if (!s.sitemapFound) f('sitemap.missing', 'warn', 'No sitemap found (robots.txt Sitemap: lines or well-known paths)');
  if (s.sslError) f('ssl.error', 'critical', `TLS check failed: ${s.sslError}`);
  else if (s.sslDaysLeft != null && s.sslDaysLeft < 21) f('ssl.expiring', 'critical', `TLS certificate expires in ${s.sslDaysLeft} days`);
  if (s.domainDaysLeft != null && s.domainDaysLeft < 30) f('domain.expiring', 'critical', `Domain registration expires in ${s.domainDaysLeft} days`);
  return out;
}

/**
 * Guardrail (seo §18): a crawl where many previously-fine pages fail at once is more often the crawler,
 * network or a deploy blip than the site. Hold findings for one run; a second bad run in a row is believed.
 */
export function isSuspect(prevOk: Set<string>, cur: Map<string, number>, prevWasSuspect: boolean,
  sitemap: { prev: number; cur: number } = { prev: 0, cur: 0 }): boolean {
  if (prevWasSuspect) return false;
  // A down site usually takes its sitemap with it, so the page comparison below has nothing to compare.
  if (sitemap.prev >= 5 && sitemap.cur < sitemap.prev * 0.5) return true;
  const compared = [...prevOk].filter((u) => cur.has(u));
  const failed = compared.filter((u) => { const s = cur.get(u)!; return s === 0 || s >= 400; });
  if (compared.length >= 5) return failed.length / compared.length >= 0.3;
  const all = [...cur.values()];
  return prevOk.size === 0 && all.length >= 5 && all.filter((s) => s === 0 || s >= 400).length / all.length >= 0.5;
}

function dedupe(fs: Finding[]): Finding[] {
  const seen = new Set<string>();
  return fs.filter((x) => { const k = `${x.rule}|${x.subject}|${x.message}`; return !seen.has(k) && !!seen.add(k); });
}
