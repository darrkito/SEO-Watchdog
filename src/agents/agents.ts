import { systemPrompt, EFFORT, MODEL, type Role } from './templates/roles.ts';
import type { Stage } from './jobs.ts';
// The fleet. Each agent = deterministic prep (SQL/git) + one `claude -p` call on the subscription + deterministic checks.
// Nothing here pushes to production without passing typecheck, a path allowlist, and (unless autonomy=auto and low risk) a human approval.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import type { Site } from '../db.ts';
import { runSite } from '../crawl.ts';
import { alertText, sendAlert } from '../alert.ts';
import { battle } from '../gaps.ts';
import { collect } from './collect.ts';
import { blogScores } from './blogscore.ts';
import { audienceBrief, customerQuestions, seoPlaybook, segmentOf, TARGET } from './audience.ts';
import { runClaude, runCodex, extractJson, type ClaudeResult, type CodexResult } from './runner.ts';
import { AGENT_SITES, pathAllowed, type AgentSite } from './sites.ts';
import type { PostOpts } from './hooks.ts';
import { checkAnswerBlocks, checkDuplicateSentences, checkInternalLinks, nonProblem } from './accept.ts';
import { runHybrid, HybridLimit, type HybridDeps, type Review } from './hybrid.ts';
import { researchPrompt, planPrompt, slimPlanPrompt, reviewPrompt, scoutPrompt, fixerPlanPrompt, linksSection, type PlanInput } from './prompts.ts';
import { locatePost, currentOf, exampleOf } from './locate.ts';
import { insertPointsFor } from './insertpoints.ts';
import { extractTypeDecls } from './typedefs.ts';
import { stripOrderDerived } from './orders.ts';
import { verifyQuery, scoreTopic, evidenceLine, makeBudget, bingKeyword, setDemandEvidence, researchFunnel, buildDemandPool, clusterQueries, headTerms, trendsFor, minTopicScore, trendForCluster, takenSlugs, acceptPicks, topicDropReason, recordTopicCandidate, droppedSummary, type ScoredCandidate } from './topicdata.ts';

/** Code-verified twin link for the reviewer: the model only sees a -U3 diff and cannot see the `"en": "<slug>"` line above the twin's slug. */
export function twinFacts(cfg: { twin?: { file: string; key: string } }, wt: string, slug: string): string[] {
  if (!cfg.twin || !slug) return [];
  const file = join(wt, cfg.twin.file);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  const key = `"${cfg.twin.key}": "${slug}",`;
  const at = lines.findIndex((l) => l.trim() === key);
  if (at < 0) return [];
  for (let i = at + 1; i <= at + 3 && i < lines.length; i++) {
    const m = lines[i].match(/^\s*"slug":\s*"([^"]+)"/);
    if (m) return [`El post gemelo de "${slug}" es el que tiene "${cfg.twin.key}": "${slug}" (${cfg.twin.file}, línea ${at + 1}); su slug es "${m[1]}". Editar ese post es lo correcto: no pidas ver la línea "${cfg.twin.key}".`];
  }
  return [];
}

export function executorMode(): 'hybrid' | 'claude' {
  return process.env.AGENT_EXECUTOR === 'claude' ? 'claude' : 'hybrid';
}

export class LimitError extends Error {}
export type Ctx = { runId?: number; priorFailure?: string; progress?: (stage: Stage, note?: string) => void; db: DatabaseSync; site: Site; cfg: AgentSite | undefined; usage: ClaudeResult[]; log: (m: string) => void; args?: { slug?: string; ids?: number[]; topicId?: number } };
export type AgentFn = (c: Ctx) => Promise<string>;

// Never touched by an agent push, whatever the prompt says.
export const FORBIDDEN = /checkout|pago|payment|mercado|email|webhook|vercel\.json|\.env|middleware|next\.config|package(-lock)?\.json|^supabase|\/api\//i;

