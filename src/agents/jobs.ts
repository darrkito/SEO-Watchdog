import type { DatabaseSync } from 'node:sqlite';

export type Stage = 'preparing' | 'scouting' | 'planning' | 'checking-order' | 'building' | 'checking' | 'reviewing' | 'revising' | 'finishing' | 'working';
export const STAGE_LABEL: Record<Stage, string> = { preparing: 'Preparing the workspace', scouting: 'Codex is locating the code', planning: 'Claude is researching and writing the order', 'checking-order': 'Checking the order against the real files', building: 'Codex is building', checking: 'Running automatic checks', reviewing: 'Claude is reviewing the result', revising: 'Claude is writing the corrections', finishing: 'Saving the draft for your approval', working: 'Working' };
type Step = { at: string; stage: string; note: string };
export type Job = { id: number; kind: 'running' | 'waiting' | 'failed' | 'recent'; agent: string; siteId: number; detail: string; label: string; stage?: Stage; stageLabel?: string; note?: string; startedAt?: string; elapsedSec?: number; position?: number; attempts: number; error?: string; status?: string; output?: string; steps: Step[]; queueId?: number; runId?: number };

function stepsOf(value: unknown): Step[] {
  try { const parsed = JSON.parse(String(value ?? '[]')); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
export function setStage(db: DatabaseSync, runId: number, stage: Stage, note = ''): void {
  const row = db.prepare("SELECT progress, datetime('now') AS now FROM agent_runs WHERE id = ?").get(runId) as { progress: string | null; now: string } | undefined;
  if (!row) return;
  const steps = [...stepsOf(row.progress), { at: row.now, stage, note }].slice(-80);
  db.prepare('UPDATE agent_runs SET stage = ?, progress = ? WHERE id = ?').run(stage, JSON.stringify(steps), runId);
}
export function jobLabel(db: DatabaseSync, siteId: number, agent: string, detail: string): string {
  try {
    if (!detail) return agent;
    if (detail.startsWith('topic:')) return (db.prepare('SELECT title FROM topics WHERE id = ?').get(Number(detail.slice(6))) as { title: string } | undefined)?.title || detail;
    if (detail.startsWith('ids:')) { const n = detail.slice(4).split(',').filter(Boolean).length; return `${n} issue${n === 1 ? '' : 's'} to fix`; }
    return (db.prepare("SELECT json_extract(s.extract_json, '$.h1[0]') AS h1 FROM snapshots s JOIN pages p ON p.id = s.page_id WHERE p.site_id = ? AND p.url LIKE '%/blog/' || ? AND s.run_id = (SELECT id FROM runs WHERE site_id = ? AND status = 'ok' ORDER BY id DESC LIMIT 1) LIMIT 1").get(siteId, detail, siteId) as { h1: string | null } | undefined)?.h1 || detail;
  } catch { return detail || agent; }
}
export function listJobs(db: DatabaseSync, siteId?: number): { running: Job[]; waiting: Job[]; failed: Job[]; recent: Job[] } {
  const filter = siteId === undefined ? '' : ' AND r.site_id = ?';
  const params = siteId === undefined ? [] : [siteId];
  const runs = (condition: string, suffix = '') => db.prepare(`SELECT r.*, q.id AS queue_id, q.attempts AS queue_attempts FROM agent_runs r LEFT JOIN agent_queue q ON q.agent = r.agent AND q.site_id = r.site_id AND q.slug = COALESCE(r.detail, '') WHERE ${condition}${filter} ${suffix}`).all(...params) as any[];
  const runJob = (r: any, kind: 'running' | 'recent'): Job => {
    const steps = stepsOf(r.progress).slice(-12).reverse();
    const stage = r.stage as Stage | null;
    const job: Job = { id: r.id, kind, agent: r.agent, siteId: r.site_id, detail: r.detail ?? '', label: jobLabel(db, r.site_id, r.agent, r.detail ?? ''), attempts: r.queue_attempts ?? 0, runId: r.id, steps };
    if (r.queue_id != null) job.queueId = r.queue_id;
    if (stage) { job.stage = stage; job.stageLabel = STAGE_LABEL[stage]; }
    if (steps.length) job.note = steps[0].note;
    if (r.started_at) { job.startedAt = r.started_at; job.elapsedSec = Math.max(0, Math.floor((Date.now() - Date.parse(r.started_at.replace(' ', 'T') + 'Z')) / 1000)); }
    if (kind === 'recent') { job.status = r.status; if (r.output) job.output = r.output.slice(0, 200); if (r.error) job.error = r.error.slice(0, 200); }
    return job;
  };
  const queue = (state: string, order: string) => db.prepare(`SELECT * FROM agent_queue WHERE state = ?${siteId === undefined ? '' : ' AND site_id = ?'} ORDER BY id ${order}`).all(state, ...params) as any[];
  const queueJob = (q: any, kind: 'waiting' | 'failed'): Job => ({ id: q.id, queueId: q.id, kind, agent: q.agent, siteId: q.site_id, detail: q.slug, label: jobLabel(db, q.site_id, q.agent, q.slug), attempts: q.attempts, steps: [], ...(kind === 'failed' ? { error: q.last_error ?? '' } : {}) });
  return {
    running: runs("r.status = 'running'", 'ORDER BY r.id').map((r) => runJob(r, 'running')),
    // Keep in sync with scheduler's MAX_AUTO_ATTEMPTS; importing it would create a cycle.
    waiting: queue('queued', 'ASC').map((q, i) => ({ ...queueJob(q, 'waiting'), position: i + 1, ...(q.attempts > 0 && q.last_error ? { note: `retrying automatically (attempt ${Math.min(q.attempts + 1, 3)} of 3): ${q.last_error.slice(0, 160)}` } : {}) })),
    failed: queue('failed', 'DESC').map((q) => queueJob(q, 'failed')),
    recent: runs("r.status IN ('ok','failed','limited') AND r.agent IN ('improver','writer','fixer')", 'ORDER BY r.id DESC LIMIT 10').map((r) => runJob(r, 'recent')),
  };
}
