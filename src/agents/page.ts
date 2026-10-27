// Dashboard "Agents" tab: what each agent did, what waits for approval, and the controls (pause, autonomy, run now, kill switch).
import type { DatabaseSync } from 'node:sqlite';
import { h, raw, layout, chip, ago, type Html, type Sev } from '../html.ts';
import { SCHEDULE, ALL_AGENTS, agentSites, decide, runAgent, inFlight, cfgOf, capable } from './scheduler.ts';
import { LLM_AGENTS } from './agents.ts';
import { blogScores } from './blogscore.ts';
import { TARGET, type Segment } from './audience.ts';
import type { Site } from '../db.ts';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const when = (a: string) => { const e = SCHEDULE.find((s) => s.agent === a)!; return `${e.days.length === 7 ? 'daily' : e.days.map((d) => DAYS[d]).join(' + ')} ${e.at} (Mexico City)`; };
const LABEL: Record<string, string> = { improver: 'Post improver', crawl: 'Site check', collect: 'Data collector (Search Console + Bing)', analyst: 'Analyst', fixer: 'Fixer', researcher: 'Topic researcher', writer: 'Writer (Mon + Wed posts)' };
/** Slugs already being reworked (draft waiting) or reworked in the last 14 days: don't queue them again. */
const recentlyImproved = (db: DatabaseSync, siteId: number): Set<string> => new Set((db.prepare("SELECT json_extract(payload_json, '$.slug') slug FROM approvals WHERE site_id = ? AND title LIKE 'Improve:%' AND status != 'rejected' AND created_at >= datetime('now', '-14 days')").all(siteId) as { slug: string }[]).map((r) => r.slug));

const SEG: Record<Segment, string> = { event: 'Event (target)', planner: 'Planners (target)', 'corporate-event': 'Company event (target)', bulk: 'Bulk / industrial', labels: 'Labels & stickers', other: '-' };
const blogSection = (db: DatabaseSync, s: Site, all: boolean, short: string): Html => {
  const rows = blogScores(db, s), done = recentlyImproved(db, s.id);
  const working = new Set(inFlight().filter((k) => k.startsWith(`improver:${s.id}:`)).map((k) => k.split(':').slice(2).join(':')));
  const waiting = new Map((db.prepare("SELECT id, json_extract(payload_json, '$.slug') slug FROM approvals WHERE site_id = ? AND status = 'pending' AND title LIKE 'Improve:%'").all(s.id) as { id: number; slug: string }[]).map((r) => [r.slug, r.id]));
  if (!rows.length) return h`<p class="muted small">No blog posts crawled yet.</p>`;
  const tone = (n: number): Sev => (n >= 75 ? 'good' : n >= 55 ? 'warn' : 'critical');
  const avg = Math.round(rows.reduce((a, r) => a + r.score, 0) / rows.length);
  return h`<h2 id="blogs">Blog quality · ${new URL(s.url).hostname}</h2>
    <p class="muted small">Score 0-100 per post (the owner's target customers are marked): structure (length, FAQ, schema, title, description, H1, internal links) and Google visibility. Average ${avg}. One click sends a post to the writer, which fixes exactly the listed reasons and leaves a draft for you to approve.</p>
    <div class="row" style="justify-content:flex-start;margin-bottom:10px">
      <form method="post" action="/agents/improve-low"><input type="hidden" name="site" value="${s.id}"><input type="hidden" name="target" value="1"><button class="btn primary">Improve the 3 lowest event posts</button></form>
      <form method="post" action="/agents/improve-low"><input type="hidden" name="site" value="${s.id}"><button class="btn">Improve the 3 lowest (any)</button></form></div>
    <div class="card" style="overflow-x:auto"><table><thead><tr><th class="num">Score</th><th>Post</th><th>Speaks to</th><th>Why it scores low</th><th class="num">Google 90d</th><th></th></tr></thead><tbody>
    ${(all ? rows : rows.slice(0, 25)).map((r) => h`<tr><td class="num">${chip(tone(r.score), String(r.score))}</td>
      <td><a href="${r.url}" target="_blank" rel="noopener">${r.title}</a></td><td class="small">${TARGET.has(r.segment) ? chip('good', SEG[r.segment]) : SEG[r.segment]}</td><td class="small">${r.reasons.join('. ') || 'Nothing to fix'}</td>
      <td class="num small">${r.impressions ? `${r.impressions} views · ${r.clicks} clicks` : '-'}</td>
      <td>${working.has(r.slug) ? chip('info', 'Working on it…') : waiting.has(r.slug) ? h`<a class="small" href="#approval-${waiting.get(r.slug)}">Draft waiting for you ↓</a>` : done.has(r.slug) ? h`<span class="muted small">Improved recently</span>` : h`<form method="post" action="/agents/improve"><input type="hidden" name="site" value="${s.id}"><input type="hidden" name="slug" value="${r.slug}"><button class="btn link">Improve</button></form>`}</td></tr>`)}
    </tbody></table>${rows.length > 25 ? h`<p class="muted small">${all ? `Showing all ${rows.length}.` : `Showing the 25 lowest of ${rows.length}.`} <a href="/agents/${short}?${all ? '' : 'all=1'}#blogs">${all ? 'Show only the 25 lowest' : `Show all ${rows.length}`}</a></p>` : ''}</div>`;
};

