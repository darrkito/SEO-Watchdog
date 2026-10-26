// Dashboard "Agents" tab: what each agent did, what waits for approval, and the controls (pause, autonomy, run now, kill switch).
import type { DatabaseSync } from 'node:sqlite';
import { h, raw, layout, chip, ago, type Html, type Sev } from '../html.ts';
import { SCHEDULE, ALL_AGENTS, agentSites, decide, runAgent } from './scheduler.ts';
import { LLM_AGENTS } from './agents.ts';
import { blogScores } from './blogscore.ts';
import type { Site } from '../db.ts';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const when = (a: string) => { const e = SCHEDULE.find((s) => s.agent === a)!; return `${e.days.length === 7 ? 'daily' : e.days.map((d) => DAYS[d]).join(' + ')} ${e.at} (Mexico City)`; };
const LABEL: Record<string, string> = { improver: 'Post improver', crawl: 'Site check', collect: 'Data collector (Search Console + Bing)', analyst: 'Analyst', fixer: 'Fixer', researcher: 'Topic researcher', writer: 'Writer (Mon + Wed posts)' };
/** Slugs already being reworked (draft waiting) or reworked in the last 14 days: don't queue them again. */
const recentlyImproved = (db: DatabaseSync, siteId: number): Set<string> => new Set((db.prepare("SELECT json_extract(payload_json, '$.slug') slug FROM approvals WHERE site_id = ? AND title LIKE 'Improve:%' AND status != 'rejected' AND created_at >= datetime('now', '-14 days')").all(siteId) as { slug: string }[]).map((r) => r.slug));

const blogSection = (db: DatabaseSync, s: Site): Html => {
  const rows = blogScores(db, s), done = recentlyImproved(db, s.id);
  if (!rows.length) return h`<p class="muted small">No blog posts crawled yet.</p>`;
  const tone = (n: number): Sev => (n >= 75 ? 'good' : n >= 55 ? 'warn' : 'critical');
  const avg = Math.round(rows.reduce((a, r) => a + r.score, 0) / rows.length);
  return h`<h2>Blog quality · ${new URL(s.url).hostname}</h2>
    <p class="muted small">Score 0-100 per post: structure (length, FAQ, schema, title, description, H1, internal links) and Google visibility. Average ${avg}. One click sends a post to the writer, which fixes exactly the listed reasons and leaves a draft for you to approve.</p>
    <form method="post" action="/agents/improve-low" style="margin-bottom:10px"><input type="hidden" name="site" value="${s.id}"><button class="btn primary">Improve the 3 lowest</button></form>
    <div class="card" style="overflow-x:auto"><table><thead><tr><th class="num">Score</th><th>Post</th><th>Why it scores low</th><th class="num">Google 90d</th><th></th></tr></thead><tbody>
    ${rows.slice(0, 25).map((r) => h`<tr><td class="num">${chip(tone(r.score), String(r.score))}</td>
      <td><a href="${r.url}" target="_blank" rel="noopener">${r.title}</a></td><td class="small">${r.reasons.join('. ') || 'Nothing to fix'}</td>
      <td class="num small">${r.impressions ? `${r.impressions} views · ${r.clicks} clicks` : '-'}</td>
      <td>${done.has(r.slug) ? h`<span class="muted small">In progress / done</span>` : h`<form method="post" action="/agents/improve"><input type="hidden" name="site" value="${s.id}"><input type="hidden" name="slug" value="${r.slug}"><button class="btn link">Improve</button></form>`}</td></tr>`)}
    </tbody></table>${rows.length > 25 ? h`<p class="muted small">Showing the 25 lowest of ${rows.length}.</p>` : ''}</div>`;
};

const sev = (s: string): Sev => (s === 'ok' ? 'good' : s === 'failed' ? 'critical' : s === 'limited' ? 'warn' : 'info');

