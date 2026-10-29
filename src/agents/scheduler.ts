// In-process scheduler. One job at a time (shared with the dashboard's crawls) because live trading bots share this Pi.
import type { DatabaseSync } from 'node:sqlite';
import { findSite, type Site } from '../db.ts';
import { sendAlert } from '../alert.ts';
import { AGENTS, LimitError, mxNow, publish, type Ctx } from './agents.ts';
import { setStage } from './jobs.ts';
import { parseLimitReset } from './runner.ts';
import { AGENT_SITES, type AgentSite } from './sites.ts';

export const cfgOf = (site: Site): AgentSite | undefined => AGENT_SITES[new URL(site.url).hostname.replace(/^www\./, '')];
export const capable = (site: Site, agent: string): boolean => !!cfgOf(site)?.capabilities.includes(agent);

// Mexico City time. dow: 0 = Sunday.
export const SCHEDULE: { agent: string; days: number[]; at: string }[] = [
  { agent: 'crawl', days: [0, 1, 2, 3, 4, 5, 6], at: '06:00' },
  { agent: 'collect', days: [0, 1, 2, 3, 4, 5, 6], at: '06:15' },
  { agent: 'analyst', days: [0, 1, 2, 3, 4, 5, 6], at: '06:30' },
  { agent: 'fixer', days: [0, 1, 2, 3, 4, 5, 6], at: '07:30' },
  { agent: 'researcher', days: [0], at: '18:00' },
  { agent: 'writer', days: [0, 2], at: '20:00' }, // drafts for Monday and Wednesday
];
export const ALL_AGENTS = SCHEDULE.map((s) => s.agent);

let chain: Promise<unknown> = Promise.resolve();
/** Run `job` after everything queued before it. Never rejects the chain. */
export function serial<T>(job: () => Promise<T>): Promise<T> {
  const p = chain.then(job);
  chain = p.catch((e) => console.error(e));
  return p;
}

export type Hist = { ok: boolean; failed: number; lastAtMs: number | null };
/** Due = today's slot time has passed (within 10 h), not done, not given up (2 failures), and not retried within 30 min. */
export function isDue(e: { days: number[]; at: string }, now: { hm: string; dow: number }, h: Hist, nowMs = Date.now()): boolean {
  if (!e.days.includes(now.dow) || now.hm < e.at || h.ok || h.failed >= 2) return false;
  const [hh, mm] = e.at.split(':').map(Number), [nh, nm] = now.hm.split(':').map(Number);
  if (nh * 60 + nm - (hh * 60 + mm) > 600) return false;
  return h.lastAtMs == null || nowMs - h.lastAtMs >= 30 * 60_000;
}

/** The global switch ("Pause all agents"): nothing new starts, clicked jobs stay in the queue, nothing is cancelled. */
export const isPaused = (db: DatabaseSync): boolean => (db.prepare("SELECT enabled FROM agent_settings WHERE agent = '*' AND site_id = 0").get() as { enabled: number } | undefined)?.enabled === 0;

export const isEnabled = (db: DatabaseSync, agent: string, siteId: number): boolean => {
  const g = db.prepare("SELECT enabled FROM agent_settings WHERE agent = '*' AND site_id = 0").get() as { enabled: number } | undefined;
  if (g && !g.enabled) return false;
  return !!(db.prepare('SELECT enabled FROM agent_settings WHERE agent = ? AND site_id = ?').get(agent, siteId) as { enabled: number } | undefined)?.enabled;
};

/** Hosts with an agent config that are also watched sites. */
export function agentSites(db: DatabaseSync): Site[] {
  return Object.keys(AGENT_SITES).map((h) => findSite(db, h)).filter((s): s is Site => !!s && s.kind === 'own');
}

export function seedSettings(db: DatabaseSync): void {
  db.prepare("INSERT OR IGNORE INTO agent_settings (agent, site_id, enabled, autonomy) VALUES ('*', 0, 1, 'approve')").run();
  for (const s of agentSites(db)) for (const a of ALL_AGENTS.filter((x) => capable(s, x))) db.prepare('INSERT OR IGNORE INTO agent_settings (agent, site_id, enabled, autonomy) VALUES (?, ?, 1, ?)').run(a, s.id, 'approve');
  db.prepare("UPDATE agent_runs SET status = 'failed', error = 'interrupted by restart', finished_at = datetime('now') WHERE status = 'running'").run();
}