/** "Fix now": queue the fixer for the picked findings (or every open critical/warn one). It prepares a change; approval still decides what goes live. */
export function queueFix(db: DatabaseSync, siteId: number, picked: number[] | 'all'): string {
  const site = agentSites(db).find((x) => x.id === siteId);
  if (!site || !capable(site, 'fixer')) throw new Error('The fix agent is not enabled for this site yet.');
  const open = db.prepare("SELECT id, severity FROM findings WHERE site_id = ? AND status = 'open' ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, id").all(siteId) as { id: number; severity: string }[];
  const ids = (picked === 'all' ? open.filter((f) => f.severity !== 'info') : open.filter((f) => picked.includes(f.id))).map((f) => f.id);
  if (!ids.length) throw new Error(picked === 'all' ? 'There is nothing to fix: no open critical or warning issues.' : 'Select at least one open issue first.');
  const batch = ids.slice(0, 40);
  void runAgent(db, 'fixer', site, null, { ids: batch });
  return `Fixer queued for ${batch.length} issue${batch.length === 1 ? '' : 's'}${ids.length > batch.length ? ` (the first 40 of ${ids.length}: click again when it finishes)` : ''}. It prepares the change in about 2 to 3 minutes and shows it under "Waiting for you" for you to approve.`;
}

const sev = (s: string): Sev => (s === 'ok' ? 'good' : s === 'failed' ? 'critical' : s === 'limited' ? 'warn' : 'info');

const fmt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n ?? 0));
const hostOf = (s: Site) => new URL(s.url).hostname;

function approvalCard(a: any, siteName?: string): Html {
  const p = JSON.parse(a.payload_json);
  return h`<div class="card" id="approval-${a.id}" style="margin-bottom:12px">
    <div class="row"><h3>${chip('info', a.kind === 'post' ? 'Post' : a.kind === 'page' ? 'Page' : 'Fix')} ${a.title}</h3><span class="muted small">${siteName ? `${siteName} · ` : ''}#${a.id} · ${ago(a.created_at)}</span></div>
    ${p.urls?.[0] ? h`<p class="small">Post being changed: <a href="${p.urls[0]}" target="_blank" rel="noopener">${p.urls[0]}</a></p>` : ''}
    ${p.publishAt ? h`<p class="small">Scheduled for <b>${p.publishAt}</b>. Files: ${(p.files ?? []).join(', ')}</p>` : h`<p class="small">Files: ${(p.files ?? []).join(', ')}</p>`}
    ${p.claims?.length ? h`<details><summary class="small">Facts the writer relied on (${p.claims.length})</summary><ul class="urls">${p.claims.map((c: any) => h`<li><span class="u">${c.claim}<br><span class="m">${c.source}</span></span></li>`)}</ul></details>` : ''}
    <details><summary class="small">Diff</summary><pre style="overflow-x:auto;font-size:12px;max-height:520px">${a.diff.slice(0, 60_000)}</pre></details>
    <div class="row" style="justify-content:flex-start;margin-top:8px">
      <form method="post" action="/agents/decide"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="action" value="approve"><button class="btn primary">Approve and publish</button></form>
      <form method="post" action="/agents/decide"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="action" value="reject"><button class="btn">Reject</button></form></div></div>`;
}

