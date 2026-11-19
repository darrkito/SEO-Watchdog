import type { DatabaseSync } from 'node:sqlite';
import type { Site } from './db.ts';
import { registrableDomain } from './crawl.ts';
import { extractPage } from './extract.ts';
import { brandTerms, isBrandDomain, latestPages, urlKey } from './gaps.ts';
import { UA, type Serp } from './competitors.ts';
import { fetchRaw } from './vendor/claude-seo-ai/fetch.mjs';

export async function collectSerpPages(db: DatabaseSync, site: Site, opts: { log?: (s: string) => void; fetcher?: typeof fetchRaw; max?: number } = {}): Promise<{ fetched: number; skipped: number }> {
  const disc = db.prepare('SELECT at, serp_json FROM discoveries WHERE site_id = ? AND serp_json IS NOT NULL ORDER BY id DESC LIMIT 1').get(site.id) as { at: string; serp_json: string } | undefined;
  if (!disc) return { fetched: 0, skipped: 0 };
  const own = registrableDomain(new URL(site.url).hostname);
  const brands = brandTerms(db, site.id);
  const candidates = db.prepare("SELECT domain, competitor_site_id, status FROM competitor_candidates WHERE site_id = ? AND status IN ('active','pinned','user_added','suggested')").all(site.id) as { domain: string; competitor_site_id: number | null; status: string }[];
  const domains = new Set(candidates.map((c) => registrableDomain(c.domain)).filter((d) => d !== own && !isBrandDomain(d, brands)));
  const crawled = new Set(candidates.filter((c) => c.competitor_site_id != null && c.status !== 'suggested').flatMap((c) => latestPages(db, c.competitor_site_id!).map((p) => p.key)));
  const recent = new Set((db.prepare("SELECT url FROM serp_pages WHERE site_id = ? AND fetched_at > datetime('now', '-7 days')").all(site.id) as { url: string }[]).map((r) => urlKey(r.url)));
  const seen = new Set<string>();
  const queue: { url: string; normalized: string; domain: string }[] = [];
  let skipped = 0, fetched = 0;
  for (const s of Object.values(JSON.parse(disc.serp_json) as Serp)) {
    const mine = s.organic.find((o) => o.domain === own && o.rank <= 10);
    for (const o of s.organic.slice(0, 5)) {
      if (mine && o.rank >= mine.rank) continue;
      let u: URL;
      try { u = new URL(o.url); } catch { continue; }
      const domain = registrableDomain(u.hostname);
      if (!domains.has(domain)) continue;
      u.hash = ''; u.search = '';
      const normalized = u.href, key = urlKey(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      if (crawled.has(key) || recent.has(key)) { skipped++; continue; }
      if (queue.length < (opts.max ?? 25)) queue.push({ url: o.url, normalized, domain });
    }
  }
  const save = db.prepare("INSERT INTO serp_pages (site_id, url, domain, extract_json) VALUES (?, ?, ?, ?) ON CONFLICT(site_id,url) DO UPDATE SET extract_json = excluded.extract_json, fetched_at = datetime('now')");
  for (const item of queue) {
    try {
      opts.log?.(`Fetching SERP page: ${item.url}`);
      const result = await (opts.fetcher ?? fetchRaw)(item.url, { ua: UA, timeoutMs: 20_000, retries: 0 });
      const ex = extractPage(result);
      if (ex.status !== 200 || !ex.is_html) { skipped++; continue; }
      save.run(site.id, item.normalized, item.domain, JSON.stringify(ex));
      fetched++;
    } catch (e) { skipped++; opts.log?.(`SERP page failed: ${item.url}: ${(e as Error).message}`); }
  }
  return { fetched, skipped };
}
