// One watchdog run for one site: fetch → extract → snapshot → diff → findings.
import { connect } from 'node:tls';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fetchRaw } from './vendor/claude-seo-ai/fetch.mjs';
import { robotsFromFetch, isAllowed } from './vendor/claude-seo-ai/robots.mjs';
import { discoverSitemaps } from './vendor/claude-seo-ai/sitemaps.mjs';
import { BOTS } from './vendor/claude-seo-ai/bots.mjs';
import { hostKey } from './vendor/claude-seo-ai/urlnorm.mjs';
import { extractPage, norm, type Extract } from './extract.ts';
import { pageRules, crossRules, siteRules, isSuspect, type Finding, type CrawledPage } from './rules.ts';
import { diffPage } from './diff.ts';
import { DATA_DIR, type Site } from './db.ts';

const UA = `Mozilla/5.0 (compatible; SEOWatchdog/0.1${process.env.WATCHDOG_CONTACT ? '; +' + process.env.WATCHDOG_CONTACT : ''})`;
const TIMEOUT_MS = Number(process.env.WATCHDOG_TIMEOUT_MS) || 20_000;
const SEV = { info: 0, warn: 1, critical: 2 } as const;
const TRACKED_BOTS = BOTS.filter((b: any) => ['search', 'retrieval', 'user'].includes(b.class)).map((b: any) => b.name as string);

export type RunSummary = {
  runId: number; site: Site; status: 'ok' | 'suspect'; pages: number; truncated: boolean; events: number;
  newFindings: Finding[]; resolved: { rule_id: string; subject: string }[]; open: Record<string, number>; seconds: number;
};