/** "Working now" banner for the given sites (all when none given), naming the post or issues being worked on. */
function workingBanner(db: DatabaseSync, only?: number): Html | '' {
  const items = inFlight().map((k) => { const [agent, siteId, ...d] = k.split(':'); return { agent, siteId: Number(siteId), slug: d.join(':') }; }).filter((i) => only == null || i.siteId === only);
  if (!items.length) return '';
  const label = items.map(({ agent, siteId, slug }) => {
    const site = agentSites(db).find((x) => x.id === siteId);
    const topic = slug.startsWith('topic:') ? (db.prepare('SELECT title FROM topics WHERE id = ?').get(Number(slug.slice(6))) as { title: string } | undefined) : undefined;
    const row = slug && !slug.startsWith('ids:') && !topic && site ? blogScores(db, site).find((r) => r.slug === slug) : null;
    return `${LABEL[agent] ?? agent}${only == null && site ? ` (${cfgOf(site)?.short})` : ''}${slug.startsWith('ids:') ? `: ${slug.slice(4).split(',').length} issue(s)` : slug ? `: ${topic?.title ?? row?.title ?? slug}` : ''}`;
  }).join(' · ');
  return h`<div class="banner info"><b>Working now:</b> ${label}. This page refreshes by itself; a draft appears under "Waiting for you" (newest first) when it is ready.</div>`;
}

function killCard(db: DatabaseSync): Html {
  const killed = (db.prepare("SELECT enabled FROM agent_settings WHERE agent = '*' AND site_id = 0").get() as { enabled: number } | undefined)?.enabled === 0;
  return h`<div class="card row">${killed ? h`<span>${chip('critical', 'All agents stopped')}</span>` : h`<span>${chip('good', 'Fleet running')}</span>`}
    <form method="post" action="/agents/kill"><input type="hidden" name="enabled" value="${killed ? 1 : 0}"><button class="btn ${killed ? 'primary' : ''}">${killed ? 'Resume all agents' : 'Stop all agents'}</button></form></div>`;
}

const runsList = (db: DatabaseSync, siteId?: number): Html => {
  const runs = (siteId == null ? db.prepare('SELECT * FROM agent_runs ORDER BY id DESC LIMIT 20').all() : db.prepare('SELECT * FROM agent_runs WHERE site_id = ? ORDER BY id DESC LIMIT 20').all(siteId)) as any[];
  return h`<h2>Recent runs</h2><div class="card"><ul class="urls">${runs.length ? runs.map((r) => h`<li><span class="u"><details><summary>${chip(sev(r.status), r.status)} ${LABEL[r.agent] ?? r.agent} <span class="muted small">· ${ago(r.started_at)} · ${fmt(r.tokens_in)} in / ${fmt(r.tokens_out)} out</span></summary>
    <pre style="white-space:pre-wrap;font-size:12px">${r.error ?? ''}${r.output ?? ''}</pre></details></span></li>`) : h`<li class="muted small">No runs yet.</li>`}</ul></div>`;
};