const TZ = 'America/Mexico_City';
export function mxNow(d = new Date()): { date: string; hm: string; dow: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
/** Next Monday or Wednesday strictly after `from` (YYYY-MM-DD): the publication day of the post being drafted. */
export function nextPublishDate(from = mxNow().date): string {
  const d = new Date(from + 'T12:00:00Z');
  for (let i = 0; i < 7; i++) { d.setUTCDate(d.getUTCDate() + 1); if ([1, 3].includes(d.getUTCDay())) return d.toISOString().slice(0, 10); }
  throw new Error('unreachable');
}

/** Next Monday/Wednesday that no draft or published post of this site already uses (several "Write now" clicks must not pile onto one day). */
export function nextFreeDate(db: DatabaseSync, siteId: number, from = mxNow().date): string {
  const used = new Set((db.prepare("SELECT json_extract(payload_json, '$.publishAt') d FROM approvals WHERE site_id = ? AND kind = 'post' AND status IN ('pending', 'approved', 'published')").all(siteId) as { d: string | null }[]).map((r) => r.d));
  let d = nextPublishDate(from);
  for (let i = 0; i < 60 && used.has(d); i++) d = nextPublishDate(d);
  return d;
}

const sh = (cwd: string, cmd: string, args: string[], timeout = 600_000) => execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
export const git = (cwd: string, ...a: string[]) => sh(cwd, 'git', a);
/** Posts are pushed when approved, not on `publishAt`: rewrite the scheduled (future) date to today in the date fields the draft added, so nothing goes live dated in the future. Returns how many lines changed. */
export function clampFutureDates(wt: string, base: string, publishAt: string | undefined, today = mxNow().date): number {
  if (!publishAt || !/^\d{4}-\d{2}-\d{2}$/.test(publishAt) || publishAt <= today) return 0;
  const files = git(wt, 'diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);
  const key = /(modifiedAt|publishedAt|dateModified|datePublished|lastmod|updated|date)\b/i;
  let n = 0;
  for (const f of files) {
    const p = join(wt, f);
    if (!existsSync(p)) continue;
    let text: string; try { text = readFileSync(p, 'utf8'); } catch { continue; }
    if (!text.includes(publishAt)) continue;
    const out = text.split('\n').map((l) => { if (key.test(l) && l.includes(publishAt)) { n++; return l.split(publishAt).join(today); } return l; }).join('\n');
    if (out !== text) writeFileSync(p, out);
  }
  if (n) { git(wt, 'add', '-A'); git(wt, 'reset', '-q', '--', 'node_modules'); git(wt, 'commit', '-q', '--amend', '--no-edit'); }
  return n;
}
/** git against the site's remote. With `remoteUrl` the remote is defined for this one command only (the owner's checkout stays untouched). */
const gitRemote = (cfg: AgentSite, ...a: string[]) => git(cfg.worktree, ...(cfg.remoteUrl ? ['-c', `remote.${cfg.remote}.url=${cfg.remoteUrl}`, '-c', `remote.${cfg.remote}.fetch=+refs/heads/*:refs/remotes/${cfg.remote}/*`] : []), ...a);

export function claudeOptions<T extends { role?: Role }>(o: T): T & { system?: string; effort?: string; model?: string } {
  return o.role ? { ...o, system: systemPrompt(o.role), effort: EFFORT[o.role], ...(MODEL[o.role] !== undefined ? { model: MODEL[o.role] } : {}) } : o;
}

export async function ask(c: Ctx, o: { prompt: string; cwd: string; tools: string[]; maxTurns: number; timeoutMs: number; role?: Role }): Promise<string> {
  const t0 = Date.now();
  const r = await runClaude(claudeOptions(o));
  const secs = Math.round((Date.now() - t0) / 1000);
  c.log(`claude [${o.tools.join('+') || 'no tools'}, <=${o.maxTurns} turns, prompt ${Math.round(o.prompt.length / 1000)}k chars]: ${secs}s, ${r.tokensIn} in / ${r.tokensOut} out, cost $${r.costUsd.toFixed(4)}, cw ${r.cacheWrite} cr ${r.cacheRead}${r.ok ? '' : `, FAILED${r.limited ? ' (limit)' : ''}: ${(r.error ?? '').slice(0, 200)}`}`);
  c.usage.push(r);
  if (c.runId !== undefined) {
    try { c.db.prepare('INSERT INTO agent_calls (run_id, role, model, tools, prompt_chars, fresh, cache_write, cache_read, tokens_out, cost_usd, secs, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(c.runId, o.role ?? 'other', r.model, o.tools.join('+'), o.prompt.length, r.fresh, r.cacheWrite, r.cacheRead, r.tokensOut, r.costUsd, secs, r.ok ? 1 : 0); } catch { /* ledger failures must not fail the job */ }
  }
  if (r.limited) throw new LimitError(r.error ?? 'usage limit');
  if (!r.ok) throw new Error(r.error ?? 'claude failed');
  return r.text;
}

export const audience = (c: Ctx) => audienceBrief(new URL(c.site.url).hostname) + seoPlaybook();
/** Ranking used to pick the next topic: the owner's target customers first, bulk/industrial last. */
export const TOPIC_ORDER = "(score + CASE segment WHEN 'event' THEN 3 WHEN 'corporate-event' THEN 3 WHEN 'planner' THEN 3 WHEN 'bulk' THEN -4 ELSE 0 END)";

// ---------- worktree ----------
/** A clean checkout of origin/main on `branch`, in the agents' own worktree (the owner's checkout is never touched). */
export function prepareWorktree(cfg: AgentSite, branch: string): string {
  if (!existsSync(cfg.worktree)) git(cfg.repo, 'worktree', 'add', '--detach', cfg.worktree, 'HEAD');
  syncWorktree(cfg, branch);
  const nm = join(cfg.worktree, 'node_modules');
  if (!existsSync(nm) && existsSync(join(cfg.repo, 'node_modules'))) symlinkSync(join(cfg.repo, 'node_modules'), nm);
  return cfg.worktree;
}
export function syncWorktree(cfg: AgentSite, branch: string): { moved: boolean; head: string } {
  gitRemote(cfg, 'fetch', cfg.remote, 'main');
  const target = git(cfg.worktree, 'rev-parse', `${cfg.remote}/main`).trim();
  const head = git(cfg.worktree, 'rev-parse', 'HEAD').trim();
  const dirty = git(cfg.worktree, 'status', '--porcelain').split('\n').some((line) => line && !line.includes('node_modules'));
  const current = git(cfg.worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  if (head === target && !dirty && current === branch) return { moved: false, head: target };
  git(cfg.worktree, 'reset', '--hard');
  git(cfg.worktree, 'clean', '-fd');
  git(cfg.worktree, 'checkout', '-B', branch, `${cfg.remote}/main`);
  if (git(cfg.worktree, 'rev-parse', 'HEAD').trim() !== target) throw new Error(`worktree is not at ${cfg.remote}/main after sync`);
  return { moved: true, head: target };
}
// node_modules is a symlink to the owner's install: some repos ignore `node_modules/` (directories only), so it must never be staged.
export const changedFiles = (wt: string) => { git(wt, 'add', '-A'); git(wt, 'reset', '-q', '--', 'node_modules'); return git(wt, 'diff', '--cached', '--name-only').split('\n').filter(Boolean); };
export const typecheck = (cfg: AgentSite) => { try { sh(cfg.worktree, cfg.typecheck[0], cfg.typecheck.slice(1), 900_000); return null; } catch (e) { return String((e as any).stdout ?? e).slice(0, 1500); } };
const commit = (wt: string, msg: string) => git(wt, 'commit', '-m', `${msg}\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`);

/** Remove generated file blocks from a git diff and report the removed paths. */
export function stripDerived(diff: string, derived: string[] = []): { diff: string; removed: string[] } {
  const removed: string[] = [];
  const chunks = diff.split(/(?=^diff --git )/m);
  const kept = chunks.filter((chunk) => {
    const file = chunk.match(/^diff --git a\/(\S+) /)?.[1];
    if (!file || !pathAllowed(derived, file)) return true;
    removed.push(file);
    return false;
  });
  return { diff: kept.join(''), removed };
}

/** Added lines only: the em-dash rule applies to new copy, not to what already exists. */
/** Added lines with a blank line wherever the diff skips or keeps text (context, removed, hunk header): an unchanged blank line between two paragraphs is context, and dropping it would glue them into one block. */
export function addedBlocks(diff: string): string[] {
  const out: string[] = [];
  for (const l of diff.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) out.push(l.slice(1));
    else if (out.length && out[out.length - 1] !== '') out.push('');
  }
  return out;
}
export function addedLines(diff: string): string[] { return diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)); }
export function lintAdded(diff: string, only?: string[], derived: string[] = []): string[] {
  // generated files (e.g. llms.txt, whose line format contains " — ") are not copy the model wrote: judge only `only`, when given
  diff = stripDerived(diff, derived).diff;
  const judged = only ? diff.split(/^diff --git /m).filter((c) => { const f = c.match(/^a\/(\S+) /)?.[1]; return !!f && pathAllowed(only, f); }).join('\n+++ \n') : diff;
  const added = addedLines(judged), bad: string[] = [];
  if (added.some((l) => l.includes('—'))) bad.push('em-dash in new copy');
  if (added.some((l) => /\b(100% garantizad|el mejor del mundo|certificad[oa] iso)/i.test(l))) bad.push('unverifiable superlative/certification claim');
  return bad;
}

export function lintDetails(diff: string, only?: string[], derived: string[] = []): string[] {
  const bad: string[] = [];
  for (const chunk of diff.split(/^diff --git /m)) {
    const file = chunk.match(/^a\/(\S+) /)?.[1];
    if (!file || (only && !pathAllowed(only, file)) || pathAllowed(derived, file)) continue;
    for (const line of addedLines(chunk)) {
      const trimmed = line.trim(), dash = trimmed.indexOf('—');
      if (dash !== -1) {
        const start = Math.max(0, Math.min(dash - 45, trimmed.length - 90));
        const end = Math.min(trimmed.length, start + 90);
        const context = (start > 0 ? '…' : '') + trimmed.slice(start, end) + (end < trimmed.length ? '…' : '');
        bad.push(`${file}: em-dash in new copy: "${context}"`);
      }
      const claim = line.match(/\b(100% garantizad|el mejor del mundo|certificad[oa] iso)/i);
      if (claim) bad.push(`${file}: unverifiable superlative or certification claim: "${claim[0]}"`);
      if (bad.length >= 8) return bad.slice(0, 8);
    }
  }
  return bad;
}

function repoHasPath(cfg: AgentSite): (href: string) => boolean {
  return (href) => {
    try { git(cfg.worktree, 'grep', '-q', '-F', '-e', href, 'HEAD', '--'); return true; }
    catch (error) { return (error as { status?: number }).status !== 1; }
  };
}

export function linksOf(db: DatabaseSync, siteId: number, cap = 300): string[] {
  const run = db.prepare("SELECT id FROM runs WHERE site_id = ? AND status = 'ok' ORDER BY id DESC LIMIT 1").get(siteId) as { id: number } | undefined;
  if (!run) return [];
  const pages = db.prepare('SELECT p.url FROM pages p JOIN snapshots s ON s.page_id = p.id AND s.run_id = ? WHERE p.site_id = ? AND s.status = 200').all(run.id, siteId) as { url: string }[];
  const paths = new Set(pages.map(({ url }) => new URL(url).pathname).map((path) => path !== '/' && path.endsWith('/') ? path.slice(0, -1) : path).filter((path) => !/\.[a-z0-9]{2,5}$/i.test(path)));
  return [...paths].sort((a, b) => Number(a.includes('/blog/')) - Number(b.includes('/blog/')) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, cap);
}

export function linkExists(cfg: AgentSite, links: string[]): (href: string) => boolean {
  const fallback = repoHasPath(cfg);
  return (href) => links.includes(href !== '/' && href.endsWith('/') ? href.slice(0, -1) : href) || fallback(href);
}

export function lintPlanText(text: string, cfg: AgentSite, exists?: (href: string) => boolean): string[] {
  const dashDiff = 'diff --git a/plan b/plan\n' + text.split('\n').map((line) => '+' + line).join('\n');
  return [
    ...(cfg.answerMode ? checkAnswerBlocks(text, cfg.answerMode) : []),
    ...checkDuplicateSentences(text),
    ...(cfg.answerMode ? checkInternalLinks(text, exists ?? repoHasPath(cfg)) : []),
    ...lintDetails(dashDiff).filter((problem) => problem.includes('em-dash')),
  ];
}

export function lintAcceptance(diff: string, cfg: AgentSite, exists?: (href: string) => boolean): string[] {
  // per file: boilerplate shared by many regenerated pages (footer, JSON-LD) is not a duplicate inside any one of them
  return diff.split(/^diff --git /m).flatMap((chunk) => {
    // generated files (llms-full.txt, md/*, api/_index.js) concatenate many pages, so a sentence repeats there by design: judge only copy the model wrote
    const file = chunk.match(/^a\/(\S+) /)?.[1];
    if (file && pathAllowed(cfg.derivedPaths ?? [], file)) return [];
    const text = addedBlocks(chunk).join('\n');
    return [...(cfg.answerMode ? checkAnswerBlocks(text, cfg.answerMode) : []), ...checkDuplicateSentences(text), ...(cfg.answerMode ? checkInternalLinks(text, exists ?? repoHasPath(cfg)) : [])];
  });
}

// ---------- non-LLM jobs ----------
export const crawlAgent: AgentFn = async ({ db, site, log }) => {
  const r = await runSite(db, site, { concurrency: 2, log });
  const t = alertText(r); if (t) await sendAlert(t);
  return `crawl #${r.runId} ${r.status}: ${r.pages} pages, ${r.newFindings.length} new / ${r.resolved.length} resolved findings`;
};
export const collectAgent: AgentFn = async ({ db, site }) => { const r = await collect(db, site); return `metrics: ${r.gsc} GSC rows, ${r.bing} Bing rows`; };

// ---------- analyst ----------
type Win = { c: number; i: number; p: number };
const win = (db: DatabaseSync, id: number, from: string, to: string): Win =>
  db.prepare("SELECT COALESCE(SUM(clicks),0) c, COALESCE(SUM(impressions),0) i, COALESCE(SUM(position*impressions)/NULLIF(SUM(impressions),0),0) p FROM metrics WHERE site_id = ? AND source = 'gsc' AND date BETWEEN ? AND ?").get(id, from, to) as Win;
const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Everything the analyst needs, computed in SQL so the model only interprets (cheap, and numbers are never invented). */
export function weeklySummary(db: DatabaseSync, siteId: number, segments = true) {
  const cur = win(db, siteId, dayAgo(8), dayAgo(2)), prev = win(db, siteId, dayAgo(15), dayAgo(9));
  const agg = (by: 'query' | 'page', from: string, to: string) => new Map((db.prepare(`SELECT ${by} k, SUM(clicks) c, SUM(impressions) i, SUM(position*impressions)/NULLIF(SUM(impressions),0) p FROM metrics WHERE site_id = ? AND source = 'gsc' AND date BETWEEN ? AND ? GROUP BY ${by}`).all(siteId, from, to) as any[]).map((r) => [r.k, r]));
  const movers = (by: 'query' | 'page') => {
    const a = agg(by, dayAgo(8), dayAgo(2)), b = agg(by, dayAgo(15), dayAgo(9));
    const rows = [...new Set([...a.keys(), ...b.keys()])].map((k) => ({ k, di: (a.get(k)?.i ?? 0) - (b.get(k)?.i ?? 0), now: a.get(k), was: b.get(k) }));
    const fmt = (x: typeof rows[number]) => ({ [by]: x.k, impressions: `${x.was?.i ?? 0} -> ${x.now?.i ?? 0}`, clicks: `${x.was?.c ?? 0} -> ${x.now?.c ?? 0}`, position: `${r1(x.was?.p ?? 0)} -> ${r1(x.now?.p ?? 0)}` });
    return { up: rows.filter((x) => x.di > 0).sort((x, y) => y.di - x.di).slice(0, 8).map(fmt), down: rows.filter((x) => x.di < 0).sort((x, y) => x.di - y.di).slice(0, 8).map(fmt) };
  };
  const striking = [...agg('query', dayAgo(30), dayAgo(2)).values()].filter((r) => r.p >= 8 && r.p <= 20 && r.i >= 5).sort((a, b) => b.i - a.i).slice(0, 15).map((r) => ({ query: r.k, impressions: r.i, clicks: r.c, position: r1(r.p) }));
  const seen = new Set((db.prepare("SELECT DISTINCT page FROM metrics WHERE site_id = ? AND source = 'gsc' AND date >= ?").all(siteId, dayAgo(30)) as { page: string }[]).map((r) => r.page.replace(/\/$/, '')));
  const lastRun = (db.prepare("SELECT id FROM runs WHERE site_id = ? AND status = 'ok' ORDER BY id DESC LIMIT 1").get(siteId) as { id: number } | undefined)?.id;
  const noVis = lastRun ? (db.prepare('SELECT p.url FROM pages p JOIN snapshots s ON s.page_id = p.id AND s.run_id = ? WHERE p.site_id = ? AND p.in_sitemap = 1 AND s.status = 200').all(lastRun, siteId) as { url: string }[]).map((r) => r.url).filter((u) => !seen.has(u.replace(/\/$/, ''))) : [];
  const findings = db.prepare("SELECT rule_id, severity, COUNT(*) n FROM findings WHERE site_id = ? AND status = 'open' AND severity != 'info' GROUP BY rule_id, severity ORDER BY n DESC LIMIT 12").all(siteId);
  const bing = db.prepare("SELECT query, SUM(clicks) clicks, SUM(impressions) impressions, ROUND(AVG(position),1) position FROM metrics WHERE site_id = ? AND source = 'bing' AND date >= ? GROUP BY query ORDER BY impressions DESC LIMIT 10").all(siteId, dayAgo(35));
  return { period: { now: `${dayAgo(8)}..${dayAgo(2)}`, before: `${dayAgo(15)}..${dayAgo(9)}` }, totals: { now: { ...cur, p: r1(cur.p) }, before: { ...prev, p: r1(prev.p) } },
    queries: movers('query'), pages: movers('page'), strikingDistance: striking, sitemapPagesWithNoSearchImpressions30d: { count: noVis.length, sample: noVis.slice(0, 12) }, openFindings: findings, bingTopQueries: bing, effectOfOurPosts: postEffects(db, siteId), ...(segments ? { audienceSegments: segmentShare(db, siteId) } : {}) };
}

/** Posts the agents published or improved 14 to 120 days ago: Google impressions per day in the 28 days before vs the days since (same page). */
export function postEffects(db: DatabaseSync, siteId: number) {
  const out: { post: string; kind: string; date: string; impressionsPerDay: string; clicksPerDay: string }[] = [];
  const rows = db.prepare("SELECT title, json_extract(payload_json, '$.urls[0]') url, substr(decided_at, 1, 10) d FROM approvals WHERE site_id = ? AND kind = 'post' AND status = 'published' AND decided_at BETWEEN datetime('now', '-120 days') AND datetime('now', '-14 days') ORDER BY decided_at DESC LIMIT 12").all(siteId) as { title: string; url: string | null; d: string }[];
  const sum = db.prepare("SELECT COALESCE(SUM(impressions),0) i, COALESCE(SUM(clicks),0) c FROM metrics WHERE site_id = ? AND source = 'gsc' AND (page = ? OR page = ?) AND date BETWEEN ? AND ?");
  const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
  for (const r of rows) {
    if (!r.url) continue;
    const u = r.url.replace(/\/$/, ''), from = addDays(r.d, -28), until = dayAgo(2), days = Math.max(1, Math.round((Date.parse(until) - Date.parse(r.d)) / 86_400_000));
    const b = sum.get(siteId, u, u + '/', from, addDays(r.d, -1)) as { i: number; c: number }, a = sum.get(siteId, u, u + '/', r.d, until) as { i: number; c: number };
    out.push({ post: r.title, kind: r.title.split(':')[0], date: r.d, impressionsPerDay: `${r1(b.i / 28)} -> ${r1(a.i / days)}`, clicksPerDay: `${r1(b.c / 28)} -> ${r1(a.c / days)}` });
  }
  return out;
}

/** Share of Google impressions/clicks (28d) going to each customer segment: the number that shows whether the SEO turn is working. */
export function segmentShare(db: DatabaseSync, siteId: number) {
  const out: Record<string, { impressions: number; clicks: number }> = {};
  for (const r of db.prepare("SELECT query, SUM(impressions) i, SUM(clicks) c FROM metrics WHERE site_id = ? AND source = 'gsc' AND date >= ? GROUP BY query").all(siteId, dayAgo(30)) as { query: string; i: number; c: number }[]) {
    const seg = segmentOf(r.query); out[seg] ??= { impressions: 0, clicks: 0 }; out[seg].impressions += r.i; out[seg].clicks += r.c;
  }
  return out;
}

/** Deterministic alert, independent of the model: a real drop on real volume. */
export function dropAlert(s: ReturnType<typeof weeklySummary>): string | null {
  const { now, before } = s.totals, msg: string[] = [];
  if (before.c >= 10 && now.c < before.c * 0.6) msg.push(`clicks ${before.c} -> ${now.c}`);
  if (before.i >= 200 && now.i < before.i * 0.6) msg.push(`impressions ${before.i} -> ${now.i}`);
  return msg.length ? `📉 ${msg.join(', ')} week over week` : null;
}

export const analystAgent: AgentFn = async (c) => {
  const s = weeklySummary(c.db, c.site.id, !!c.cfg?.segments);
  if (!s.totals.now.i && !s.totals.before.i) return 'no Search Console data yet; run collect first';
  const alert = dropAlert(s);
  if (alert) await sendAlert(`${new URL(c.site.url).hostname}: ${alert}`);
  const text = await ask(c, {
    role: 'analyst', cwd: c.cfg?.worktree && existsSync(c.cfg.worktree) ? c.cfg.worktree : '/tmp', tools: [], maxTurns: 2, timeoutMs: 300_000,
    prompt: `Eres el analista SEO de ${c.site.url}. Abajo hay datos reales y ya calculados (Search Console y Bing, semana contra semana). Escribe en español un informe breve (máx 220 palabras) para el dueño:
1) Qué funciona, 2) Qué no funciona o cae, 3) Hasta 4 acciones concretas, cada una con el agente que debe hacerla (fixer = corrige en el sitio, researcher = busca temas, writer = escribe posts, owner = solo el dueño).
Usa solo estos números; si algo no se puede concluir con tan pocos datos, dilo. No inventes volúmenes ni causas.
Si effectOfOurPosts muestra que un post que nosotros publicamos o mejoramos bajó mucho en impresiones por día (más de 40%) después del cambio, dilo: la regla del libro es esperar unas semanas, y si sigue bajando revertir a la versión anterior y reintentar con cambios pequeños (acción para el fixer o el dueño). Si subió, menciónalo como lo que funciona.
${c.cfg?.segments ? 'Incluye una línea sobre audienceSegments: qué parte de las impresiones viene de eventos/bodas (cliente ideal) frente a etiquetas/volumen, según el brief.' : ''}
${audience(c)}

${JSON.stringify(s)}`,
  });
  return (alert ? `${alert}\n\n` : '') + text;
};

// ---------- researcher ----------
type Topic = { title: string; slug: string; query: string; action: string; why: string; score: number };

export const researcherAgent: AgentFn = async (c) => {
  if (!c.cfg) throw new Error('no agent config for this site');
  const posts = c.cfg.listPosts(c.cfg.repo);
  const backlog = takenSlugs(c.db, c.site.id);
  const profileRow = c.db.prepare('SELECT data_json FROM site_profiles WHERE site_id = ?').get(c.site.id) as { data_json: string } | undefined;
  let profile: any = {}; try { profile = JSON.parse(profileRow?.data_json ?? '{}'); } catch { /* no profile */ }
  const services: string[] = Array.isArray(profile.services) ? profile.services : [];
  const geoWords = [profile.city, profile.region, profile.country].filter((x): x is string => typeof x === 'string');
  const opts = { lang: c.cfg.lang, country: c.site.market.split(',')[0]?.trim() || profile.country || '', location: profile.city || '', ownHost: new URL(c.site.url).hostname };
  const taken = [...posts.flatMap((p) => [p.slug, p.title]), ...backlog];
  const pool = await buildDemandPool(c.db, c.site.id, { ...opts, services, brandTerms: Array.isArray(profile.brand_terms) ? profile.brand_terms : [], geoWords, taken });
  const clusters = clusterQueries(pool), shortlist = clusters.slice(0, 60);
  const wt = prepareWorktree(c.cfg, 'agent/research'), budget = makeBudget();
  const common = `Eres investigador de temas SEO y GEO para ${c.site.url}. Escribe title y slug en ${c.cfg.lang === 'en' ? 'inglés' : 'español'}.
Posts existentes: ${JSON.stringify(posts)}. Slugs en backlog: ${JSON.stringify(backlog)}.
${c.cfg.research.context}
${c.cfg.research.priority}
${audienceBrief(new URL(c.site.url).hostname)}${customerQuestions(new URL(c.site.url).hostname)}
Elige hasta 12 clusters que el cliente ideal buscaría antes de comprar o contratar. Omite búsquedas sobre cosas que el negocio no vende (por ejemplo entradas para eventos). No inventes consultas. Evita duplicar posts y usa merge:<slug> para ampliarlos.
${c.cfg.rules}
Clusters: ${JSON.stringify(shortlist.map((c) => ({ id: c.id, primary: c.primary, variants: c.members.map((m) => m.query), gscImpressions: c.gscImpressions, bestPosition: c.bestPosition, sources: c.sources })))}
Responde SOLO con un arreglo JSON: [{"clusterId":"...","title":"...","slug":"kebab-case","action":"new"|"merge:<slug>","why":"máx 40 palabras","fit":true|false}]. fit indica si quien busca es un cliente potencial. fit debe ser false cuando la redacción o el idioma de la consulta indique que quien busca está fuera del mercado del sitio (por ejemplo, consultas en inglés o de dialecto extranjero para un negocio local mexicano), aunque tenga muchas impresiones.`;
  const text = await ask(c, { role: 'research', cwd: wt, tools: ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob'], maxTurns: 15, timeoutMs: 1_200_000, prompt: common });
  const proposed = extractJson<any[]>(text);
  const ids = new Set(shortlist.map((cluster) => cluster.id));
  if (Array.isArray(proposed)) for (const pick of proposed) if (!ids.has(pick?.clusterId)) c.log(`rejected out-of-pool: ${pick?.clusterId}`);
  const accepted = acceptPicks(proposed, shortlist, [...posts.map((p) => p.slug), ...backlog]);
  const trends = await trendsFor(headTerms(clusters, services), opts.country, { db: c.db, max: 5 });
  const ins = c.db.prepare('INSERT OR IGNORE INTO topics (site_id, title, slug, query, action, why, score, segment, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const min = minTopicScore();
  const candidates: Awaited<ReturnType<typeof verifyQuery>>[] = [], scored: ScoredCandidate[] = [];
  let n = 0;
  for (const t of accepted) {
    const member = t.cluster.members.find((m) => m.query === t.query)!;
    const [evidence, bing] = await Promise.all([verifyQuery(t.query, { ...opts, ownImpressions60d: member.gscImpressions }, { db: c.db, budget }), bingKeyword(t.query, opts.country, { db: c.db })]);
    evidence.cluster = { id: t.cluster.id, gscImpressions: t.cluster.gscImpressions, bingImpressions: t.cluster.bingImpressions, sources: t.cluster.sources, bestPosition: t.cluster.bestPosition, members: t.cluster.members.map((m) => m.query) };
    evidence.fit = t.fit; setDemandEvidence(evidence, bing, trendForCluster(t.cluster, trends)); candidates.push(evidence);
    const score = scoreTopic(evidence, { serviceWords: services, isLocalBusiness: profile.scope === 'local' });
    const reason = topicDropReason(evidence, score, min);
    recordTopicCandidate(c.db, c.site.id, evidence, score, reason); scored.push({ query: t.query, score, reason });
    if (reason) continue;
    n += Number(ins.run(c.site.id, t.title, t.slug, t.query, t.action, `${t.why}\n${evidenceLine(evidence)}`, score, segmentOf(`${t.title} ${t.query}`), JSON.stringify(evidence)).changes);
  }
  const summary = `pool ${pool.length}; clusters ${clusters.length}; picked ${accepted.length}; ${researchFunnel(candidates, n, min, trends.paused)}; ${droppedSummary(scored)}`;
  c.log(summary);
  return summary;
};

// ---------- writer ----------
/** The EN slug as the repo itself maps it (BLOG_SLUG_EN), not as the model claims it. */
export function enSlugFor(cfg: AgentSite, slug: string, fallback?: string): string | undefined {
  try { return readFileSync(join(cfg.worktree, 'src/lib/i18n.ts'), 'utf8').match(new RegExp(`"(?:/blog/)?${slug}":\\s*"(?:/blog/)?([^"]+)"`))?.[1] ?? fallback; } catch { return fallback; }
}
/** A string that only the NEW version of the page contains, so "live" means the new deploy, not the old page answering 200. */
export function pickMarker(diff: string): string | undefined {
  // The ES file only (the EN page ships in the same deploy): skip chunks of *.en.ts files.
  const es = diff.split(/^diff --git /m).filter((chunk) => !/^a\/\S+\.en\.ts /.test(chunk)).join('\n');
  const lines = addedLines(es);
  const md = lines.map((l) => l.match(/^## ([^'"&<>*_`\[\]\\]{8,80})$/)?.[1]).find(Boolean); // markdown posts: the heading renders as plain text in the HTML
  const py = lines.map((l) => l.match(/^<h2 id="[^"]+">([^'"&<>*_`\[\]\\]{8,80})<\/h2>$/)?.[1]).find(Boolean); // Dizayn SEO posts: HTML inside a Python string
  return lines.map((l) => l.match(/heading:\s*"([^"]{8,80})"/)?.[1]).find(Boolean) ?? md ?? py ?? lines.map((l) => l.match(/^\s*"([^"\\]{30,70})/)?.[1]).find(Boolean);
}

function approvalFor(c: Ctx, kind: string, title: string, payload: object, diff: string): number {
  return Number(c.db.prepare('INSERT INTO approvals (site_id, agent, kind, title, payload_json, diff) VALUES (?, ?, ?, ?, ?, ?)').run(c.site.id, kind === 'post' ? 'writer' : 'fixer', kind, title, JSON.stringify(payload), diff).lastInsertRowid);
}

/** From the Get Found playbook: compare against the #1 result before writing, and place the keyword where it counts. Operational, so the writer cannot skip it. */
export const MINI_AUDIT = `Antes de escribir haz la mini auditoría del playbook: busca en la web la consulta principal, abre los 3 primeros resultados y anota sus palabras, sus H2 y cuántas veces usan la palabra clave. Tu texto cubre lo mismo con tus propias palabras (no copies encabezados idénticos) y supera ligeramente al #1 en profundidad útil, no en relleno. La palabra clave principal va en title (<=60 caracteres), meta description (80 a 156), URL, H1 y al menos un H2. Mínimo 3 enlaces internos, al menos uno a la página que vende (producto o servicio) con ancla descriptiva de 1 a 5 palabras. Cada H2 abre con una respuesta directa de 40 a 60 palabras. Si algo no lo puedes verificar, déjalo fuera.`;

type Draftable = { id: number | null; title: string; slug: string; query: string; why: string; action: string; improve?: boolean; reasons?: string[] };

export const structuralOnly = (reasons: string[]): boolean => reasons.length > 0 && reasons.every((r) => /^(sin FAQ visible|sin schema BlogPosting|title de |meta description de |\d+ H1 |solo \d+ enlaces internos|casi sin impresiones|posición media|sin clics)/.test(r));
export const NO_RESEARCH = 'No se hizo investigación externa: esta mejora es estructural. No agregues afirmaciones factuales nuevas (cifras, normas, comparaciones); usa solo el TEXTO ACTUAL DEL POST y los DATOS AUTORIZADOS DEL REPO.';

export const writerAgent: AgentFn = async (c) => {
  if (!c.cfg) throw new Error('no agent config for this site');
  if (c.args?.topicId != null) { // "Write now" on one topic of the backlog: no weekly cap, the owner asked for exactly this one
    const t = c.db.prepare('SELECT * FROM topics WHERE id = ? AND site_id = ?').get(c.args.topicId, c.site.id) as Draftable | undefined;
    if (!t) throw new Error('That topic is not in this site\'s backlog any more.');
    if ((t as any).status !== 'new') return `skipped: "${t.title}" is already ${(t as any).status}`;
    return draftTopic(c, t, nextFreeDate(c.db, c.site.id));
  }
  const pending = c.db.prepare("SELECT COUNT(*) n FROM approvals WHERE site_id = ? AND kind = 'post' AND status = 'pending'").get(c.site.id) as { n: number };
  if (pending.n >= 2) return `skipped: ${pending.n} drafts already waiting for approval`;
  const topic = c.db.prepare(`SELECT * FROM topics WHERE site_id = ? AND status = 'new' ORDER BY ${TOPIC_ORDER} DESC, id LIMIT 1`).get(c.site.id) as Draftable | undefined;
  if (!topic) return 'skipped: no topics in the backlog (the researcher runs Sundays)';
  return draftTopic(c, topic, nextPublishDate());
};

/** One click on a low-scoring post: the writer reworks that post, driven by the measured reasons for its score. */
export const improverAgent: AgentFn = async (c) => {
  const slug = c.args?.slug;
  if (!slug) throw new Error('improver needs a post slug');
  if (c.db.prepare("SELECT 1 FROM approvals WHERE site_id = ? AND kind = 'post' AND status IN ('pending', 'approved') AND json_extract(payload_json, '$.slug') = ?").get(c.site.id, slug)) return `skipped: ${slug} already has a draft waiting or being published`;
  const row = blogScores(c.db, c.site).find((r) => r.slug === slug);
  if (!row) throw new Error(`no crawled blog post with slug ${slug}`);
  return draftTopic(c, { id: null, title: row.title || slug, slug, query: row.topQuery ?? '', action: `merge:${slug}`, improve: true, reasons: row.reasons,
    why: `${row.reasons.join('; ')}${row.impressions ? `. Search Console 90d: ${row.impressions} impresiones, ${row.clicks} clics, posición media ${row.position}` : '. Sin datos de búsqueda aún'}` }, mxNow().date);
};

export function startDraft(c: Ctx, topic: Draftable, publishAt: string) {
  const cfg = c.cfg!;
  // unique per run: a re-run (restart, retry) must never reset the branch of a draft that is still waiting for approval
  const branch = `agent/post-${topic.slug}${topic.improve ? '-' + publishAt : ''}-${Date.now().toString(36)}`;
  const wt = prepareWorktree(cfg, branch);
  const merge = String(topic.action).startsWith('merge:') ? String(topic.action).slice(6) : null;
  if (!cfg.postBrief) throw new Error('this site has no writer brief configured');
  const opts = { slug: merge ?? topic.slug, improve: !!topic.improve, merge };
  const brief = cfg.postBrief({ kind: topic.improve ? 'improve' : merge ? 'merge' : 'new', title: topic.title, slug: topic.slug, query: topic.query, why: topic.why, merge, publishAt });
  return { cfg, branch, wt, merge, opts, brief };
}

/** Deterministic checks after every model edit: regenerate derived files, typecheck, then the site's "is it wired in everywhere" rules. */
export function makeVerify(cfg: AgentSite, wt: string, opts: PostOpts): () => string | null {
  return () => {
    try { cfg.postEdit?.(wt, opts); } catch (e) { const s = String((e as any).stderr ?? (e as Error).message); return `post-edit step failed: ${s.length <= 1800 ? s : s.slice(0, 300) + '\n[... cut ...]\n' + s.slice(-1500)}`; }
    const tc = typecheck(cfg); if (tc) return tc;
    const v = cfg.validate?.(wt, opts) ?? [];
    return v.length ? `The post is not wired in correctly:\n- ${v.join('\n- ')}` : null;
  };
}

export async function finishDraft(c: Ctx, topic: Draftable, publishAt: string, s: { cfg: AgentSite; branch: string; wt: string; merge: string | null }, text: string, err: string | null, extra?: Record<string, unknown>): Promise<string> {
  const { cfg, branch, wt, merge } = s;
  const files = changedFiles(wt), diff = git(wt, 'diff', '--cached');
  if (files.length === 0) {
    try { c.log(`branch: ${git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()}`); } catch { /* diagnostics only */ }
    try { c.log(`head: ${git(wt, 'rev-parse', '--short', 'HEAD').trim()}`); } catch { /* diagnostics only */ }
    try { c.log(`status: ${git(wt, 'status', '--porcelain').slice(0, 600)}`); } catch { /* diagnostics only */ }
    try { c.log(`diff stat: ${git(wt, 'diff', 'HEAD', '--stat').slice(0, 600)}`); } catch { /* diagnostics only */ }
  }
  const bad = [...(err ? [`checks: ${err.slice(0, 300)}`] : []), ...files.filter((f) => !pathAllowed(cfg.contentPaths, f) && !pathAllowed(cfg.derivedPaths ?? [], f)).map((f) => `touched forbidden file ${f}`), ...(files.length ? [] : ['no changes made']), ...lintAdded(diff, cfg.lintPaths, cfg.derivedPaths)];
  if (bad.length) { git(wt, 'reset', '--hard'); throw new Error(`draft rejected by checks: ${bad.join('; ')}`); }
  const meta = extractJson<{ slug: string; enSlug?: string; claims?: unknown[] }>(text);
  commit(wt, `content(blog): ${topic.title}`);
  const slug = merge ?? meta.slug ?? topic.slug;
  const enSlug = enSlugFor(cfg, slug, meta.enSlug);
  const id = approvalFor(c, 'post', `${topic.improve ? 'Improve' : merge ? 'Update' : 'New post'}: ${topic.title}`, { branch, slug, enSlug, topicId: topic.id ?? null, publishAt, files, claims: meta.claims ?? [], urls: cfg.blogUrl(slug, enSlug), marker: pickMarker(diff), ...extra }, diff);
  if (topic.id) c.db.prepare("UPDATE topics SET status = 'drafted' WHERE id = ?").run(topic.id);
  await sendAlert(`✍️ Borrador listo para aprobar: ${topic.title} (${topic.improve ? 'mejora de post existente' : 'publicar ' + publishAt}). Revisa en el dashboard: /agents`);
  return `draft #${id} "${topic.title}" for ${publishAt}: ${files.length} files`;
};

export function factsOf(cfg: AgentSite, wt: string, capPerFile = 14000): { file: string; text: string }[] {
  return (cfg.factFiles ?? []).filter((file) => existsSync(join(wt, file))).map((file) => {
    const text = readFileSync(join(wt, file), 'utf8').replace(/\r\n/g, '\n');
    return { file, text: text.length > capPerFile ? text.slice(0, capPerFile) + '\n[cut]' : text };
  });
}

export function guidesOf(cfg: AgentSite, capPerFile = 14000, wt?: string): { file: string; text: string }[] {
  return (cfg.guideFiles ?? []).filter((file) => existsSync(join(wt ?? cfg.repo, file))).map((file) => {
    const text = readFileSync(join(wt ?? cfg.repo, file), 'utf8').replace(/\r\n/g, '\n');
    return { file, text: text.length > capPerFile ? text.slice(0, capPerFile) + '\n[cut]' : text };
  });
}

export async function researchFor(c: Ctx, topic: Draftable, brief: string, askFn: typeof ask = ask): Promise<string> {
  try {
    const key = `${c.site.id}|${topic.slug}|${topic.improve ? 'improve' : 'new'}`;
    const cached = c.db.prepare("SELECT text FROM research_cache WHERE key = ? AND created_at >= datetime('now', '-14 days')").get(key) as { text: string } | undefined;
    if (cached) return cached.text;
    const text = await askFn(c, { role: 'research', prompt: researchPrompt({ siteUrl: c.site.url, brief, title: topic.title, query: topic.query, audience: audienceBrief(new URL(c.site.url).hostname), improve: !!topic.improve }), cwd: tmpdir(), tools: ['WebSearch', 'WebFetch'], maxTurns: 4, timeoutMs: 900_000 });
    c.db.prepare("INSERT OR REPLACE INTO research_cache (key, site_id, slug, text, created_at) VALUES (?, ?, ?, ?, datetime('now'))").run(key, c.site.id, topic.slug, text);
    return text;
  } catch (e) {
    if (e instanceof LimitError) throw e;
    c.log(`research failed: ${e instanceof Error ? e.message : String(e)}`);
    return '';
  }
}

export function researchPlanOptions(research: string): { tools: string[]; maxTurns: number } {
  return { tools: research ? [] : ['WebSearch', 'WebFetch'], maxTurns: research ? 3 : 20 };
}

export async function draftTopicHybrid(c: Ctx, topic: Draftable, publishAt: string, s: ReturnType<typeof startDraft>, override: Partial<HybridDeps> = {}): Promise<string> {
  c.progress?.('preparing');
  const { cfg, branch, wt, merge, opts, brief } = s;
  if (!cfg.orderPaths) throw new Error('this site has no orderPaths configured for hybrid mode');
  const host = new URL(c.site.url).hostname.replace(/^www\./, '');
  const research = override.plan || process.env.AGENT_RESEARCH === '0' ? '' : topic.improve && structuralOnly(topic.reasons ?? []) ? NO_RESEARCH : await researchFor(c, topic, brief);
  if (research === NO_RESEARCH) c.log('research skipped: structural improve');
  const synced = syncWorktree(cfg, branch);
  c.log(`synced to ${cfg.remote}/main ${synced.head.slice(0, 7)}${synced.moved ? ' (moved)' : ''}`);
  const ranges = merge ? locatePost(cfg, wt, merge) : [];
  let typeDefs = '';
  try { if (cfg.typeFile) typeDefs = extractTypeDecls(readFileSync(join(wt, cfg.typeFile), 'utf8'), cfg.typeNames ?? []); } catch { /* no type context available */ }
  const links = linksOf(c.db, c.site.id);
  const planInput = {
    typeDefs, links,
    brief, research, priorFailure: c.priorFailure, neverWrite: cfg.neverWrite, miniAudit: MINI_AUDIT, rules: cfg.rules, writerRules: cfg.writerRules, audience: audience(c),
    facts: factsOf(cfg, wt), guides: guidesOf(cfg, 14000, wt),
    example: exampleOf(cfg, wt), current: merge ? currentOf(cfg, wt, merge) : '',
    ranges: ranges.map((r) => ({ file: r.file, anchor: r.anchor, endAnchor: r.endAnchor, whole: r.whole })),
    insertPoints: merge ? [] : insertPointsFor(host, wt, topic.slug), allowedPaths: cfg.orderPaths, derivedPaths: cfg.derivedPaths,
  } satisfies PlanInput;
  const prompt = planPrompt(planInput);
  const planReplies: string[] = [];
  let codexRuns = 0;
  const defaults: HybridDeps = {
    stage: (s, n) => c.progress?.(s as Stage, n),
    plan: async (p) => {
      const t = await ask(c, { role: 'plan', prompt: p, cwd: tmpdir(), ...researchPlanOptions(research), timeoutMs: 1_200_000 });
      c.log(`plan reply starts: ${t.slice(0, 160).replace(/\s+/g, ' ')}`);
      planReplies.push(t);
      return t;
    },
    revise: (p) => ask(c, { role: 'revise', prompt: p, cwd: tmpdir(), tools: [], maxTurns: 2, timeoutMs: 600_000 }),
    patch: (p) => ask(c, { role: 'revise', prompt: p, cwd: tmpdir(), tools: [], maxTurns: 2, timeoutMs: 300_000 }),
    execute: async (p) => {
      const t0 = Date.now();
      const r = await runCodex({ prompt: p, cwd: wt, write: true, timeoutMs: 900_000 });
      c.log(`codex [write, prompt ${Math.round(p.length / 1000)}k chars]: ${Math.round((Date.now() - t0) / 1000)}s, ${r.ok ? 'ok' : r.blocked ? 'BLOCKED' : r.limited ? 'LIMIT' : 'FAILED'}${r.error ? ': ' + r.error.slice(0, 200) : ''}`);
      codexRuns++;
      return r;
    },
    verify: makeVerify(cfg, wt, opts),
    lintText: (texts) => lintPlanText(texts.join('\n\n'), cfg, linkExists(cfg, links)),
    lint: () => {
      git(wt, 'add', '-A');
      git(wt, 'reset', '-q', '--', 'node_modules');
      const diff = git(wt, 'diff', '--cached');
      return [...lintDetails(diff, cfg.lintPaths, cfg.derivedPaths), ...lintAcceptance(diff, cfg, linkExists(cfg, links))];
    },
    addedText: () => {
      git(wt, 'add', '-A');
      git(wt, 'reset', '-q', '--', 'node_modules');
      return addedLines(git(wt, 'diff', '--cached')).join('\n');
    },
    diff: () => {
      git(wt, 'add', '-A');
      git(wt, 'reset', '-q', '--', 'node_modules');
      return git(wt, 'diff', '--cached', '-U25');
    },
    reviewDiff: () => {
      git(wt, 'add', '-A');
      git(wt, 'reset', '-q', '--', 'node_modules');
      return git(wt, 'diff', '--cached', '-U3');
    },
    review: async (orders, diff, previousProblems): Promise<Review> => {
      const filtered = stripDerived(diff, cfg.derivedPaths);
      const text = await ask(c, { role: 'review', prompt: reviewPrompt({ rules: cfg.rules, writerRules: cfg.writerRules, audience: audienceBrief(new URL(c.site.url).hostname), facts: planInput.facts, verified: twinFacts(cfg, wt, merge ?? topic.slug), orders, diff: filtered.diff, derivedNote: filtered.removed.join(', '), previousProblems }), cwd: tmpdir(), tools: [], maxTurns: 2, timeoutMs: 600_000 });
      const j = extractJson<{ ok?: boolean; blocking?: string[]; problems?: string[]; minor?: string[]; changeOrder?: unknown }>(text);
      const problems = (j.blocking ?? j.problems ?? []).map(String).filter((p) => !nonProblem(p));
      const minor = (j.minor ?? []).map(String);
      c.log(`review: ${j.ok === true && problems.length === 0 ? 'OK' : 'NOT OK: ' + problems.join(' | ').slice(0, 700)} (blocking: ${problems.length}, minor: ${minor.length})`);
      return { ok: j.ok === true && problems.length === 0, problems, minor, ...(j.changeOrder ? { changeOrder: stripOrderDerived(JSON.stringify(j.changeOrder), cfg.derivedPaths) } : {}) };
    },
    root: wt, log: c.log,
  };
  const deps = { ...defaults, ...override };
  const originalPlan = deps.plan, originalRevise = deps.revise;
  deps.plan = async (p) => stripOrderDerived(await originalPlan(p), cfg.derivedPaths);
  deps.revise = async (p) => stripOrderDerived(await originalRevise(p), cfg.derivedPaths);
  let result;
  try { result = await runHybrid(deps, { planPrompt: prompt, revisePrompt: slimPlanPrompt(planInput), patchContext: linksSection(links), rules: cfg.rules, allowedPaths: cfg.orderPaths, apply: process.env.AGENT_APPLY === 'codex' ? 'codex' : 'code' }); }
  catch (e) {
    git(wt, 'reset', '--hard');
    git(wt, 'clean', '-fd', '-e', 'node_modules');
    if (e instanceof HybridLimit) throw new LimitError(e.message);
    throw e;
  }
  let metaText = JSON.stringify({ slug: merge ?? topic.slug });
  for (const reply of planReplies) {
    try {
      const { meta } = extractJson<{ meta?: unknown }>(reply);
      if (meta && typeof meta === 'object' && !Array.isArray(meta)) { metaText = JSON.stringify(meta); break; }
    } catch { /* Try the next planner reply. */ }
  }
  c.progress?.('finishing');
  const out = await finishDraft(c, topic, publishAt, { cfg, branch, wt, merge }, metaText, null, { hybrid: {
    analysis: result.orders[0].analysis ?? '', plans: result.stages.plans, patches: result.stages.patches, revisions: result.stages.revisions,
    executions: result.stages.executions, reviews: result.stages.reviews, rounds: result.stages.rounds,
    reviewNotes: [...result.review.problems, ...(result.review.minor ?? [])],
  } });
  return `${out} | hybrid: ${result.stages.plans} plan, ${result.stages.patches} patch, ${result.stages.executions} codex, ${result.stages.reviews} review, ${result.stages.rounds} extra round(s)`;
}

async function draftTopic(c: Ctx, topic: Draftable, publishAt: string): Promise<string> {
  const s = startDraft(c, topic, publishAt);
  if (executorMode() === 'hybrid') return draftTopicHybrid(c, topic, publishAt, s);
  c.progress?.('working');
  const { cfg, branch, wt, merge, opts, brief } = s;
  const synced = syncWorktree(cfg, branch);
  c.log(`synced to ${cfg.remote}/main ${synced.head.slice(0, 7)}${synced.moved ? ' (moved)' : ''}`);
  const run = (extra = '') => ask(c, {
    cwd: wt, tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'WebSearch', 'WebFetch'], maxTurns: 45, timeoutMs: 1_800_000,
    prompt: `Eres el redactor de ${c.site.url}. ${brief}
Trabaja SOLO editando archivos en este repo (no ejecutes comandos). Investiga en la web fuentes primarias para cualquier dato no comercial y cítalas en \`sources\` (o en la sección de fuentes del post) solo si abriste la página.
${MINI_AUDIT}
${cfg.rules}
${cfg.writerRules}
${audience(c)}
Al terminar responde SOLO con JSON: {"slug":"...","enSlug":"...","claims":[{"claim":"afirmación factual del post","source":"archivo del repo o URL abierta"}]}
${extra}`,
  });
  const verify = makeVerify(cfg, wt, opts);
  let text = await run();
  let err = verify();
  if (err) { text = await run(`Los chequeos automáticos fallaron, corrige solo esto:\n${err}`); err = verify(); }
  c.progress?.('finishing');
  return finishDraft(c, topic, publishAt, { cfg, branch, wt, merge }, text, err);
};


// ---------- fixer ----------
export async function fixerHybridText(c: Ctx, o: { cfg: AgentSite; wt: string; list: any[]; picked: boolean }, override: Partial<HybridDeps> = {}): Promise<string> {
  c.progress?.('scouting');
  let scout: CodexResult;
  try { scout = await runCodex({ prompt: scoutPrompt(o.list.map((f) => ({ id: f.id, rule: f.rule_id, subject: f.subject, message: f.message })), ''), cwd: o.wt, write: false, timeoutMs: 600_000 }); }
  catch (e) { c.log('scout unavailable: ' + (e as Error).message); scout = { ok: false, limited: false, blocked: false, text: '' }; }
  if (scout.limited) throw new LimitError(scout.error ?? 'codex usage limit');
  const synced = syncWorktree(o.cfg, git(o.wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim());
  c.log(`synced to ${o.cfg.remote}/main ${synced.head.slice(0, 7)}${synced.moved ? ' (moved)' : ''}`);
  const scoutText = scout.ok ? scout.text : '';
  const planReplies: string[] = [];
  const planPrompt = fixerPlanPrompt({
    siteUrl: c.site.url, priorFailure: c.priorFailure, neverWrite: o.cfg.neverWrite,
    findings: o.list.map((f) => ({ id: f.id, rule: f.rule_id, severity: f.severity, subject: f.subject, message: f.message })),
    scout: scoutText || '(the scout found nothing; skip findings you cannot place with certainty)',
    rules: o.cfg.rules, guides: guidesOf(o.cfg, 14000, o.wt), audience: audience(c),
    allowedPathsNote: 'cualquier archivo del repo EXCEPTO pagos, checkout, emails, rutas de API, vercel.json, .env y package.json (están prohibidos)',
    picked: o.picked, derivedPaths: o.cfg.derivedPaths,
  });
  const defaults: HybridDeps = {
    stage: (s, n) => c.progress?.(s as Stage, n),
    plan: (p) => ask(c, { role: 'fixplan', prompt: p, cwd: tmpdir(), tools: ['WebSearch', 'WebFetch'], maxTurns: 12, timeoutMs: 1_200_000 }),
    revise: (p) => ask(c, { role: 'revise', prompt: p, cwd: tmpdir(), tools: [], maxTurns: 2, timeoutMs: 300_000 }),
    patch: (p) => ask(c, { role: 'revise', prompt: p, cwd: tmpdir(), tools: [], maxTurns: 2, timeoutMs: 300_000 }),
    execute: (p) => runCodex({ prompt: p, cwd: o.wt, write: true, timeoutMs: 900_000 }),
    verify: () => {
      const bad = changedFiles(o.wt).filter((f) => FORBIDDEN.test(f) && !pathAllowed(o.cfg.derivedPaths ?? [], f));
      if (bad.length) return `forbidden files were changed, revert them: ${bad.join(', ')}`;
      return typecheck(o.cfg);
    },
    lintText: (texts) => lintPlanText(texts.join('\n\n'), o.cfg),
    lint: () => {
      git(o.wt, 'add', '-A');
      git(o.wt, 'reset', '-q', '--', 'node_modules');
      const diff = git(o.wt, 'diff', '--cached');
      return [...lintDetails(diff, o.cfg.lintPaths, o.cfg.derivedPaths), ...lintAcceptance(diff, o.cfg)];
    },
    addedText: () => {
      git(o.wt, 'add', '-A');
      git(o.wt, 'reset', '-q', '--', 'node_modules');
      return addedLines(git(o.wt, 'diff', '--cached')).join('\n');
    },
    diff: () => {
      git(o.wt, 'add', '-A');
      git(o.wt, 'reset', '-q', '--', 'node_modules');
      return git(o.wt, 'diff', '--cached', '-U25');
    },
    reviewDiff: () => {
      git(o.wt, 'add', '-A');
      git(o.wt, 'reset', '-q', '--', 'node_modules');
      return git(o.wt, 'diff', '--cached', '-U3');
    },
    review: async (orders, diff, previousProblems): Promise<Review> => {
      const filtered = stripDerived(diff, o.cfg.derivedPaths);
      const text = await ask(c, { role: 'review', prompt: reviewPrompt({ rules: o.cfg.rules, writerRules: '', audience: audienceBrief(new URL(c.site.url).hostname), facts: [], verified: [], orders, diff: filtered.diff, derivedNote: filtered.removed.join(', '), previousProblems }), cwd: tmpdir(), tools: [], maxTurns: 2, timeoutMs: 300_000 });
      const j = extractJson<{ ok?: boolean; blocking?: string[]; problems?: string[]; minor?: string[]; changeOrder?: unknown }>(text);
      const problems = (j.blocking ?? j.problems ?? []).map(String).filter((p) => !nonProblem(p));
      const minor = (j.minor ?? []).map(String);
      c.log(`review: ${j.ok === true && problems.length === 0 ? 'OK' : 'NOT OK'} (blocking: ${problems.length}, minor: ${minor.length})`);
      return { ok: j.ok === true && problems.length === 0, problems, minor, ...(j.changeOrder ? { changeOrder: stripOrderDerived(JSON.stringify(j.changeOrder), o.cfg.derivedPaths) } : {}) };
    },
    root: o.wt, log: c.log,
  };
  const deps = { ...defaults, ...override };
  const originalPlan = deps.plan, originalRevise = deps.revise;
  deps.plan = async (p) => stripOrderDerived(await originalPlan(p), o.cfg.derivedPaths);
  deps.revise = async (p) => stripOrderDerived(await originalRevise(p), o.cfg.derivedPaths);
  const plan = deps.plan;
  deps.plan = async (p) => { const reply = await plan(p); planReplies.push(reply); return reply; };
  try { await runHybrid(deps, { planPrompt, rules: o.cfg.rules, allowedPaths: ['*'], apply: process.env.AGENT_APPLY === 'codex' ? 'codex' : 'code' }); }
  catch (e) {
    git(o.wt, 'reset', '--hard');
    git(o.wt, 'clean', '-fd', '-e', 'node_modules');
    if (e instanceof HybridLimit) throw new LimitError(e.message);
    throw e;
  }
  for (const reply of planReplies) {
    try {
      const { meta } = extractJson<{ meta?: { fixed?: unknown[]; skipped?: unknown[] } }>(reply);
      if (meta && typeof meta === 'object' && !Array.isArray(meta) && Array.isArray(meta.fixed)) {
        return JSON.stringify({ fixed: meta.fixed ?? [], skipped: meta.skipped ?? [] });
      }
    } catch { /* Try the next planner reply. */ }
  }
  return JSON.stringify({ fixed: [], skipped: [] });
}

export const fixerAgent: AgentFn = async (c) => {
  if (!c.cfg) throw new Error('no agent config for this site');
  const cfg = c.cfg;
  const ids = c.args?.ids; // set when the owner picked findings in the dashboard ("Fix now"); the scheduled run takes the worst 25
  const cols = 'id, rule_id, severity, subject, message', order = "ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, id";
  const list = (ids?.length
    ? c.db.prepare(`SELECT ${cols} FROM findings WHERE site_id = ? AND status = 'open' AND id IN (${ids.map(() => '?').join(',')}) ${order} LIMIT 40`).all(c.site.id, ...ids)
    : c.db.prepare(`SELECT ${cols} FROM findings WHERE site_id = ? AND status = 'open' AND severity IN ('critical','warn') ${order} LIMIT 25`).all(c.site.id)) as any[];
  if (!list.length) return ids ? 'those findings are no longer open' : 'no open critical/warn findings';
  if (!ids && (c.db.prepare("SELECT COUNT(*) n FROM approvals WHERE site_id = ? AND kind = 'fix' AND status = 'pending'").get(c.site.id) as { n: number }).n >= 1) return 'skipped: a fix batch is still waiting for approval';
  const autonomy = (c.db.prepare("SELECT autonomy FROM agent_settings WHERE agent = 'fixer' AND site_id = ?").get(c.site.id) as { autonomy: string } | undefined)?.autonomy ?? 'approve';
  const branch = ids ? `agent/fix-${mxNow().date}-${Date.now().toString(36)}` : `agent/fix-${mxNow().date}`; // a picked batch never overwrites an earlier pending branch
  const wt = prepareWorktree(cfg, branch);
  if (executorMode() !== 'hybrid') c.progress?.('working');
  const text = executorMode() === 'hybrid' ? await fixerHybridText(c, { cfg, wt, list, picked: !!ids }) : await ask(c, {
    cwd: wt, tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'], maxTurns: 40, timeoutMs: 1_800_000,
    prompt: `Eres el agente corrector SEO de ${c.site.url}. Estos son los hallazgos abiertos del Watchdog (datos reales, cada uno con la URL afectada):
${JSON.stringify(list)}
${ids ? 'El dueño eligió estos hallazgos: corrige TODOS los que se puedan arreglar con seguridad, empezando por los críticos.' : 'Corrige en el código de este repo hasta 5 de ellos, empezando por los críticos.'} Prefiere cambios en contenido (src/content/**). Cambios mínimos, uno por hallazgo, sin refactors. Si un hallazgo no se puede arreglar con seguridad (hace falta dato que no tienes, o toca pagos/checkout/emails/rutas), sáltalo y di por qué. No ejecutes comandos.
${cfg.rules}
Respeta el posicionamiento del brief (no cambies el enfoque de la marca, solo corrige lo técnico/SEO).${audience(c)}
Responde SOLO con JSON: {"fixed":[ids],"skipped":[{"id":n,"reason":"..."}]}`,
  });
  const files = changedFiles(wt);
  if (!files.length) { git(wt, 'reset', '--hard'); return `no changes (${text.slice(0, 200)})`; }
  const diff = git(wt, 'diff', '--cached');
  const forbidden = files.filter((f) => FORBIDDEN.test(f) && !pathAllowed(cfg.derivedPaths ?? [], f)), err = typecheck(cfg), lint = lintAdded(diff, cfg.lintPaths, cfg.derivedPaths);
  if (forbidden.length || err || lint.length) { git(wt, 'reset', '--hard'); throw new Error(`fix rejected by checks: ${[...forbidden.map((f) => `forbidden ${f}`), err ? `typecheck ${err.slice(0, 200)}` : '', ...lint].filter(Boolean).join('; ')}`); }
  const meta = (() => { try { return extractJson<{ fixed?: number[]; skipped?: unknown[] }>(text); } catch { return {} as { fixed?: number[]; skipped?: unknown[] }; } })();
  commit(wt, `seo(fix): ${meta.fixed?.length ?? files.length} watchdog findings\n\nFindings: ${(meta.fixed ?? []).join(', ')}`);
  const low = files.every((f) => pathAllowed(cfg.lowRiskPaths, f));
  if (autonomy === 'auto' && low) { pushAndVerify(cfg, []); void deployAfterPush(cfg); return `pushed ${files.length} low-risk files (${(meta.fixed ?? []).length} findings)`; }
  const id = approvalFor(c, 'fix', `Fix ${meta.fixed?.length ?? files.length} findings (${files.length} files${low ? '' : ', touches code outside content'})`, { branch, files, fixed: meta.fixed ?? [], skipped: meta.skipped ?? [], urls: [] }, diff);
  await sendAlert(`🔧 Lote de correcciones listo para aprobar (#${id}, ${files.length} archivos). Revisa en el dashboard: /agents`);
  return `fix batch approval #${id}: ${files.length} files`;
};

// ---------- publish ----------
/** Fast-forward the owner's own checkout to the remote main after a push, so local and GitHub stay identical. Never throws, never forces: if the checkout is on another branch, has diverged or has overlapping edits, it is left alone and a warning is logged. */
export function syncOwnerCheckout(cfg: Pick<AgentSite, 'repo' | 'remote'>): void {
  try {
    if (git(cfg.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim() !== 'main') return console.warn(`[sync] ${cfg.repo}: not on main, left alone`);
    git(cfg.repo, 'merge', '--ff-only', `${cfg.remote}/main`);
  } catch (e) { console.warn(`[sync] ${cfg.repo} not updated: ${String((e as any).stderr ?? (e as Error).message ?? e).slice(0, 200)}`); }
}

/** Rebase onto the latest main, typecheck, push. Throws on any conflict or failure; never force-pushes. */
export function pushAndVerify(cfg: AgentSite, _urls: string[], post?: PostOpts): void {
  const wt = cfg.worktree;
  gitRemote(cfg, 'fetch', cfg.remote, 'main');
  try { git(wt, 'rebase', `${cfg.remote}/main`); }
  catch (e) {
    if (!resolveDerivedConflict(cfg, post) && !(cfg.unionPaths && post && resolveRebaseByUnion(cfg, post))) {
    try { git(wt, 'rebase', '--abort'); } catch { /* none in progress */ }
    // Sites with generated pages (Dizayn SEO): two drafts made from the same base both rewrite the same one-line pages, so git cannot merge them.
    // Re-apply only the draft's SOURCE change on the latest main and regenerate everything else.
    if (!cfg.regenerateFrom || !post || !cfg.postEdit) throw new Error(`rebase conflict: ${String((e as any).stderr ?? e).slice(0, 300)}`);
    regenerateOnLatest(cfg, post);
    }
  }
  const err = typecheck(cfg); if (err) throw new Error(`typecheck after rebase: ${err.slice(0, 300)}`);
  gitRemote(cfg, 'push', cfg.remote, 'HEAD:main');
  try { git(cfg.worktree, 'update-ref', `refs/remotes/${cfg.remote}/main`, 'HEAD'); }
  catch (e) { console.warn(`[sync] ${cfg.worktree} remote ref not updated: ${String((e as any).stderr ?? (e as Error).message ?? e).slice(0, 200)}`); }
  syncOwnerCheckout(cfg);
}

/** Runs cfg.deployCmd after a push to main. Never throws: returns a short status for the approval note. The token only goes to the child env and is redacted from every message. */
export async function deployAfterPush(cfg: AgentSite, run: typeof execFile = execFile): Promise<string> {
  if (!cfg.deployCmd) return '';
  const token = process.env[cfg.deployTokenEnv ?? ''];
  const redact = (text: string) => token ? text.split(token).join('<token>') : text;
  let hostname = '';
  let result: string;
  try {
    hostname = new URL(cfg.liveBase).hostname;
    if (!token) {
      result = `deploy skipped: ${cfg.deployTokenEnv} not set`;
      try { await sendAlert(redact(`🚀 ${hostname}: pushed to main but NOT deployed: set ${cfg.deployTokenEnv} in SEO-Watchdog/.env, or run ${cfg.deployCmd[0]} with VERCEL_TOKEN set.`)); } catch { /* alert is best effort */ }
    } else {
      try {
        await new Promise<void>((resolve, reject) => {
          run(cfg.deployCmd![0], cfg.deployCmd!.slice(1), { cwd: cfg.repo, env: { ...process.env, VERCEL_TOKEN: token }, timeout: 600_000, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(String(stderr || stdout || err.message))); else resolve();
          });
        });
        result = 'deployed';
      } catch (e) {
        result = `deploy failed: ${redact(String((e as Error)?.message ?? e)).slice(-200)}`;
        try { await sendAlert(redact(`🚀 ${hostname}: deploy FAILED after push: ${result}`)); } catch { /* alert is best effort */ }
      }
    }
  } catch (e) {
    result = `deploy failed: ${redact(String((e as Error)?.message ?? e)).slice(-200)}`;
  }
  result = redact(result);
  console.log(`[deploy] ${redact(hostname)}: ${result}`);
  return result;
}

/** A rebase stopped only on generated files (e.g. Luvory's one-line blog-index.json, rewritten by every post): keep main's copy, regenerate from the merged sources, continue. */
export function resolveDerivedConflict(cfg: AgentSite, post?: PostOpts): boolean {
  const wt = cfg.worktree;
  try {
    if (!post || !cfg.postEdit || !cfg.derivedPaths?.length) return false;
    for (let i = 0; i < 5; i++) {
      const bad = git(wt, 'diff', '--name-only', '--diff-filter=U', '-z').split('\0').filter(Boolean);
      if (!bad.length || !bad.every((f) => pathAllowed(cfg.derivedPaths!, f))) return false;
      for (const f of bad) git(wt, 'checkout', '--ours', '--', f);
      cfg.postEdit(wt, post);
      git(wt, 'add', '-A'); git(wt, 'reset', '-q', '--', 'node_modules');
      try { execFileSync('git', ['rebase', '--continue'], { cwd: wt, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true' } }); return true; }
      catch { /* the next commit stopped on another conflict: go round again */ }
    }
    return false;
  } catch { return false; }
}

/** Find an equivalent insertion using the surrounding draft context. */
export function placeInsertion(draftLines: string[], start: number, count: number, mainLines: string[]): { index: number; block: string[] } | null {
  const block = draftLines.slice(start, start + count);
  if (!block.length) return null;
  // every equivalent position of the block (identical lines let git slide it): slide up to the first, then collect downwards
  while (start > 0 && draftLines[start - 1] === block.at(-1)) { block.unshift(block.pop()!); start--; }
  const candidates: { start: number; block: string[] }[] = [];
  for (;;) {
    candidates.push({ start, block: [...block] });
    if (start + count >= draftLines.length || draftLines[start + count] !== block[0]) break;
    block.push(block.shift()!); start++;
  }
  const end = mainLines.length - (mainLines.at(-1) === '' ? 1 : 0);
  for (const c of candidates.reverse()) { // the position closest to the end of the file first
    const before = draftLines.slice(Math.max(0, c.start - 4), c.start);
    const after = draftLines.slice(c.start + count, c.start + count + 4);
    const last = after.length ? mainLines.length - before.length - after.length : end - before.length;
    for (let j = last; j >= 0; j--) {
      if (!after.length && j + before.length !== end) break;
      if (before.every((line, i) => mainLines[j + i] === line) && after.every((line, i) => mainLines[j + before.length + i] === line)) {
        return { index: j + before.length, block: c.block };
      }
    }
  }
  // tiny files (few lines before the insertion): the lines after the highest position are enough, last occurrence
  const top = candidates[0], tail = draftLines.slice(top.start + count, top.start + count + 4);
  if (tail.length) {
    for (let j = mainLines.length - tail.length; j >= 0; j--) {
      if (tail.every((line, i) => mainLines[j + i] === line)) return { index: j, block: top.block };
    }
  }
  return null;
}

/** Resolve append-only conflicts while replaying a draft on the latest main. */
export function resolveRebaseByUnion(cfg: AgentSite, post: PostOpts): boolean {
  const wt = cfg.worktree, main = `${cfg.remote}/main`;
  let draft: string | undefined;
  try {
    try { git(wt, 'rebase', '--abort'); } catch { /* none in progress */ }
    draft = git(wt, 'rev-parse', 'HEAD').trim();
    const base = git(wt, 'merge-base', 'HEAD', main).trim();
    const subject = git(wt, 'log', '-1', '--format=%s').trim();
    if (git(wt, 'rev-list', `${base}..HEAD`, '--count').trim() !== '1') return false;
    const files = git(wt, 'diff', '--name-only', '-z', base, 'HEAD').split('\0').filter(Boolean);
    const replayed = new Map<string, string>(), regenerated: string[] = [];
    for (const file of files) {
      if (pathAllowed(cfg.derivedPaths ?? [], file)) { regenerated.push(file); continue; }
      if (!pathAllowed(cfg.unionPaths ?? [], file)) return false;
      const diff = git(wt, 'diff', '-U0', base, 'HEAD', '--', file);
      const hunks = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)];
      if (!hunks.length || hunks.some((h) => Number(h[2] ?? 1) !== 0)) return false;
      const draftLines = git(wt, 'show', `HEAD:${file}`).split('\n');
      const mainLines = git(wt, 'show', `${main}:${file}`).split('\n');
      for (const h of hunks.reverse()) {
        const start = Number(h[3]) - 1;
        const count = Number(h[4] ?? 1);
        const placement = placeInsertion(draftLines, start, count, mainLines);
        if (!placement) { console.log(`[agents] refused insertion replay: no matching context in ${file}`); return false; }
        mainLines.splice(placement.index, 0, ...placement.block);
      }
      replayed.set(file, mainLines.join('\n'));
    }
    const branch = git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    try { git(wt, 'branch', '-f', `backup/${branch}-${Date.now()}`, draft); } catch { /* best effort */ }
    git(wt, 'reset', '--hard', main);
    for (const [file, content] of replayed) writeFileSync(join(wt, file), content);
    if (cfg.postEdit) cfg.postEdit(wt, post);
    git(wt, 'add', '-A'); git(wt, 'reset', '-q', '--', 'node_modules');
    commit(wt, subject);
    if (post.slug) {
      const file = (cfg.unionPaths ?? []).find((f) => existsSync(join(wt, f)));
      const slug = post.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (file && (readFileSync(join(wt, file), 'utf8').match(new RegExp(`\\bslug\\s*:\\s*(["'])${slug}\\1`, 'g')) ?? []).length > 1) {
        git(wt, 'reset', '--hard', draft);
        return false;
      }
    }
    console.log(`[agents] replayed insertions: ${[...replayed.keys()].join(', ') || 'none'}; regenerated: ${regenerated.join(', ') || 'none'}`);
    return true;
  } catch {
    if (draft) { try { git(wt, 'reset', '--hard', draft); } catch { /* best effort */ } }
    return false;
  }
}

/** The draft branch is checked out. Rebuild it on top of the latest main: take what the writer changed under `cfg.regenerateFrom`, apply it, regenerate, commit. */
function regenerateOnLatest(cfg: AgentSite, post: PostOpts): void {
  const wt = cfg.worktree, main = `${cfg.remote}/main`;
  const branch = git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const base = git(wt, 'merge-base', 'HEAD', main).trim();
  const source = execFileSync('git', ['diff', base, 'HEAD', '--', ...cfg.regenerateFrom!], { cwd: wt, encoding: 'utf8', maxBuffer: 64 << 20 });
  const subject = git(wt, 'log', '-1', '--format=%s').trim();
  git(wt, 'reset', '--hard'); git(wt, 'checkout', '-B', branch, main);
  try { execFileSync('git', ['apply', '--3way', '--whitespace=nowarn'], { cwd: wt, input: source, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (e) { git(wt, 'reset', '--hard'); throw new Error(`source conflict with a newer change to the same post: draft it again (${String((e as any).stderr ?? e).slice(0, 200)})`); }
  try { cfg.postEdit!(wt, post); } catch (e) { git(wt, 'reset', '--hard'); throw new Error(`regeneration failed: ${String((e as any).stderr ?? (e as Error).message).slice(0, 300)}`); }
  git(wt, 'add', '-A'); git(wt, 'reset', '-q', '--', 'node_modules');
  commit(wt, `${subject} (regenerated on the latest main)`);
}

async function waitLive(urls: string[], marker?: string, timeoutMs = 900_000, everyMs = 30_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const ok = await Promise.all(urls.map((u) => fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(30_000) }).then(async (r) => r.status === 200 && (!marker || (await r.text()).includes(marker))).catch(() => false)));
    if (ok.every(Boolean)) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

/** IndexNow without a per-site script: the key file in the repo proves the key, the watchdog posts the URLs. */
export async function submitIndexNow(cfg: AgentSite, urls: string[]): Promise<string> {
  const keyFile = join(cfg.worktree, cfg.indexnowKey!);
  const key = readFileSync(keyFile, 'utf8').trim();
  const host = new URL(cfg.liveBase).host;
  const r = await fetch('https://api.indexnow.org/indexnow', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ host, key, keyLocation: `${cfg.liveBase}/${key}.txt`, urlList: urls }) });
  if (!r.ok && r.status !== 202) throw new Error(`IndexNow HTTP ${r.status}`);
  return `IndexNow ${r.status}`;
}

/** Approved item -> main -> wait for the REAL deploy (200 on the live URL) -> only then ping IndexNow. */
export async function publish(db: DatabaseSync, approvalId: number): Promise<string> {
  const a = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as any;
  if (!a || a.status !== 'approved') throw new Error(`approval ${approvalId} is not in 'approved' state`);
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(a.site_id) as Site;
  const cfg = AGENT_SITES[new URL(site.url).hostname.replace(/^www\./, '')];
  const p = JSON.parse(a.payload_json);
  console.log(`[publish #${a.id}] start: ${a.title}`);
  try {
    if (!cfg) throw new Error('no agent config for this site');
    git(cfg.worktree, 'checkout', p.branch);
    const clamped = clampFutureDates(cfg.worktree, `${cfg.remote}/main`, p.publishAt); if (clamped) console.log(`[publish #${a.id}] ${clamped} future date line(s) set to today`);
    pushAndVerify(cfg, p.urls, a.kind === 'post' ? { slug: p.slug, improve: a.title.startsWith('Improve:'), merge: a.title.startsWith('Improve:') || a.title.startsWith('Update:') ? p.slug : null } : undefined);
    console.log(`[publish #${a.id}] pushed; confirming the deploy in the background`);
    if (cfg.deployHint && !cfg.deployCmd) await sendAlert(`📤 ${a.title}: ${cfg.deployHint}`);
    // The push is the only step that needs the shared worktree. Waiting for Vercel (minutes) must not hold up the next publish,
    // so the live check, IndexNow and the final status run detached. A restart before it finishes simply repeats it (the push is a no-op).
    void (async () => {
      let note = 'pushed';
      try {
        const dep = await deployAfterPush(cfg);
        if (p.urls?.length) {
          const mins = cfg.liveTimeoutMin ?? 15;
          const live = await waitLive(p.urls.slice(0, 1), p.marker, mins * 60_000, mins > 15 ? 120_000 : 30_000); // the ES page carries the marker; EN follows the same deploy
          note = live ? 'live (200)' : `pushed, but not live after ${mins >= 120 ? Math.round(mins / 60) + ' h' : mins + ' min'}: ${cfg.deployHint ?? 'check Vercel'}`;
          if (live && cfg.indexnow) { try { sh(cfg.worktree, cfg.indexnow[0], [...cfg.indexnow.slice(1), ...p.urls]); note += ', IndexNow sent'; } catch (e) { note += `, IndexNow failed: ${String(e).slice(0, 120)}`; } }
          if (live && cfg.indexnowKey) { try { note += `, ${await submitIndexNow(cfg, p.urls)}`; } catch (e) { note += `, IndexNow failed: ${String(e).slice(0, 120)}`; } }
        }
        note = (dep ? dep + '; ' : '') + note;
        db.prepare("UPDATE approvals SET status = 'published', note = ?, decided_at = datetime('now') WHERE id = ?").run(note, a.id);
        if (p.topicId) db.prepare("UPDATE topics SET status = 'published' WHERE id = ?").run(p.topicId);
        console.log(`[publish #${a.id}] ${note}`);
        await sendAlert(`✅ Publicado: ${a.title} (${note})`);
      } catch (e) { console.error(`[publish #${a.id}] finalize failed:`, e); }
    })();
    return 'pushed';
  } catch (e) {
    db.prepare("UPDATE approvals SET status = 'failed', note = ? WHERE id = ?").run(String(e).slice(0, 500), a.id);
    await sendAlert(`❌ Falló la publicación #${a.id}: ${String(e).slice(0, 200)}`);
    throw e;
  }
}

export const AGENTS: Record<string, AgentFn> = { crawl: crawlAgent, collect: collectAgent, analyst: analystAgent, researcher: researcherAgent, writer: writerAgent, fixer: fixerAgent, improver: improverAgent };
export const LLM_AGENTS = new Set(['analyst', 'researcher', 'writer', 'fixer', 'improver']);