export async function runSite(db: DatabaseSync, site: Site, { concurrency = 2, log = (_: string) => {} } = {}): Promise<RunSummary> {
  const t0 = Date.now();
  const prevRun = db.prepare("SELECT id, status FROM runs WHERE site_id = ? AND status != 'running' ORDER BY id DESC LIMIT 1").get(site.id) as { id: number; status: string } | undefined;
  const runId = Number(db.prepare('INSERT INTO runs (site_id) VALUES (?)').run(site.id).lastInsertRowid);
  const own = site.kind === 'own';
  // Own sites are fetched as Googlebot: frameworks serve bots differently (Next.js streams <title> to
  // unknown UAs; found live on Blockchains.click), and what Google gets is what we're auditing.
  const ua = site.ua || (own ? 'googlebot' : UA);
  const get = (url: string, o: Record<string, unknown> = {}) => fetchRaw(url, { ua, timeoutMs: TIMEOUT_MS, retries: 1, ...o });

  // --- site level ---
  const home = await get(site.url);
  const origin = new URL(home.final_url || site.url).origin;
  const host = new URL(origin).hostname;
  const robotsRes = await get(origin + '/robots.txt', { accept: 'text/plain,*/*' });
  const robots = robotsFromFetch(robotsRes);
  const robotsText: string = robots.mode === 'parsed' ? robotsRes.body.text : '';
  const botAccess = Object.fromEntries(TRACKED_BOTS.map((b) => [b, isAllowed(robots, b, '/').allowed]));
  log(`robots: ${robots.mode}; sitemaps…`);
  const sm = await discoverSitemaps(origin, robots, (u: string, o: object) => get(u, o), { maxUrls: 50_000 });
  const sitemap = new Map<string, string>();
  for (const u of sm.urls) { const k = norm(u.loc); if (k && hostKey(k) === hostKey(origin)) sitemap.set(k, u.loc); }
  const https = origin.startsWith('https:');
  const [ssl, domainDaysLeft] = https ? await Promise.all([sslCheck(host), domainExpiry(host)]) : [{ error: 'not https' } as Tls, null];

  // --- crawl: homepage + sitemap, then internal links, up to page_limit ---
  const crawlToken = own ? 'Googlebot' : 'SEOWatchdog';
  const queue = [site.url, ...sitemap.values()];
  const seen = new Set(queue.map((u) => norm(u)!));
  const pages = new Map<string, CrawledPage>();
  const htmlHash = new Map<string, string>();
  let truncated = seen.size > site.page_limit;
  queue.length = Math.min(queue.length, site.page_limit);
  let i = 0;
  const worker = async () => {
    while (i < queue.length) {
      const url = queue[i++];
      if (url !== site.url && !isAllowed(robots, crawlToken, url).allowed) continue;
      const f = url === site.url ? home : await get(url);
      const ex = extractPage(f);
      const key = norm(url)!;
      pages.set(key, { ex, inSitemap: sitemap.has(key) });
      if (ex.is_html && f.body.sha256) { saveHtml(f.body.sha256, f.body.text); htmlHash.set(key, f.body.sha256); }
      for (const l of ex.links) {
        const k = norm(l)!;
        if (seen.has(k)) continue;
        if (seen.size >= site.page_limit) { truncated = true; break; }
        seen.add(k); queue.push(l);
      }
      if (pages.size % 25 === 0) log(`${pages.size}/${queue.length} pages`);
      if (!own) await new Promise((r) => setTimeout(r, 500)); // politeness on sites we don't own
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  // --- persist snapshots + page events ---
  const prevOk = new Set<string>(), curStatus = new Map<string, number>();
  let events = 0;
  const addEvent = db.prepare('INSERT INTO events (site_id, run_id, subject, type, field, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const ev = (subject: string, type: string, field: string | null = null, before: string | null = null, after: string | null = null) => {
    addEvent.run(site.id, runId, subject, type, field, before, after); events++;
  };
  const firstRun = !prevRun;
  db.exec('BEGIN');
  try {
  for (const [key, p] of pages) {
    const url = p.ex.url;
    const existing = db.prepare('SELECT id, in_sitemap FROM pages WHERE site_id = ? AND url = ?').get(site.id, url) as { id: number; in_sitemap: number } | undefined;
    const pageId = existing?.id ?? Number(db.prepare('INSERT INTO pages (site_id, url) VALUES (?, ?)').run(site.id, url).lastInsertRowid);
    db.prepare("UPDATE pages SET last_seen = datetime('now'), in_sitemap = ? WHERE id = ?").run(p.inSitemap ? 1 : 0, pageId);
    const prev = db.prepare('SELECT extract_json FROM snapshots WHERE page_id = ? ORDER BY run_id DESC LIMIT 1').get(pageId) as { extract_json: string } | undefined;
    db.prepare('INSERT INTO snapshots (page_id, run_id, status, html_hash, extract_json) VALUES (?, ?, ?, ?, ?)')
      .run(pageId, runId, p.ex.status, htmlHash.get(key) ?? null, JSON.stringify(p.ex));
    curStatus.set(url, p.ex.status);
    if (prev) {
      const before = JSON.parse(prev.extract_json) as Extract;
      if (before.status >= 200 && before.status < 400) prevOk.add(url);
      for (const c of diffPage(before, p.ex)) ev(url, 'page.change', c.field, c.before, c.after);
    } else if (!firstRun) ev(url, 'page.new');
    if (existing && !firstRun && !!existing.in_sitemap !== p.inSitemap) ev(url, p.inSitemap ? 'sitemap.added' : 'sitemap.removed');
  }
  if (prevRun && !truncated) {
    const gone = db.prepare('SELECT p.url FROM snapshots s JOIN pages p ON p.id = s.page_id WHERE s.run_id = ?').all(prevRun.id) as { url: string }[];
    for (const { url } of gone) if (!curStatus.has(url)) ev(url, 'page.gone');
  }

  // --- site snapshots + site events ---
  const siteData: Record<string, unknown> = {
    robots: { mode: robots.mode, reason: robots.reason, text: robotsText.slice(0, 20_000), botAccess },
    sitemap: { found: sm.found, urls: sitemap.size, files: sm.files.map((f: any) => ({ url: f.url, status: f.status, kind: f.kind, url_count: f.url_count })) },
    tls: ssl, domain: { daysLeft: domainDaysLeft },
  };
  for (const [kind, data] of Object.entries(siteData)) {
    const prev = prevRun && db.prepare('SELECT data_json FROM site_snapshots WHERE run_id = ? AND kind = ?').get(prevRun.id, kind) as { data_json: string } | undefined;
    db.prepare('INSERT INTO site_snapshots (site_id, run_id, kind, data_json) VALUES (?, ?, ?, ?)').run(site.id, runId, kind, JSON.stringify(data));
    if (!prev) continue;
    const b = JSON.parse(prev.data_json);
    if (kind === 'robots') {
      if (b.text !== (data as any).text) ev('', 'robots.changed', 'robots.txt', b.text, (data as any).text);
      for (const bot of TRACKED_BOTS) if (b.botAccess?.[bot] !== undefined && b.botAccess[bot] !== botAccess[bot])
        ev('', 'robots.bot_access', bot, b.botAccess[bot] ? 'allowed' : 'blocked', botAccess[bot] ? 'allowed' : 'blocked');
    }
    if (kind === 'sitemap' && b.urls !== sitemap.size) ev('', 'sitemap.count', null, String(b.urls), String(sitemap.size));
  }

  // --- findings (own sites only; competitors are watched for changes, not audited) ---
  const prevSitemap = prevRun ? JSON.parse((db.prepare("SELECT data_json FROM site_snapshots WHERE run_id = ? AND kind = 'sitemap'").get(prevRun.id) as { data_json: string } | undefined)?.data_json ?? '{}').urls ?? 0 : 0;
  const status = isSuspect(prevOk, curStatus, prevRun?.status === 'suspect', { prev: prevSitemap, cur: sitemap.size }) ? 'suspect' : 'ok';
  const newFindings: Finding[] = [], resolved: { rule_id: string; subject: string }[] = [];
  if (own && status === 'ok') {
    const all = [
      ...siteRules({ robotsMode: robots.mode, robotsReason: robots.reason, googleAllowed: botAccess.Googlebot !== false, sitemapFound: sm.found,
        sslDaysLeft: 'daysLeft' in ssl ? ssl.daysLeft : null, sslError: https && 'error' in ssl ? ssl.error : null, domainDaysLeft }),
      ...[...pages.values()].flatMap((p) => pageRules(p, site.market ? site.market.split(',') : [])),
      ...crossRules(pages, { hasSitemap: sm.found > 0 }),
    ];
    for (const f of merge(all)) {
      const row = db.prepare('SELECT id, status FROM findings WHERE site_id = ? AND rule_id = ? AND subject = ?').get(site.id, f.rule, f.subject) as { id: number; status: string } | undefined;
      const args = [f.severity, f.message, JSON.stringify(f.evidence ?? null), f.ref ?? null, runId];
      if (!row) {
        db.prepare('INSERT INTO findings (severity, message, evidence_json, ref, last_run_id, site_id, rule_id, subject) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(...args, site.id, f.rule, f.subject);
        newFindings.push(f);
      } else {
        const reopen = row.status === 'resolved';
        db.prepare(`UPDATE findings SET severity = ?, message = ?, evidence_json = ?, ref = ?, last_run_id = ?, last_seen = datetime('now')${reopen ? ", status = 'open', first_seen = datetime('now')" : ''} WHERE id = ?`).run(...args, row.id);
        if (reopen) newFindings.push(f);
      }
    }
    // Resolve only what this run actually re-checked.
    const stale = db.prepare("SELECT id, rule_id, subject FROM findings WHERE site_id = ? AND status = 'open' AND last_run_id != ?").all(site.id, runId) as { id: number; rule_id: string; subject: string }[];
    for (const s of stale) if (s.subject === '' || curStatus.has(s.subject)) {
      db.prepare("UPDATE findings SET status = 'resolved' WHERE id = ?").run(s.id);
      resolved.push(s);
    }
  }
  const open = Object.fromEntries((db.prepare("SELECT severity, COUNT(*) n FROM findings WHERE site_id = ? AND status = 'open' GROUP BY severity").all(site.id) as { severity: string; n: number }[]).map((r) => [r.severity, r.n]));
  const seconds = Math.round((Date.now() - t0) / 1000);
  db.prepare("UPDATE runs SET finished_at = datetime('now'), status = ?, stats_json = ? WHERE id = ?")
    .run(status, JSON.stringify({ pages: pages.size, sitemap_urls: sitemap.size, truncated, events, new_findings: newFindings.length, resolved: resolved.length, seconds }), runId);
  db.exec('COMMIT');
  return { runId, site, status, pages: pages.size, truncated, events, newFindings, resolved, open, seconds };
  } catch (e) {
    db.exec('ROLLBACK');
    db.prepare("UPDATE runs SET finished_at = datetime('now'), status = 'failed', stats_json = ? WHERE id = ?").run(JSON.stringify({ error: String(e) }), runId);
    throw e;
  }
}

/** One finding per (rule, subject): highest severity, messages joined. */
function merge(fs: Finding[]): Finding[] {
  const m = new Map<string, Finding>();
  for (const f of fs) {
    const k = `${f.rule}|${f.subject}`, cur = m.get(k);
    if (!cur) { m.set(k, { ...f }); continue; }
    if (SEV[f.severity] > SEV[cur.severity]) cur.severity = f.severity;
    if (!cur.message.includes(f.message)) cur.message += '; ' + f.message;
  }
  return [...m.values()];
}

function saveHtml(sha: string | null, html: string) {
  if (!sha) return;
  const dir = join(DATA_DIR, 'html');
  const file = join(dir, sha + '.gz');
  if (existsSync(file)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, gzipSync(html));
}

type Tls = { daysLeft: number; validTo: string; issuer: string } | { error: string };
function sslCheck(host: string): Promise<Tls> {
  return new Promise((resolve) => {
    const s = connect({ host, port: 443, servername: host, timeout: 10_000 }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve({ daysLeft: Math.floor((Date.parse(c.valid_to) - Date.now()) / 86_400_000), validTo: c.valid_to, issuer: c.issuer?.O ?? '' });
    });
    s.on('error', (e) => resolve({ error: e.message }));
    s.on('timeout', () => { s.destroy(); resolve({ error: 'timeout' }); });
  });
}

// ponytail: 2-label registrable domain + common second-level ccTLDs (com.mx); swap for a PSL lib if a TLD misparses.
export function registrableDomain(host: string): string {
  const l = host.toLowerCase().replace(/^www\./, '').split('.');
  const sld = l.length >= 3 && l.at(-1)!.length === 2 && ['com', 'org', 'net', 'gob', 'edu', 'co', 'ac', 'gov'].includes(l.at(-2)!);
  return l.slice(sld ? -3 : -2).join('.');
}

/** Days until registration expiry via RDAP; null when the registry has no RDAP (e.g. some ccTLDs). */
async function domainExpiry(host: string): Promise<number | null> {
  const r = await fetchRaw('https://rdap.org/domain/' + registrableDomain(host), { ua: UA, accept: 'application/rdap+json', timeoutMs: 10_000, retries: 0 });
  try {
    const exp = JSON.parse(r.body.text).events?.find((e: any) => e.eventAction === 'expiration')?.eventDate;
    return exp ? Math.floor((Date.parse(exp) - Date.now()) / 86_400_000) : null;
  } catch { return null; }
}