const decidedList = (db: DatabaseSync, siteId?: number): Html | '' => {
  const done = (siteId == null ? db.prepare("SELECT * FROM approvals WHERE status != 'pending' ORDER BY id DESC LIMIT 8").all() : db.prepare("SELECT * FROM approvals WHERE status != 'pending' AND site_id = ? ORDER BY id DESC LIMIT 8").all(siteId)) as any[];
  return done.length ? h`<h2>Decided</h2><div class="card"><ul class="urls">${done.map((a) => h`<li><span class="u">${a.title}<br><span class="m">${a.note ?? ''}</span></span>${chip(a.status === 'published' ? 'good' : a.status === 'failed' ? 'critical' : 'info', a.status)}</li>`)}</ul></div>` : '';
};

/** Overview of the whole fleet: global controls, everything waiting for approval, one card per site, and token usage. */
export function agentsPage(db: DatabaseSync, msg?: { error?: string; ok?: string }): string {
  const sites = agentSites(db);
  const pending = db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id DESC").all() as any[];
  const week = db.prepare("SELECT agent, COUNT(*) runs, SUM(tokens_in) tin, SUM(tokens_out) tout, ROUND(SUM(cost_usd),2) cost, SUM(status != 'ok') bad FROM agent_runs WHERE started_at >= datetime('now', '-7 days') GROUP BY agent").all() as any[];
  const nameOf = (id: number) => { const s = sites.find((x) => x.id === id); return s ? cfgOf(s)?.short : undefined; };
  const card = (s: Site) => {
    const cfg = cfgOf(s)!, c = (q: string) => (db.prepare(q).get(s.id) as { n: number }).n;
    const last = db.prepare("SELECT * FROM agent_runs WHERE site_id = ? AND status != 'running' ORDER BY id DESC LIMIT 1").get(s.id) as any;
    return h`<a class="card site-card" href="/agents/${cfg.short}"><div class="row"><span class="host">${cfg.label}</span></div>
      <div class="verdict">${c("SELECT COUNT(*) n FROM approvals WHERE site_id = ? AND status = 'pending'") ? chip('warn', `${c("SELECT COUNT(*) n FROM approvals WHERE site_id = ? AND status = 'pending'")} waiting for you`) : chip('good', 'Nothing waiting')}
        ${c("SELECT COUNT(*) n FROM findings WHERE site_id = ? AND status = 'open' AND severity != 'info'")} open issues</div>
      <div class="muted small">Last run: ${last ? `${LABEL[last.agent] ?? last.agent} ${last.status} ${ago(last.finished_at ?? last.started_at)}` : 'never'} · agents on: ${cfg.capabilities.filter((a) => ALL_AGENTS.includes(a)).length}</div></a>`;
  };
  return layout('Agents', h`<p class="small"><a href="/">← All sites</a></p>
    <h1>Agents</h1>
    <p class="muted">Run on your Claude subscription, never the API. One job at a time, lowest CPU priority. Each site has its own page.</p>
    ${msg?.error ? h`<div class="banner warn">${msg.error}</div>` : ''}${msg?.ok ? h`<div class="banner info">${msg.ok}</div>` : ''}
    ${workingBanner(db)}${killCard(db)}
    <h2>Sites</h2><div class="grid-sites">${sites.map(card)}</div>
    <h2>Waiting for you${pending.length ? ` (${pending.length})` : ''}</h2>
    ${pending.length ? pending.map((a) => approvalCard(a, nameOf(a.site_id))) : h`<div class="card empty">Nothing to approve.</div>`}
    <h2>Usage, last 7 days</h2>
    <div class="card" style="overflow-x:auto">${week.length ? h`<table><thead><tr><th>Agent</th><th class="num">Runs</th><th class="num">Tokens in</th><th class="num">Tokens out</th><th class="num">List-price value</th><th class="num">Not ok</th></tr></thead><tbody>
      ${week.map((w) => h`<tr><td>${LABEL[w.agent] ?? w.agent}</td><td class="num">${w.runs}</td><td class="num">${fmt(w.tin)}</td><td class="num">${fmt(w.tout)}</td><td class="num">${LLM_AGENTS.has(w.agent) ? `$${w.cost}` : '-'}</td><td class="num">${w.bad || ''}</td></tr>`)}</tbody></table>
      <p class="muted small">Subscription usage: nothing is billed per token. "List-price value" is what the same tokens would cost on the API, to compare weeks.</p>` : h`<p class="muted small">No runs yet.</p>`}</div>
    ${runsList(db)}${decidedList(db)}`, { refresh: inFlight().length ? 6 : undefined });
}