const queued = new Set<string>();
let limitRetryMs = 30 * 60_000;
let limitedUntil = 0;
export const limitedUntilMs = (): number => limitedUntil;
export const setLimitedUntil = (ms: number): void => { limitedUntil = ms; };
export const limitStatus = (): { until: number | null } => ({ until: Date.now() < limitedUntil ? limitedUntil : null });
export const MAX_AUTO_ATTEMPTS = 3;
export const failureSignature = (s: string): string => s.toLowerCase().replace(/[0-9]+/g, '#').replace(/\s+/g, ' ').slice(0, 120);
export let autoRetryMs = 120_000;
export const setAutoRetry = (ms: number): void => { autoRetryMs = ms; };
/** Test hook: how long a clicked job waits after the usage limit before it runs again. */
export const setLimitRetry = (ms: number): void => { limitRetryMs = ms; };
/** Agent jobs running or waiting in line right now, as `agent:siteId:detail` (the dashboard shows them so a click is never silent). */
export const inFlight = (): string[] => [...queued];
/** Execute one agent for one site and record the outcome (tokens, status, output). */
export function runAgent(db: DatabaseSync, agent: string, site: Site, slot: string | null = null, args?: { slug?: string; ids?: number[]; topicId?: number }): Promise<void> {
  const detail = args?.slug ?? (args?.ids ? `ids:${args.ids.join(',')}` : args?.topicId != null ? `topic:${args.topicId}` : '');
  const key = `${agent}:${site.id}:${detail}`;
  if (queued.has(key)) return Promise.resolve();
  if (slot === null) {
    db.prepare('INSERT OR IGNORE INTO agent_queue (agent, site_id, slug) VALUES (?, ?, ?)').run(agent, site.id, detail);
    db.prepare("UPDATE agent_queue SET state = 'queued', attempts = 0, last_error = NULL, updated_at = datetime('now') WHERE agent = ? AND site_id = ? AND slug = ? AND state = 'failed'").run(agent, site.id, detail);
  }
  if (isPaused(db)) return Promise.resolve(); // parked: the row stays, resume restores it
  queued.add(key);
  let limited = false, retry = false, parked = false, status = 'failed';
  return serial(async () => {
    if (isPaused(db)) { parked = true; return; } // paused while this waited in line: step aside, keep the queue row
    if (Date.now() < limitedUntil) { parked = true; limited = slot === null; return; }
    const id = Number(db.prepare('INSERT INTO agent_runs (agent, site_id, slot, detail) VALUES (?, ?, ?, ?)').run(agent, site.id, slot, detail || null).lastInsertRowid);
    if (slot === null) db.prepare("UPDATE agent_queue SET state = 'running', attempts = attempts + 1, updated_at = datetime('now') WHERE agent = ? AND site_id = ? AND slug = ?").run(agent, site.id, detail);
    const q = slot === null ? db.prepare('SELECT attempts, last_error FROM agent_queue WHERE agent = ? AND site_id = ? AND slug = ?').get(agent, site.id, detail) as { attempts: number; last_error: string | null } | undefined : undefined;
    const ctx: Ctx = { db, site, cfg: cfgOf(site), usage: [], log: (m) => console.log(`[${agent} ${site.url}] ${m}`), args, priorFailure: q && q.attempts > 1 ? q.last_error ?? undefined : undefined };
    ctx.progress = (s, n) => setStage(db, id, s, n);
    status = 'ok';
    let output = '', error: string | null = null;
    try { ctx.progress('working'); output = await AGENTS[agent](ctx); }
    catch (e) { status = e instanceof LimitError ? 'limited' : 'failed'; error = String((e as Error).message ?? e).slice(0, 1000); }
    db.prepare("UPDATE agent_runs SET finished_at = datetime('now'), status = ?, tokens_in = ?, tokens_out = ?, cost_usd = ?, output = ?, error = ? WHERE id = ?")
      .run(status, ctx.usage.reduce((a, u) => a + u.tokensIn, 0), ctx.usage.reduce((a, u) => a + u.tokensOut, 0), ctx.usage.reduce((a, u) => a + u.costUsd, 0), output.slice(0, 20_000), error, id);
    retry = slot === null && status === 'failed' && (q?.attempts ?? 0) < MAX_AUTO_ATTEMPTS && !(q && q.attempts > 1 && q.last_error !== null && error !== null && failureSignature(q.last_error) === failureSignature(error));
    if (slot === null && status !== 'ok') db.prepare("UPDATE agent_queue SET state = ?, last_error = ?, updated_at = datetime('now') WHERE agent = ? AND site_id = ? AND slug = ?").run(status === 'limited' || retry ? 'queued' : 'failed', status === 'limited' ? q?.last_error ?? 'waiting for the usage limit to reset' : error?.slice(0, 500) ?? '', agent, site.id, detail);
    if (status === 'failed' && !retry) await sendAlert(`⚠️ Agente ${agent} falló en ${site.url}: ${error?.slice(0, 200)}`);
    if (status === 'limited') { limitedUntil = Math.max(limitedUntil, parseLimitReset(error ?? '', new Date()) ?? Date.now() + limitRetryMs); limited = slot === null; console.log(`[${agent}] usage limit reached; retry after ${new Date(limitedUntil).toISOString()}`); }
  }).catch((e) => console.error(`[${agent}]`, e)).finally(() => {
    if (limited || retry) {
      // A clicked job must not vanish when the Claude session limit is hit: keep its queue row (survives a restart) and its dedupe key, try again later.
      setTimeout(() => { queued.delete(key); void runAgent(db, agent, site, null, args); }, limited ? Math.max(limitedUntil - Date.now(), 1000) : autoRetryMs).unref();
      return;
    }
    queued.delete(key);
    if (!parked && status === 'ok' && slot === null) db.prepare('DELETE FROM agent_queue WHERE agent = ? AND site_id = ? AND slug = ?').run(agent, site.id, detail);
  });
}

