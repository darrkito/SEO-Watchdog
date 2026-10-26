// Deterministic data collection (no LLM): Search Console daily rows, and Bing query stats when BING_WEBMASTER_API_KEY is set.
import type { DatabaseSync } from 'node:sqlite';
import type { Site } from '../db.ts';
import { dailyRows } from '../gsc.ts';

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** First run backfills 90 days; later runs re-pull the last 7 (GSC revises recent days). Returns rows written per source. */
export async function collect(db: DatabaseSync, site: Site): Promise<{ gsc: number; bing: number }> {
  const res = { gsc: 0, bing: 0 };
  const put = db.prepare('INSERT OR REPLACE INTO metrics (site_id, source, date, query, page, clicks, impressions, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  if (site.gsc_key && site.gsc_property) {
    const have = (db.prepare("SELECT COUNT(*) n FROM metrics WHERE site_id = ? AND source = 'gsc'").get(site.id) as { n: number }).n;
    const rows = await dailyRows(site.gsc_key, site.gsc_property, site.url, day(have ? 9 : 92), day(2));
    db.exec('BEGIN');
    try { for (const r of rows) put.run(site.id, 'gsc', r.date, r.query, r.page, r.clicks, r.impressions, r.position); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.gsc = rows.length;
  }
  const key = process.env.BING_WEBMASTER_API_KEY;
  if (key) {
    const rows = await bingQueryStats(key, site.url);
    db.exec('BEGIN');
    try { for (const r of rows) put.run(site.id, 'bing', r.date, r.query, '', r.clicks, r.impressions, r.position); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.bing = rows.length;
  }
  return res;
}

/** Bing Webmaster API: weekly query stats. Dates arrive as "/Date(ms)/". */
export async function bingQueryStats(apiKey: string, siteUrl: string): Promise<{ date: string; query: string; clicks: number; impressions: number; position: number }[]> {
  const r = await fetch(`https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?apikey=${encodeURIComponent(apiKey)}&siteUrl=${encodeURIComponent(siteUrl)}`);
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !Array.isArray(j.d)) throw new Error(`Bing Webmaster: HTTP ${r.status} ${j.Message ?? j.error ?? ''}`.trim());
  return j.d.map((x: any) => ({
    date: new Date(Number(String(x.Date).match(/\d+/)?.[0] ?? 0)).toISOString().slice(0, 10), query: String(x.Query),
    clicks: x.Clicks ?? 0, impressions: x.Impressions ?? 0, position: x.AvgImpressionPosition ?? 0,
  }));
}