/** One page per site: its approvals, agents and controls, blog quality (when the site has a blog), topics and runs. */
export function siteAgentsPage(db: DatabaseSync, short: string, msg?: { error?: string; ok?: string }, showAll = false, allTopics = false): string | null {
  const site = agentSites(db).find((s) => cfgOf(s)?.short === short);
  if (!site) return null;
  const cfg = cfgOf(site)!, id = site.id;
  const pending = db.prepare("SELECT * FROM approvals WHERE status = 'pending' AND site_id = ? ORDER BY id DESC").all(id) as any[];
  const topicCount = (db.prepare("SELECT COUNT(*) n FROM topics WHERE site_id = ? AND status = 'new'").get(id) as { n: number }).n;
  const topics = db.prepare(`SELECT * FROM topics WHERE site_id = ? AND status = 'new' ORDER BY score DESC, id${allTopics ? '' : ' LIMIT 10'}`).all(id) as any[];
  const writing = new Set(inFlight().filter((k) => k.startsWith(`writer:${id}:topic:`)).map((k) => Number(k.split(':')[3])));
  const canWrite = cfg.capabilities.includes('writer');
  const writeCell = (t: any): Html => writing.has(t.id) ? chip('info', 'Writing…')
    : canWrite ? h`<form method="post" action="/agents/write-topic" style="margin:0"><input type="hidden" name="site" value="${id}"><input type="hidden" name="topic" value="${t.id}"><button class="btn link" title="The writer drafts this post now. You still approve it before anything goes live.">Write now</button></form>`
    : h`<span class="muted small" title="${cfg.pendingNote ?? ''}">Writer off</span>`;
  const issues = (db.prepare("SELECT COUNT(*) n FROM findings WHERE site_id = ? AND status = 'open' AND severity != 'info'").get(id) as { n: number }).n;
  const agentRow = (a: string) => {
    const last = db.prepare('SELECT * FROM agent_runs WHERE agent = ? AND site_id = ? ORDER BY id DESC LIMIT 1').get(a, id) as any;
    const st = db.prepare('SELECT enabled, autonomy FROM agent_settings WHERE agent = ? AND site_id = ?').get(a, id) as { enabled: number; autonomy: string } | undefined;
    return h`<tr><td><b>${LABEL[a]}</b><br><span class="muted small">${when(a)}</span></td>
      <td>${last ? h`${chip(sev(last.status), last.status)} <span class="muted small">${ago(last.finished_at ?? last.started_at)}</span>` : h`<span class="muted small">never</span>`}</td>
      <td><form method="post" action="/agents/toggle"><input type="hidden" name="agent" value="${a}"><input type="hidden" name="site" value="${id}"><input type="hidden" name="enabled" value="${st?.enabled ? 0 : 1}"><button class="btn link">${st?.enabled ? 'On (pause)' : 'Paused (resume)'}</button></form></td>
      <td>${a === 'fixer' ? h`<form method="post" action="/agents/autonomy"><input type="hidden" name="agent" value="${a}"><input type="hidden" name="site" value="${id}">
          <select name="autonomy" aria-label="Fixer autonomy" onchange="this.form.submit()">${['approve', 'auto'].map((v) => h`<option value="${v}" ${v === st?.autonomy ? raw('selected') : ''}>${v === 'approve' ? 'Ask me first' : 'Auto-publish low-risk'}</option>`)}</select></form>`
        : a === 'writer' ? h`<span class="muted small">Ask me first</span>` : ''}</td>
      <td><form method="post" action="/agents/run"><input type="hidden" name="agent" value="${a}"><input type="hidden" name="site" value="${id}"><button class="btn link">Run now</button></form></td></tr>`;
  };
  const canFix = cfg.capabilities.includes('fixer');
  return layout(`Agents · ${cfg.label}`, h`<p class="small"><a href="/agents">← All agents</a> · <a href="/site/${id}">Site health →</a></p>
    <h1>${cfg.label}</h1>
    ${msg?.error ? h`<div class="banner warn">${msg.error}</div>` : ''}${msg?.ok ? h`<div class="banner info">${msg.ok}</div>` : ''}
    ${workingBanner(db, id)}${killCard(db)}
    <h2>Waiting for you${pending.length ? ` (${pending.length})` : ''}</h2>
    ${pending.length ? pending.map((a) => approvalCard(a)) : h`<div class="card empty">Nothing to approve.</div>`}
    <h2>Agents</h2>
    ${canFix ? h`<div class="row" style="justify-content:flex-start;margin-bottom:10px"><form method="post" action="/agents/fix-all"><input type="hidden" name="site" value="${id}"><button class="btn primary" ${issues ? '' : raw('disabled')}>Fix all issues now${issues ? ` (${issues})` : ''}</button></form>
      <a class="small" href="/site/${id}?tab=issues">Pick which ones to fix →</a></div>` : ''}
    ${cfg.pendingNote ? h`<div class="banner info">${cfg.pendingNote}</div>` : ''}
    <div class="card" style="overflow-x:auto"><table><thead><tr><th>Agent</th><th>Last run</th><th>Status</th><th>Autonomy</th><th></th></tr></thead><tbody>
      ${ALL_AGENTS.filter((a) => cfg.capabilities.includes(a)).map(agentRow)}</tbody></table></div>
    ${cfg.capabilities.includes('improver') ? blogSection(db, site, showAll, cfg.short) : ''}
    <h2 id="topics">Topic backlog</h2>
    <p class="muted small">"Write now" sends one topic to the writer immediately (about 5 to 10 minutes). The draft appears under "Waiting for you"; nothing goes live until you approve it.</p>
    <div class="card">${topics.length ? h`<ul class="urls">${topics.map((t) => h`<li><span class="u"><b>${t.title}</b> ${t.action !== 'new' ? chip('info', t.action) : ''}<br><span class="m">${t.query ? `“${t.query}” · ` : ''}${t.why}</span></span><span class="m">score ${t.score}</span>${writeCell(t)}</li>`)}</ul>
      ${topicCount > topics.length || allTopics ? h`<p class="muted small">${allTopics ? `Showing all ${topicCount}.` : `Showing the top 10 of ${topicCount}.`} <a href="/agents/${cfg.short}?${allTopics ? '' : 'topics=all'}#topics">${allTopics ? 'Show only the top 10' : `Show all ${topicCount}`}</a></p>` : ''}` : h`<p class="muted small">Empty. The researcher fills it on Sundays.</p>`}</div>
    ${runsList(db, id)}${decidedList(db, id)}`, { refresh: inFlight().length ? 6 : undefined });
}