export function agentsPage(db: DatabaseSync, msg?: { error?: string; ok?: string }): string {
  const killed = (db.prepare("SELECT enabled FROM agent_settings WHERE agent = '*' AND site_id = 0").get() as { enabled: number } | undefined)?.enabled === 0;
  const sites = agentSites(db);
  const pending = db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id").all() as any[];
  const week = db.prepare("SELECT agent, COUNT(*) runs, SUM(tokens_in) tin, SUM(tokens_out) tout, ROUND(SUM(cost_usd),2) cost, SUM(status != 'ok') bad FROM agent_runs WHERE started_at >= datetime('now', '-7 days') GROUP BY agent").all() as any[];
  const runs = db.prepare('SELECT * FROM agent_runs ORDER BY id DESC LIMIT 20').all() as any[];
  const done = db.prepare("SELECT * FROM approvals WHERE status != 'pending' ORDER BY id DESC LIMIT 8").all() as any[];
  const topics = db.prepare("SELECT * FROM topics WHERE status = 'new' ORDER BY score DESC, id LIMIT 10").all() as any[];
  const fmt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n ?? 0));

  const approval = (a: any) => { const p = JSON.parse(a.payload_json); return h`<div class="card" style="margin-bottom:12px">
    <div class="row"><h3>${chip('info', a.kind === 'post' ? 'Post' : 'Fix')} ${a.title}</h3><span class="muted small">${ago(a.created_at)}</span></div>
    ${p.publishAt ? h`<p class="small">Scheduled for <b>${p.publishAt}</b>. Files: ${(p.files ?? []).join(', ')}</p>` : h`<p class="small">Files: ${(p.files ?? []).join(', ')}</p>`}
    ${p.claims?.length ? h`<details><summary class="small">Facts the writer relied on (${p.claims.length})</summary><ul class="urls">${p.claims.map((c: any) => h`<li><span class="u">${c.claim}<br><span class="m">${c.source}</span></span></li>`)}</ul></details>` : ''}
    <details><summary class="small">Diff</summary><pre style="overflow-x:auto;font-size:12px;max-height:520px">${a.diff.slice(0, 60_000)}</pre></details>
    <div class="row" style="justify-content:flex-start;margin-top:8px">
      <form method="post" action="/agents/decide"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="action" value="approve"><button class="btn primary">Approve and publish</button></form>
      <form method="post" action="/agents/decide"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="action" value="reject"><button class="btn">Reject</button></form></div></div>`; };

  const agentRow = (siteId: number, a: string) => {
    const last = db.prepare('SELECT * FROM agent_runs WHERE agent = ? AND site_id = ? ORDER BY id DESC LIMIT 1').get(a, siteId) as any;
    const st = db.prepare('SELECT enabled, autonomy FROM agent_settings WHERE agent = ? AND site_id = ?').get(a, siteId) as { enabled: number; autonomy: string } | undefined;
    return h`<tr><td><b>${LABEL[a]}</b><br><span class="muted small">${when(a)}</span></td>
      <td>${last ? h`${chip(sev(last.status), last.status)} <span class="muted small">${ago(last.finished_at ?? last.started_at)}</span>` : h`<span class="muted small">never</span>`}</td>
      <td><form method="post" action="/agents/toggle"><input type="hidden" name="agent" value="${a}"><input type="hidden" name="site" value="${siteId}"><input type="hidden" name="enabled" value="${st?.enabled ? 0 : 1}"><button class="btn link">${st?.enabled ? 'On (pause)' : 'Paused (resume)'}</button></form></td>
      <td>${a === 'fixer' ? h`<form method="post" action="/agents/autonomy"><input type="hidden" name="agent" value="${a}"><input type="hidden" name="site" value="${siteId}">
          <select name="autonomy" aria-label="Fixer autonomy" onchange="this.form.submit()">${['approve', 'auto'].map((v) => h`<option value="${v}" ${v === st?.autonomy ? raw('selected') : ''}>${v === 'approve' ? 'Ask me first' : 'Auto-publish low-risk'}</option>`)}</select></form>`
        : a === 'writer' ? h`<span class="muted small">Ask me first</span>` : ''}</td>
      <td><form method="post" action="/agents/run"><input type="hidden" name="agent" value="${a}"><input type="hidden" name="site" value="${siteId}"><button class="btn link">Run now</button></form></td></tr>`;
  };

  return layout('Agents', h`<p class="small"><a href="/">← All sites</a></p>
    <h1>Agents</h1>
    <p class="muted">Run on your Claude subscription, never the API. One job at a time, lowest CPU priority.</p>
    ${msg?.error ? h`<div class="banner warn">${msg.error}</div>` : ''}${msg?.ok ? h`<div class="banner info">${msg.ok}</div>` : ''}
    <div class="card row">${killed ? h`<span>${chip('critical', 'All agents stopped')}</span>` : h`<span>${chip('good', 'Fleet running')}</span>`}
      <form method="post" action="/agents/kill"><input type="hidden" name="enabled" value="${killed ? 1 : 0}"><button class="btn ${killed ? 'primary' : ''}">${killed ? 'Resume all agents' : 'Stop all agents'}</button></form></div>
    <h2>Waiting for you${pending.length ? ` (${pending.length})` : ''}</h2>
    ${pending.length ? pending.map(approval) : h`<div class="card empty">Nothing to approve.</div>`}
    ${sites.map((s) => h`<h2>${new URL(s.url).hostname}</h2><div class="card" style="overflow-x:auto"><table><thead><tr><th>Agent</th><th>Last run</th><th>Status</th><th>Autonomy</th><th></th></tr></thead><tbody>
      ${ALL_AGENTS.map((a) => agentRow(s.id, a))}</tbody></table></div>${blogSection(db, s)}`)}
    <h2>Usage, last 7 days</h2>
    <div class="card" style="overflow-x:auto">${week.length ? h`<table><thead><tr><th>Agent</th><th class="num">Runs</th><th class="num">Tokens in</th><th class="num">Tokens out</th><th class="num">List-price value</th><th class="num">Not ok</th></tr></thead><tbody>
      ${week.map((w) => h`<tr><td>${LABEL[w.agent] ?? w.agent}</td><td class="num">${w.runs}</td><td class="num">${fmt(w.tin)}</td><td class="num">${fmt(w.tout)}</td><td class="num">${LLM_AGENTS.has(w.agent) ? `$${w.cost}` : '-'}</td><td class="num">${w.bad || ''}</td></tr>`)}</tbody></table>
      <p class="muted small">Subscription usage: nothing is billed per token. "List-price value" is what the same tokens would cost on the API, to compare weeks.</p>` : h`<p class="muted small">No runs yet.</p>`}</div>
    <h2>Topic backlog</h2>
    <div class="card">${topics.length ? h`<ul class="urls">${topics.map((t) => h`<li><span class="u"><b>${t.title}</b> ${t.action !== 'new' ? chip('info', t.action) : ''}<br><span class="m">${t.query ? `“${t.query}” · ` : ''}${t.why}</span></span><span class="m">score ${t.score}</span></li>`)}</ul>` : h`<p class="muted small">Empty. The researcher fills it on Sundays.</p>`}</div>
    <h2>Recent runs</h2>
    <div class="card"><ul class="urls">${runs.map((r) => h`<li><span class="u"><details><summary>${chip(sev(r.status), r.status)} ${LABEL[r.agent] ?? r.agent} <span class="muted small">· ${ago(r.started_at)} · ${fmt(r.tokens_in)} in / ${fmt(r.tokens_out)} out</span></summary>
      <pre style="white-space:pre-wrap;font-size:12px">${r.error ?? ''}${r.output ?? ''}</pre></details></span></li>`)}</ul></div>
    ${done.length ? h`<h2>Decided</h2><div class="card"><ul class="urls">${done.map((a) => h`<li><span class="u">${a.title}<br><span class="m">${a.note ?? ''}</span></span>${chip(a.status === 'published' ? 'good' : a.status === 'failed' ? 'critical' : 'info', a.status)}</li>`)}</ul></div>` : ''}`);
}