export function tick(db: DatabaseSync, now = mxNow(), nowMs = Date.now()): void {
  for (const site of agentSites(db)) for (const e of SCHEDULE) {
    if (!capable(site, e.agent) || !isEnabled(db, e.agent, site.id)) continue;
    const slot = `${e.agent}:${now.date}:${e.at}`;
    const rows = db.prepare('SELECT status, started_at FROM agent_runs WHERE agent = ? AND site_id = ? AND slot = ?').all(e.agent, site.id, slot) as { status: string; started_at: string }[];
    if (rows.some((r) => r.status === 'running')) continue;
    const h: Hist = { ok: rows.some((r) => r.status === 'ok'), failed: rows.filter((r) => r.status === 'failed').length,
      lastAtMs: rows.length ? Math.max(...rows.map((r) => Date.parse(r.started_at.replace(' ', 'T') + 'Z'))) : null };
    if (isDue(e, now, h, nowMs)) void runAgent(db, e.agent, site, slot);
  }
}

/** Approve/reject from the dashboard. Approve queues the publish on the same serial chain. */
export function decide(db: DatabaseSync, id: number, action: 'approve' | 'reject'): void {
  const a = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as { status: string; payload_json: string } | undefined;
  if (!a || a.status !== 'pending') throw new Error('That item is no longer pending.');
  const p = JSON.parse(a.payload_json);
  db.prepare("UPDATE approvals SET status = ?, decided_at = datetime('now') WHERE id = ?").run(action === 'approve' ? 'approved' : 'rejected', id);
  if (action === 'reject' && p.topicId) db.prepare("UPDATE topics SET status = 'rejected' WHERE id = ?").run(p.topicId);
  if (action === 'approve') void serial(() => publish(db, id)).catch((e) => console.error(`publish #${id}:`, e));
}

/** Clicked jobs that a restart interrupted, a pause parked or a limit delayed: run them again, in click order (paused: they stay put). */
export function resumeQueued(db: DatabaseSync): number {
  let n = 0;
  for (const q of db.prepare("SELECT * FROM agent_queue WHERE state IN ('queued','running') ORDER BY id").all() as { agent: string; site_id: number; slug: string }[]) {
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(q.site_id) as Site | undefined;
    if (!site || !AGENTS[q.agent] || queued.has(`${q.agent}:${q.site_id}:${q.slug}`)) continue;
    n++; void runAgent(db, q.agent, site, null, queueArgs(q.slug));
  }
  return n;
}

const queueArgs = (slug: string): { slug?: string; ids?: number[]; topicId?: number } | undefined =>
  slug.startsWith('ids:') ? { ids: slug.slice(4).split(',').map(Number) } : slug.startsWith('topic:') ? { topicId: Number(slug.slice(6)) } : slug ? { slug } : undefined;

export function retryQueued(db: DatabaseSync, queueId: number): void {
  const q = db.prepare("SELECT * FROM agent_queue WHERE id = ? AND state = 'failed'").get(queueId) as { agent: string; site_id: number; slug: string } | undefined;
  if (!q) return;
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(q.site_id) as Site | undefined;
  if (!site || !AGENTS[q.agent]) return;
  db.prepare("UPDATE agent_queue SET state = 'queued', attempts = 0, last_error = NULL, updated_at = datetime('now') WHERE id = ? AND state = 'failed'").run(queueId);
  void runAgent(db, q.agent, site, null, queueArgs(q.slug));
}

export function dismissQueued(db: DatabaseSync, queueId: number): void {
  db.prepare("DELETE FROM agent_queue WHERE id = ? AND state = 'failed'").run(queueId);
}

export function retryAllFailed(db: DatabaseSync, siteId?: number): number {
  const rows = (siteId === undefined ? db.prepare("SELECT id FROM agent_queue WHERE state = 'failed' ORDER BY id").all() : db.prepare("SELECT id FROM agent_queue WHERE state = 'failed' AND site_id = ? ORDER BY id").all(siteId)) as { id: number }[];
  let count = 0;
  for (const row of rows) { retryQueued(db, row.id); if ((db.prepare('SELECT state FROM agent_queue WHERE id = ?').get(row.id) as { state: string } | undefined)?.state !== 'failed') count++; }
  return count;
}

export function startScheduler(db: DatabaseSync): void {
  seedSettings(db);
  // Approved but never published (a restart dropped the in-memory publish): publish them now, oldest first.
  for (const a of db.prepare("SELECT id FROM approvals WHERE status = 'approved' ORDER BY id").all() as { id: number }[]) void serial(() => publish(db, a.id)).catch((e) => console.error(`publish #${a.id}:`, e));
  resumeQueued(db);
  setTimeout(() => tick(db), 10_000);
  setInterval(() => tick(db), 60_000).unref();
}