/** Form handlers. Throw a plain-language Error on bad input. */
export function agentsPost(db: DatabaseSync, action: string, form: URLSearchParams): string {
  const agent = form.get('agent') ?? '', site = Number(form.get('site'));
  const known = () => { if (!ALL_AGENTS.includes(agent) || !agentSites(db).some((s) => s.id === site)) throw new Error('Unknown agent or site.'); };
  if (action === 'kill') { db.prepare("INSERT INTO agent_settings (agent, site_id, enabled) VALUES ('*', 0, ?) ON CONFLICT(agent, site_id) DO UPDATE SET enabled = excluded.enabled").run(form.get('enabled') === '1' ? 1 : 0); return form.get('enabled') === '1' ? 'Agents resumed.' : 'All agents stopped.'; }
  if (action === 'decide') { const id = Number(form.get('id')), a = form.get('action'); if (a !== 'approve' && a !== 'reject') throw new Error('Bad action.'); decide(db, id, a); return a === 'approve' ? 'Approved. Publishing now: it goes live after the deploy is confirmed.' : 'Rejected.'; }
  if (action === 'fix-all') return queueFix(db, site, 'all');
  if (action === 'write-topic') {
    const s = agentSites(db).find((x) => x.id === site); if (!s || !capable(s, 'writer')) throw new Error('The writer is not enabled for this site.');
    if ((db.prepare("SELECT enabled FROM agent_settings WHERE agent = '*' AND site_id = 0").get() as { enabled: number } | undefined)?.enabled === 0) throw new Error('All agents are stopped: resume them first.');
    const t = db.prepare('SELECT id, title, status FROM topics WHERE id = ? AND site_id = ?').get(Number(form.get('topic')), site) as { id: number; title: string; status: string } | undefined;
    if (!t) throw new Error('That topic is not in this site\'s backlog.');
    if (t.status !== 'new') throw new Error(`"${t.title}" is already ${t.status}.`);
    void runAgent(db, 'writer', s, null, { topicId: t.id });
    return `Writer started on "${t.title}". It takes about 5 to 10 minutes; the draft then appears under "Waiting for you". Nothing is published until you approve it.`;
  }
  if (action !== 'improve' && action !== 'improve-low') known();
  if (action === 'toggle') { db.prepare('UPDATE agent_settings SET enabled = ? WHERE agent = ? AND site_id = ?').run(form.get('enabled') === '1' ? 1 : 0, agent, site); return `${LABEL[agent]} ${form.get('enabled') === '1' ? 'resumed' : 'paused'}.`; }
  if (action === 'autonomy') {
    const v = form.get('autonomy'); if (agent !== 'fixer' || (v !== 'approve' && v !== 'auto')) throw new Error('Only the fixer has an autonomy setting.');
    db.prepare('UPDATE agent_settings SET autonomy = ? WHERE agent = ? AND site_id = ?').run(v, agent, site); return `Fixer: ${v === 'auto' ? 'auto-publishes low-risk content fixes' : 'asks you first'}.`;
  }
  if (action === 'improve' || action === 'improve-low') {
    const s = agentSites(db).find((x) => x.id === site); if (!s || !capable(s, 'improver')) throw new Error('Post improvement is not enabled for this site.');
    const rows = blogScores(db, s), done = recentlyImproved(db, s.id);
    const onlyTarget = form.get('target') === '1';
    const slugs = action === 'improve' ? [form.get('slug') ?? ''] : rows.filter((r) => !done.has(r.slug) && (!onlyTarget || TARGET.has(r.segment))).slice(0, 3).map((r) => r.slug);
    if (!slugs.length) throw new Error('No posts match: they are all improved or in progress.');
    if (slugs.some((x) => !rows.some((r) => r.slug === x))) throw new Error('That post is not in the latest crawl.');
    for (const slug of slugs) void runAgent(db, 'improver', s, null, { slug });
    const names = slugs.map((x) => `"${rows.find((r) => r.slug === x)!.title}"`).join(', ');
    return `Queued for the writer: ${names}. Each takes about 2 minutes, then appears under "Waiting for you" as "Improve: <post name>".`;
  }
  if (action === 'run') {
    const target = agentSites(db).find((x) => x.id === site)!;
    if (!capable(target, agent)) throw new Error(`${LABEL[agent]} is not enabled for this site.`);
    void runAgent(db, agent, target); return `${LABEL[agent]} queued.`;
  }
  throw new Error('Unknown action.');
}
