// 0-100 quality score per blog post from the latest crawl (structure, 70 pts) and Search Console (visibility, 30 pts).
// Deterministic and explainable: every point lost comes with a plain reason, which is also what the improver is told to fix.
import type { DatabaseSync } from 'node:sqlite';
import type { Site } from '../db.ts';
import { segmentOf, type Segment } from './audience.ts';

export type BlogRow = { segment: Segment; url: string; slug: string; title: string; score: number; reasons: string[]; words: number; impressions: number; clicks: number; position: number; topQuery: string | null };

export function scorePost(ex: { title: string | null; meta_description: string | null; h1: string[]; word_count: number; faq_questions: string[]; jsonld_types: string[]; links: string[] },
  gsc: { impressions: number; clicks: number; position: number } | null, host: string): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let s = 0;
  const words = Math.min(30, Math.round((ex.word_count / 1500) * 30)); s += words;
  if (ex.word_count < 1000) reasons.push(`solo ${ex.word_count} palabras (meta: 1000 o más)`);
  if (ex.faq_questions.length) s += 15; else reasons.push('sin FAQ visible');
  if (ex.jsonld_types.some((t) => /^(BlogPosting|Article)$/.test(t))) s += 5; else reasons.push('sin schema BlogPosting');
  const tl = (ex.title ?? '').length; if (tl >= 30 && tl <= 65) s += 5; else reasons.push(`title de ${tl} caracteres (ideal 30 a 65)`);
  const dl = (ex.meta_description ?? '').length; if (dl >= 110 && dl <= 160) s += 5; else reasons.push(`meta description de ${dl} caracteres (ideal 110 a 160)`);
  if (ex.h1.length === 1) s += 5; else reasons.push(`${ex.h1.length} H1 (debe haber 1)`);
  const internal = ex.links.filter((l) => { try { return new URL(l).hostname.replace(/^www\./, '') === host; } catch { return false; } }).length;
  if (internal >= 8) s += 5; else reasons.push(`solo ${internal} enlaces internos`);
  if (gsc) { // 30 pts only when Search Console is connected; otherwise the structure score is scaled to 100
    if (gsc.impressions >= 10) s += 10; else reasons.push('casi sin impresiones en Google (90 días)');
    if (gsc.impressions && gsc.position <= 10) s += 10; else if (gsc.impressions && gsc.position <= 20) { s += 5; reasons.push(`posición media ${gsc.position.toFixed(1)} (página 2)`); } else if (gsc.impressions) reasons.push(`posición media ${gsc.position.toFixed(1)}`);
    if (gsc.clicks >= 1) s += 10; else reasons.push('sin clics en 90 días');
    return { score: Math.round(s), reasons };
  }
  return { score: Math.round((s / 70) * 100), reasons };
}

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** Spanish-canonical posts of the site (the improver edits ES + EN together), lowest score first. */
export function blogScores(db: DatabaseSync, site: Site): BlogRow[] {
  const run = (db.prepare("SELECT id FROM runs WHERE site_id = ? AND status = 'ok' ORDER BY id DESC LIMIT 1").get(site.id) as { id: number } | undefined)?.id;
  if (!run) return [];
  const host = new URL(site.url).hostname.replace(/^www\./, '');
  const hasGsc = !!(db.prepare("SELECT 1 FROM metrics WHERE site_id = ? AND source = 'gsc' LIMIT 1").get(site.id));
  const gscFor = db.prepare("SELECT COALESCE(SUM(impressions),0) impressions, COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(position*impressions)/NULLIF(SUM(impressions),0),0) position FROM metrics WHERE site_id = ? AND source = 'gsc' AND date >= ? AND (page = ? OR page = ?)");
  const topQ = db.prepare("SELECT query FROM metrics WHERE site_id = ? AND source = 'gsc' AND date >= ? AND (page = ? OR page = ?) GROUP BY query ORDER BY SUM(impressions) DESC LIMIT 1");
  const rows = db.prepare('SELECT p.url, s.extract_json FROM snapshots s JOIN pages p ON p.id = s.page_id WHERE s.run_id = ? AND s.status = 200').all(run) as { url: string; extract_json: string }[];
  const out: BlogRow[] = [];
  for (const r of rows) {
    const m = new URL(r.url).pathname.match(/^\/blog\/([^/]+)\/?$/);
    if (!m) continue;
    const ex = JSON.parse(r.extract_json), noSlash = r.url.replace(/\/$/, '');
    const g = hasGsc ? (gscFor.get(site.id, day(90), noSlash, noSlash + '/') as { impressions: number; clicks: number; position: number }) : null;
    const { score, reasons } = scorePost(ex, g, host);
    out.push({ segment: segmentOf(`${m[1].replace(/-/g, ' ')} ${ex.h1?.[0] ?? ''}`), url: r.url, slug: m[1], title: ex.h1?.[0] ?? ex.title ?? m[1], score, reasons, words: ex.word_count, impressions: g?.impressions ?? 0, clicks: g?.clicks ?? 0, position: Math.round((g?.position ?? 0) * 10) / 10,
      topQuery: (topQ.get(site.id, day(90), noSlash, noSlash + '/') as { query: string } | undefined)?.query ?? null });
  }
  return out.sort((a, b) => a.score - b.score);
}
