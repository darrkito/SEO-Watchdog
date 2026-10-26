// In-process scheduler. One job at a time (shared with the dashboard's crawls) because live trading bots share this Pi.
import type { DatabaseSync } from 'node:sqlite';
import { findSite, type Site } from '../db.ts';
import { sendAlert } from '../alert.ts';
import { AGENTS, LimitError, mxNow, publish, type Ctx } from './agents.ts';
import { AGENT_SITES } from './sites.ts';

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
  for (const s of agentSites(db)) for (const a of ALL_AGENTS) db.prepare('INSERT OR IGNORE INTO agent_settings (agent, site_id, enabled, autonomy) VALUES (?, ?, 1, ?)').run(a, s.id, 'approve');
  db.prepare("UPDATE agent_runs SET status = 'failed', error = 'interrupted by restart', finished_at = datetime('now') WHERE status = 'running'").run();
}

const queued = new Set<string>();
/** Execute one agent for one site and record the outcome (tokens, status, output). */
export function runAgent(db: DatabaseSync, agent: string, site: Site, slot: string | null = null, args?: { slug?: string }): Promise<void> {
  const key = `${agent}:${site.id}:${args?.slug ?? ''}`;
  if (queued.has(key)) return Promise.resolve();
  queued.add(key);
  return serial(async () => {
    const id = Number(db.prepare('INSERT INTO agent_runs (agent, site_id, slot) VALUES (?, ?, ?)').run(agent, site.id, slot).lastInsertRowid);
    const ctx: Ctx = { db, site, cfg: AGENT_SITES[new URL(site.url).hostname.replace(/^www\./, '')], usage: [], log: (m) => console.log(`[${agent} ${site.url}] ${m}`), args };
    let status = 'ok', output = '', error: string | null = null;
    try { output = await AGENTS[agent](ctx); }
    catch (e) { status = e instanceof LimitError ? 'limited' : 'failed'; error = String((e as Error).message ?? e).slice(0, 1000); }
    db.prepare("UPDATE agent_runs SET finished_at = datetime('now'), status = ?, tokens_in = ?, tokens_out = ?, cost_usd = ?, output = ?, error = ? WHERE id = ?")
      .run(status, ctx.usage.reduce((a, u) => a + u.tokensIn, 0), ctx.usage.reduce((a, u) => a + u.tokensOut, 0), ctx.usage.reduce((a, u) => a + u.costUsd, 0), output.slice(0, 20_000), error, id);
    if (status === 'failed') await sendAlert(`⚠️ Agente ${agent} falló en ${site.url}: ${error?.slice(0, 200)}`);
    if (status === 'limited') console.log(`[${agent}] usage limit reached; will retry in 30 min`);
  }).catch((e) => console.error(`[${agent}]`, e)).finally(() => queued.delete(key));
}

export function tick(db: DatabaseSync, now = mxNow(), nowMs = Date.now()): void {
  for (const site of agentSites(db)) for (const e of SCHEDULE) {
    if (!isEnabled(db, e.agent, site.id)) continue;
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

export function startScheduler(db: DatabaseSync): void {
  seedSettings(db);
  setTimeout(() => tick(db), 10_000);
  setInterval(() => tick(db), 60_000).unref();
}
