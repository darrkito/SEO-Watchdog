// "Resubmit everything" for one site: Search Console sitemap, Bing sitemap, IndexNow for every sitemap URL. Each step reports on its own.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Site } from './db.ts';
import { submitSitemap } from './gsc.ts';
import { cfgOf } from './agents/scheduler.ts';

// ponytail: assumes /sitemap.xml; the crawl does not store which sitemap URL it found.
export async function resubmit(db: DatabaseSync, site: Site): Promise<string[]> {
  const origin = new URL(site.url).origin, sitemap = `${origin}/sitemap.xml`;
  const step = async (name: string, f: () => Promise<string>) => { try { return `${name}: ${await f()}`; } catch (e) { return `${name} FAILED: ${(e as Error).message}`; } };
  return Promise.all([
    step('Google sitemap', async () => {
      if (!site.gsc_key || !site.gsc_property) throw new Error('no Search Console key linked (Competitors tab)');
      await submitSitemap(site.gsc_key, site.gsc_property, sitemap); return 'resubmitted';
    }),
    step('Bing sitemap', async () => {
      const key = process.env.BING_WEBMASTER_API_KEY;
      if (!key) throw new Error('BING_WEBMASTER_API_KEY is not set');
      const r = await fetch(`https://ssl.bing.com/webmaster/api.svc/json/SubmitFeed?apikey=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, signal: AbortSignal.timeout(30_000), body: JSON.stringify({ siteUrl: origin, feedUrl: sitemap }) });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${((await r.json().catch(() => ({}))) as any).Message ?? ''}`.trim());
      return 'resubmitted';
    }),
    step('IndexNow', async () => {
      const cfg = cfgOf(site);
      if (!cfg?.indexnowKey) throw new Error('no IndexNow key file configured for this site');
      const urls = (db.prepare('SELECT url FROM pages WHERE site_id = ? AND in_sitemap = 1 LIMIT 10000').all(site.id) as { url: string }[]).map((r) => r.url);
      if (!urls.length) throw new Error('no sitemap URLs known yet, run "Check now" first');
      const key = readFileSync(join(cfg.worktree, cfg.indexnowKey), 'utf8').trim();
      const r = await fetch('https://api.indexnow.org/indexnow', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, signal: AbortSignal.timeout(30_000), body: JSON.stringify({ host: new URL(origin).host, key, keyLocation: `${cfg.liveBase}/${key}.txt`, urlList: urls }) });
      if (!r.ok && r.status !== 202) throw new Error(`HTTP ${r.status}`);
      return `${urls.length} URLs sent`;
    }),
  ]);
}
