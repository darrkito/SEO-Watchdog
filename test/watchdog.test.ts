// "Would it have caught it?" — each case replays a real bug from our sites' history (PLAN.md §6).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'wd-test-'));
process.env.WATCHDOG_DATA = dataDir;
process.env.WATCHDOG_TIMEOUT_MS = '800';
const { extractPage } = await import('../src/extract.ts');
const { pageRules, crossRules, isSuspect } = await import('../src/rules.ts');
const { diffPage } = await import('../src/diff.ts');
const { openDb } = await import('../src/db.ts');
const { runSite, registrableDomain } = await import('../src/crawl.ts');

const page = (url: string, html: string, status = 200, headers: Record<string, string> = {}) =>
  extractPage({ url, final_url: url, status, error: null, headers: { 'content-type': 'text/html', ...headers }, status_chain: [], redirects: { hops: 0, loop: false }, body: { text: html } });
const html = (head: string, body: string, lang = 'es') =>
  `<!doctype html><html lang="${lang}"><head><title>Renta de sanitarios portátiles</title><meta name="description" content="d">${head}</head><body><main><h1>H</h1>${body}</main></body></html>`;
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const faq = (qs: string[]) => ld({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: qs.map((q) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: 'a' } })) });
const rules = (ex: ReturnType<typeof page>, inSitemap = true, market: string[] = []) => pageRules({ ex, inSitemap }, market).map((f) => f.rule);

test('#2/#6 FAQ schema sourced from a different array than the visible FAQ (Luvory, Blockchains.click)', () => {
  const ex = page('https://a.mx/p', html(faq(['¿Cuánto cuesta rentar?', '¿Qué incluye?']), '<details><summary>¿Cuánto cuesta rentar?</summary></details>'));
  assert.deepEqual(ex.faq_not_visible, ['¿Qué incluye?']);
  assert.ok(rules(ex).includes('faq.schema_not_visible'));
});

test('FAQ match survives HTML entity encoding (geo §6 apostrophe gotcha)', () => {
  const ex = page('https://a.com/p', html(faq(["What's included?"]), '<h2>What&#x27;s included?</h2>'));
  assert.deepEqual(ex.faq_not_visible, []);
});

test('#3 language swap drops FAQ schema on the EN alternate (Luvory)', () => {
  const alt = (self: string, other: string) => `<link rel="alternate" hreflang="es" href="https://a.mx/${self === 'es' ? 'p' : 'en/p'}"><link rel="alternate" hreflang="en" href="https://a.mx/${self === 'es' ? 'en/p' : 'p'}">`;
  const es = page('https://a.mx/p', html(alt('es', 'en') + faq(['¿Q?']), '<p>¿Q?</p>'));
  const en = page('https://a.mx/en/p', html(alt('en', 'es'), '<p>x</p>', 'en'));
  const f = crossRules(new Map([['https://a.mx/p', { ex: es, inSitemap: true }], ['https://a.mx/en/p', { ex: en, inSitemap: true }]]), { hasSitemap: true });
  assert.ok(f.some((x) => x.rule === 'schema.missing_in_alternate' && x.subject === 'https://a.mx/en/p'));
});

test('#4 noindex on a sitemap URL, meta or X-Robots-Tag (Blockchains.click generateMetadata)', () => {
  assert.ok(rules(page('https://a.com/n', html('<meta name="robots" content="noindex, follow">', ''))).includes('indexability.noindex'));
  assert.ok(rules(page('https://a.com/n', html('', ''), 200, { 'x-robots-tag': 'noindex' })).includes('indexability.noindex'));
  assert.ok(!rules(page('https://a.com/n', html('<meta name="robots" content="index,follow">', ''))).includes('indexability.noindex'));
});