/** Form handlers. Throw a plain-language Error on bad input. */
export function agentsPost(db: DatabaseSync, action: string, form: URLSearchParams): string {
  const agent = form.get('agent') ?? '', site = Number(form.get('site'));
  const known = () => { if (!ALL_AGENTS.includes(agent) || !agentSites(db).some((s) => s.id === site)) throw new Error('Unknown agent or site.'); };
  if (action === 'kill') { db.prepare("INSERT INTO agent_settings (agent, site_id, enabled) VALUES ('*', 0, ?) ON CONFLICT(agent, site_id) DO UPDATE SET enabled = excluded.enabled").run(form.get('enabled') === '1' ? 1 : 0); return form.get('enabled') === '1' ? 'Agents resumed.' : 'All agents stopped.'; }
  if (action === 'decide') { const id = Number(form.get('id')), a = form.get('action'); if (a !== 'approve' && a !== 'reject') throw new Error('Bad action.'); decide(db, id, a); return a === 'approve' ? 'Approved. Publishing now: it goes live after the deploy is confirmed.' : 'Rejected.'; }
  if (action !== 'improve' && action !== 'improve-low') known();
  if (action === 'toggle') { db.prepare('UPDATE agent_settings SET enabled = ? WHERE agent = ? AND site_id = ?').run(form.get('enabled') === '1' ? 1 : 0, agent, site); return `${LABEL[agent]} ${form.get('enabled') === '1' ? 'resumed' : 'paused'}.`; }
  if (action === 'autonomy') {
    const v = form.get('autonomy'); if (agent !== 'fixer' || (v !== 'approve' && v !== 'auto')) throw new Error('Only the fixer has an autonomy setting.');
    db.prepare('UPDATE agent_settings SET autonomy = ? WHERE agent = ? AND site_id = ?').run(v, agent, site); return `Fixer: ${v === 'auto' ? 'auto-publishes low-risk content fixes' : 'asks you first'}.`;
  }
  if (action === 'improve' || action === 'improve-low') {
    const s = agentSites(db).find((x) => x.id === site); if (!s) throw new Error('Unknown site.');
    const rows = blogScores(db, s), done = recentlyImproved(db, s.id);
    const slugs = action === 'improve' ? [form.get('slug') ?? ''] : rows.filter((r) => !done.has(r.slug)).slice(0, 3).map((r) => r.slug);
    if (slugs.some((x) => !rows.some((r) => r.slug === x))) throw new Error('That post is not in the latest crawl.');
    for (const slug of slugs) void runAgent(db, 'improver', s, null, { slug });
    return `Queued ${slugs.length} post${slugs.length === 1 ? '' : 's'} for the writer. Each draft shows up under "Waiting for you" in a few minutes.`;
  }
  if (action === 'run') { void runAgent(db, agent, db.prepare('SELECT * FROM sites WHERE id = ?').get(site) as any); return `${LABEL[agent]} queued.`; }
  throw new Error('Unknown action.');
}