test('#5 SSR content missing: raw HTML is an empty app shell (Blockchains.click /swap)', () => {
  const ex = page('https://a.com/swap', '<html lang="en"><head><title>Swap</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  assert.ok(rules(ex).includes('render.empty_shell'));
});

test('#8 canonical / og:url pointing at another host (Dizayn duplicated SITE_URL)', () => {
  const r = rules(page('https://dizayn.mx/a', html('<link rel="canonical" href="https://old-preview.vercel.app/a"><meta property="og:url" content="https://old-preview.vercel.app/a">', '')));
  assert.ok(r.includes('canonical.cross_host') && r.includes('og_url.cross_host'));
  assert.ok(!rules(page('https://dizayn.mx/a', html('<link rel="canonical" href="https://www.dizayn.mx/a">', ''))).includes('canonical.cross_host'));
});

test('#9 hreflang region outside the site market (Yume en-US on a Mexico-only shop)', () => {
  const ex = page('https://y.mx/', html('<link rel="alternate" hreflang="en-us" href="https://y.mx/en"><link rel="alternate" hreflang="es-mx" href="https://y.mx/">', ''));
  assert.ok(rules(ex, true, ['MX']).includes('hreflang.region_vs_market'));
  assert.ok(!rules(ex, true, ['MX', 'US']).includes('hreflang.region_vs_market'));
  assert.ok(!rules(ex, true, []).includes('hreflang.region_vs_market'), 'no market input = no opinion');
  const generic = page('https://l.mx/', html('<link rel="alternate" hreflang="x-default" href="https://l.mx/"><link rel="alternate" hreflang="es-419" href="https://l.mx/"><link rel="alternate" hreflang="zh-hant" href="https://l.mx/zh">', ''));
  assert.ok(!rules(generic, true, ['MX']).includes('hreflang.region_vs_market'), 'x-default / es-419 / scripts are not countries (found live on Luvory)');
});

test('#10 doubled language prefix /en/en/ in URL or hreflang (Luvory)', () => {
  assert.ok(rules(page('https://a.mx/en/en/blog', html('', ''))).includes('url.double_lang_prefix'));
  assert.ok(rules(page('https://a.mx/en/blog', html('<link rel="alternate" hreflang="en" href="https://a.mx/en/en/blog">', ''))).includes('url.double_lang_prefix'));
  assert.ok(!rules(page('https://a.mx/en/entretenimiento', html('', ''))).includes('url.double_lang_prefix'));
});

test('duplicate titles across indexable pages (geo §9 cannibalization)', () => {
  const m = new Map([1, 2].map((n) => [`https://a.mx/${n}`, { ex: page(`https://a.mx/${n}`, html('', '')), inSitemap: true }]));
  assert.equal(crossRules(m, { hasSitemap: true }).filter((f) => f.rule === 'title.duplicate').length, 2);
});

test('diff reports tag changes, but not tag "changes" caused by a failed fetch', () => {
  const a = page('https://a.mx/', html('', '<p>uno</p>'));
  const b = page('https://a.mx/', html('<meta name="robots" content="noindex">', '<p>uno</p>'));
  assert.deepEqual(diffPage(a, b).map((c) => c.field).sort(), ['noindex', 'robots']);
  const down = { ...a, status: 503, is_html: false };
  assert.deepEqual(diffPage(a, down).map((c) => c.field), ['status']);
});

test('content hash ignores section order and live numbers, catches copy rewrites', () => {
  const h = (b: string) => page('https://a.mx/', html('', b)).text_hash;
  assert.equal(h('<p>Renta premium</p><p>Floor 1.25 ETH</p>'), h('<p>Floor 3.10 ETH</p><p>Renta premium</p>'));
  assert.notEqual(h('<p>Renta premium</p>'), h('<p>Renta económica</p>'));
});

test('#12 suspect-run guardrail: mass failure is held once, believed the second time', () => {
  const urls = ['/1', '/2', '/3', '/4', '/5', '/6'];
  const ok = new Set(urls);
  const down = new Map(urls.map((u) => [u, 503]));
  assert.equal(isSuspect(ok, down, false), true);
  assert.equal(isSuspect(ok, down, true), false);
  assert.equal(isSuspect(ok, new Map(urls.map((u, i) => [u, i === 0 ? 404 : 200])), false), false);
  assert.equal(isSuspect(ok, new Map([['/1', 503]]), false, { prev: 40, cur: 0 }), true, 'sitemap collapse = site down');
  assert.equal(isSuspect(ok, new Map([['/1', 200]]), false, { prev: 40, cur: 38 }), false);
});

test('registrable domain for RDAP', () => {
  assert.equal(registrableDomain('www.luvory.com.mx'), 'luvory.com.mx');
  assert.equal(registrableDomain('blog.studioyume.mx'), 'studioyume.mx');
  assert.equal(registrableDomain('blockchains.click'), 'blockchains.click');
});

// --- end-to-end against a local site: #1 route hang, #7 redirect loop, #11 linked-not-in-sitemap, findings lifecycle ---
let server: Server, base = '', mode: 'normal' | 'fixed' | 'down' = 'normal';
before(async () => {
  server = createServer((req, res) => {
    const u = req.url!;
    if (mode === 'down' && u !== '/robots.txt') { res.writeHead(503).end(); return; }
    if (u === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }).end(`User-agent: *\nDisallow: /private\nSitemap: ${base}/sitemap.xml`); return; }
    if (u === '/sitemap.xml') {
      const locs = ['/', '/a', '/b', '/c', '/hang', '/loop-a'].map((p) => `<url><loc>${base}${p}</loc></url>`).join('');
      res.writeHead(200, { 'content-type': 'application/xml' }).end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`);
      return;
    }
    if (u === '/hang') { if (mode === 'fixed') { res.writeHead(200, { 'content-type': 'text/html' }).end(html('', '<p>ok</p>').replace('Renta', 'Hang')); } return; }
    if (u === '/loop-a') { res.writeHead(301, { location: '/loop-b' }).end(); return; }
    if (u === '/loop-b') { res.writeHead(301, { location: '/loop-a' }).end(); return; }
    const title = { '/': 'Home', '/a': 'A', '/b': 'B', '/c': 'C', '/orphan': 'Orphan', '/private': 'P' }[u];
    if (!title) { res.writeHead(404).end(); return; }
    const links = `<a href="/a">a</a>${mode === 'normal' ? '<a href="/orphan">o</a>' : ''}<a href="/private">p</a><a href="/logo.png">i</a>`;
    const robots = u === '/b' && mode === 'normal' ? '<meta name="robots" content="noindex">' : '';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(`<!doctype html><html lang="es"><head><title>${title} page</title><meta name="description" content="d">${robots}</head><body><nav>${links}</nav><main><h1>${title}</h1></main></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.closeAllConnections(); server.close(); rmSync(dataDir, { recursive: true, force: true }); });

test('end-to-end: crawl, findings, resolve, suspect hold', async () => {
  const db = openDb(join(dataDir, 'e2e.db'));
  const id = Number(db.prepare("INSERT INTO sites (url, kind, market, page_limit) VALUES (?, 'own', 'MX', 50)").run(base + '/').lastInsertRowid);
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as any;
  const open = () => (db.prepare("SELECT rule_id || ' ' || subject k FROM findings WHERE status = 'open' ORDER BY k").all() as { k: string }[]).map((r) => r.k);

  const r1 = await runSite(db, site);
  assert.equal(r1.status, 'ok');
  const f1 = open();
  assert.ok(f1.includes(`fetch.timeout ${base}/hang`), '#1 route hang');
  assert.ok(f1.includes(`redirect.loop ${base}/loop-a`), '#7 redirect loop');
  assert.ok(f1.includes(`sitemap.missing_indexable ${base}/orphan`), '#11 linked but not in sitemap');
  assert.ok(f1.includes(`indexability.noindex ${base}/b`));
  assert.ok(!f1.some((k) => k.includes('/private')), 'robots-disallowed URLs are not crawled');
  assert.ok(!f1.some((k) => k.includes('logo.png')), 'assets are not crawled');
  assert.ok(r1.newFindings.some((f) => f.severity === 'critical'));

  mode = 'fixed';
  const r2 = await runSite(db, site);
  const f2 = open();
  assert.ok(!f2.includes(`fetch.timeout ${base}/hang`) && !f2.includes(`indexability.noindex ${base}/b`), 'fixed issues resolve');
  assert.ok(r2.resolved.length >= 2 && r2.newFindings.length === 0);
  assert.ok(!f2.includes(`sitemap.missing_indexable ${base}/orphan`), 'a page that left the site resolves its findings');
  const changes = db.prepare('SELECT field FROM events WHERE run_id = ? AND subject = ?').all(r2.runId, base + '/b') as { field: string }[];
  assert.ok(changes.some((c) => c.field === 'noindex'), 'noindex removal recorded as a change');

  mode = 'down';
  const r3 = await runSite(db, site);
  assert.equal(r3.status, 'suspect');
  assert.deepEqual(open(), f2, 'suspect run neither adds nor resolves findings');
  const r4 = await runSite(db, site);
  assert.equal(r4.status, 'ok', 'second bad run in a row is believed');
  assert.ok(open().some((k) => k.startsWith('status.5xx')));
  assert.ok(open().includes(`redirect.loop ${base}/loop-a`), 'an outage does not mark unreachable pages as fixed');
});

test('competitor discovery: scoring, own/platform/directory split, quote + keyword guards, statuses survive re-discovery', async () => {
  const { discover, deactivate, candidates } = await import('../src/competitors.ts');
  const db = openDb(join(dataDir, 'comp.db'));
  const own = Number(db.prepare("INSERT INTO sites (url, kind, market, gsc_key, gsc_property) VALUES ('https://own.mx/', 'own', 'MX', '/k.json', 'sc-domain:own.mx')").run().lastInsertRowid);
  db.prepare("INSERT INTO runs (site_id, status) VALUES (?, 'ok')").run(own);
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(own) as any;
  const pages: Record<string, string> = { 'rival.mx': 'Renta de baños de lujo para bodas', 'liar.mx': 'Venta de llantas', 'other.mx': 'Sanitarios portátiles para eventos' };
  const deps = {
    topQueries: async () => [{ query: 'renta baños gdl', impressions: 100, clicks: 1, position: 3 }],
    search: async () => ({ places: [], organic: ['https://own.mx/x', 'https://rival.mx/a', 'https://rival.mx/b', 'https://www.bodas.net/x', 'https://facebook.com/x', 'https://liar.mx/', 'https://other.mx/']
      .map((url, i) => ({ url, position: i + 1 })) }),
    fetchRaw: async (url: string) => ({ ok: true, status: 200, final_url: url, headers: { 'content-type': 'text/html' }, body: { text: `<html><body><main><p>${pages[new URL(url).hostname]}</p></main></body></html>` } }),
    askJson: async (_u: any, _sys: string, _prompt: string, schema: any) => schema.required.includes('keywords')
      ? { business_name: 'Own', industry: 'baños', services: ['renta'], city: 'Guadalajara', region: '', country: 'mx', scope: 'national', languages: ['es'], brand_terms: [], evidence: '',
          keywords: [{ query: 'renta baños gdl', lang: 'es', from_gsc: true }, { query: 'invented query', lang: 'es', from_gsc: true }] }
      : { candidates: [
          { domain: 'rival.mx', kind: 'competitor', same_service: true, same_market: 'yes', national: false, reason: 'r', quote: 'baños de lujo' },
          { domain: 'liar.mx', kind: 'competitor', same_service: true, same_market: 'yes', national: false, reason: 'r', quote: 'renta de sanitarios' }, // not on its page
          { domain: 'other.mx', kind: 'competitor', same_service: true, same_market: 'unknown', national: false, reason: 'r', quote: 'portátiles para eventos' }] },
  } as any;

  const r1 = await discover(db, site, undefined, deps);
  assert.deepEqual(r1.profile.keywords.map((k) => k.from_gsc), [true, false], 'a "Search Console" keyword not in the real list is flipped to generated');
  assert.equal(r1.profile.country, 'MX');
  const by = () => Object.fromEntries(candidates(db, own).map((c) => [c.domain, c]));
  let c = by();
  assert.equal(c['own.mx'], undefined, 'own domain excluded');
  assert.equal(c['facebook.com'], undefined, 'platforms dropped');
  assert.equal(c['bodas.net'].status, 'directory');
  assert.equal(c['liar.mx'].status, 'rejected', 'quote not on the page → not a competitor');
  assert.deepEqual([c['rival.mx'].evidence.eligible, c['liar.mx'].evidence.eligible, c['bodas.net'].evidence.eligible], [true, false, false], 'verdict kept so watched rivals can be flagged later');
  assert.equal(c['rival.mx'].evidence.best, 2, 'own site still occupies the #1 slot');
  assert.equal(c['liar.mx'].evidence.best, 5, 'rank among distinct domains: rival.mx second hit does not push others down');
  assert.deepEqual([c['rival.mx'].status, c['other.mx'].status], ['active', 'active'], 'first discovery activates eligible top 3');
  const comp = db.prepare('SELECT * FROM sites WHERE id = ?').get(c['rival.mx'].competitor_site_id) as any;
  assert.deepEqual([comp.kind, comp.parent_site_id], ['competitor', own]);

  db.prepare("UPDATE competitor_candidates SET status = 'pinned' WHERE id = ?").run(c['rival.mx'].id);
  db.prepare("UPDATE competitor_candidates SET status = 'user_added' WHERE id = ?").run(c['liar.mx'].id);
  deactivate(db, site, c['other.mx'].id, true);
  assert.equal(db.prepare('SELECT 1 FROM sites WHERE id = ?').get(c['other.mx'].competitor_site_id), undefined, 'stop watching removes the competitor site');

  const r2 = await discover(db, site, undefined, deps);
  c = by();
  assert.deepEqual([c['rival.mx'].status, c['liar.mx'].status, c['other.mx'].status], ['pinned', 'user_added', 'excluded'], 're-discovery keeps user choices; excluded never re-suggested');
  assert.deepEqual(r2.stats.activated, [], 'later discoveries only propose');
});
