// Localhost dashboard: plain-language health per site, issues ranked by urgency, changes as sentences.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setPriority } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, addSite, type Site } from './db.ts';
import { runSite } from './crawl.ts';
import { alertText, sendAlert } from './alert.ts';
import { ruleInfo, describeChange, RULES } from './catalog.ts';
import { discover, activate, deactivate, addOwnCompetitor, candidates, type Candidate, type Profile } from './competitors.ts';
import { findProperty } from './gsc.ts';
import { hasLlm, MODEL } from './llm.ts';
import { h, raw, layout, chip, trendChart, safeHref, pathOf, ago, type Html, type Sev } from './html.ts';

type Counts = { critical: number; warn: number; info: number };
type Run = { id: number; status: string; started_at: string; finished_at: string | null; stats: any };
type Group = { rule_id: string; severity: Sev; n: number; items: { id: number; subject: string; message: string }[] };

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const running = new Set<number>(), discovering = new Set<number>();
const discoveryError = new Map<number, string>();

// ---------- queries ----------
function counts(db: DatabaseSync, siteId: number): Counts {
  const c: Counts = { critical: 0, warn: 0, info: 0 };
  for (const r of db.prepare("SELECT severity, COUNT(*) n FROM findings WHERE site_id = ? AND status = 'open' GROUP BY severity").all(siteId) as { severity: keyof Counts; n: number }[]) c[r.severity] = r.n;
  return c;
}
function lastRun(db: DatabaseSync, siteId: number): Run | undefined {
  const r = db.prepare("SELECT * FROM runs WHERE site_id = ? AND status != 'running' ORDER BY id DESC LIMIT 1").get(siteId) as any;
  return r && { ...r, stats: JSON.parse(r.stats_json || '{}') };
}
function groups(db: DatabaseSync, siteId: number, status = 'open'): Group[] {
  return (db.prepare(`SELECT rule_id, severity, COUNT(*) n, json_group_array(json_object('id', id, 'subject', subject, 'message', message)) items
    FROM findings WHERE site_id = ? AND status = ? GROUP BY rule_id, severity
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, n DESC`).all(siteId, status) as any[])
    .map((g) => ({ ...g, items: JSON.parse(g.items) }));
}

/** The one sentence a site card and site page lead with. */
function verdict(db: DatabaseSync, site: Site, c: Counts, run?: Run): { sev: Sev; text: string } {
  if (running.has(site.id)) return { sev: 'info', text: 'Checking the site now…' };
  if (!run) return { sev: 'info', text: 'Not checked yet. Run the first check to see its health.' };
  if (run.status === 'suspect') return { sev: 'warn', text: 'The last check looked unreliable: many pages failed at once. The next check will confirm whether the site is really down.' };
  if (run.status === 'failed') return { sev: 'warn', text: 'The last check crashed before finishing. Try running it again.' };
  if (site.kind === 'competitor') return { sev: 'info', text: run.stats.events ? `${plural(run.stats.events, 'change')} spotted in the last check.` : 'No changes in the last check.' };
  if (c.critical) {
    const top = groups(db, site.id).filter((g) => g.severity === 'critical');
    const first = top[0];
    const more = top.length > 1 ? `, plus ${plural(top.length - 1, 'other urgent issue')}` : '';
    return { sev: 'critical', text: `${ruleInfo(first.rule_id).title}: ${plural(first.n, 'page')}${first.items[0]?.subject === '' ? ' (site-wide)' : ''}${more}.` };
  }
  if (c.warn) return { sev: 'warn', text: `No urgent problems. ${plural(c.warn, 'thing')} worth improving.` };
  return { sev: 'good', text: 'All clear. No problems found in the last check.' };
}

const countChips = (c: Counts) => h`<div class="counts">
  ${c.critical ? chip('critical', `${c.critical} fix now`) : ''}${c.warn ? chip('warn', `${c.warn} to improve`) : ''}
  ${c.info ? chip('info', `${c.info} notes`) : ''}${!c.critical && !c.warn ? chip('good', 'No issues') : ''}</div>`;

// ---------- pages ----------
function overviewPage(db: DatabaseSync, msg?: { error?: string; ok?: string }): string {
  const sites = db.prepare("SELECT * FROM sites WHERE kind = 'own' ORDER BY id").all() as Site[];
  const rivals = (id: number) => (db.prepare("SELECT COUNT(*) n FROM competitor_candidates WHERE site_id = ? AND status IN ('active', 'pinned', 'user_added')").get(id) as { n: number }).n;
  const rows = sites.map((s) => { const c = counts(db, s.id), r = lastRun(db, s.id); return { s, c, r, v: verdict(db, s, c, r) }; });
  const own = rows.filter((x) => x.s.kind === 'own');
  const urgent = own.filter((x) => x.v.sev === 'critical').length;
  const headline = !sites.length ? 'Add your first website to start watching it.'
    : urgent ? `${plural(urgent, 'site needs', 'sites need')} attention now.`
    : own.some((x) => x.v.sev === 'warn') ? 'Nothing urgent. A few improvements are waiting.' : 'Everything looks healthy.';
  const card = (x: (typeof rows)[number]) => h`<a class="card site-card" href="/site/${x.s.id}">
    <div class="row"><span class="host">${host(x.s.url)}</span>${x.s.kind === 'competitor' ? h`<span class="chip info">Competitor</span>` : ''}</div>
    <div class="verdict">${chip(x.v.sev, x.v.sev === 'critical' ? 'Fix now' : x.v.sev === 'warn' ? 'Needs a look' : x.v.sev === 'good' ? 'Healthy' : 'Info')} ${x.v.text}</div>
    ${x.s.kind === 'own' && x.r && (x.c.critical || x.c.warn) ? countChips({ ...x.c, info: 0 }) : ''}
    <div class="muted small">${x.r ? `Checked ${ago(x.r.finished_at)} · ${plural(x.r.stats.pages ?? 0, 'page')}` : 'Never checked'} · ${rivals(x.s.id) ? `watching ${plural(rivals(x.s.id), 'competitor')}` : 'competitors not set up'}</div></a>`;
  return layout('Overview', h`
    <div class="hero"><h1>Your websites</h1><p class="headline">${headline}</p>
      <p class="muted">${plural(own.length, 'site')} watched. Click a site to see what to fix, what changed, and what its competitors are doing.</p></div>
    ${msg?.error ? h`<div class="banner warn">${msg.error}</div>` : ''}${msg?.ok ? h`<div class="banner info">${msg.ok}</div>` : ''}
    ${sites.length ? h`<div class="grid-sites">${rows.map(card)}</div>` : ''}
    <h2>Watch a website</h2>
    <form class="add card" method="post" action="/sites">
      <label>Website address<input name="url" required placeholder="example.com" autocomplete="url" inputmode="url"></label>
      <label>Countries it sells to <input name="market" placeholder="MX or MX,US" maxlength="40"></label>
      <button class="btn primary">Add site</button>
    </form>
    <p class="muted small">Countries are optional. They let the watchdog flag language tags that target the wrong country.</p>`, { refresh: running.size ? 8 : undefined });
}

function sitePage(db: DatabaseSync, site: Site, tab: string, showAll: boolean, error?: string): string {
  const c = counts(db, site.id), run = lastRun(db, site.id), v = verdict(db, site, c, run);
  const runs = (db.prepare("SELECT * FROM runs WHERE site_id = ? AND status = 'ok' ORDER BY id DESC LIMIT 20").all(site.id) as any[]).reverse();
  const trend = runs.map((r) => ({ at: r.finished_at, ...JSON.parse(r.stats_json || '{}') })).filter((r) => r.open).map((r) => ({ at: r.at, critical: r.open.critical ?? 0, warn: r.open.warn ?? 0 }));
  const isRunning = running.has(site.id) || discovering.has(site.id);
  const parent = site.parent_site_id ? (db.prepare('SELECT * FROM sites WHERE id = ?').get(site.parent_site_id) as Site | undefined) : undefined;
  const tabs = site.kind === 'own' ? ['issues', 'competitors', 'changes', 'checks', 'pages'] : ['changes', 'checks', 'pages'];
  const active = tabs.includes(tab) ? tab : tabs[0];
  const label: Record<string, string> = { issues: 'What to fix', competitors: 'Competitors', changes: 'What changed', checks: 'Site checks', pages: 'All pages' };
  const body = active === 'issues' ? issuesTab(db, site, trend) : active === 'competitors' ? competitorsTab(db, site) : active === 'changes' ? changesTab(db, site, showAll) : active === 'checks' ? checksTab(db, site, run) : pagesTab(db, site);
  return layout(host(site.url), h`
    ${parent ? h`<p class="small"><a href="/site/${parent.id}?tab=competitors">← ${host(parent.url)} competitors</a></p>` : h`<p class="small"><a href="/">← All sites</a></p>`}
    <div class="row"><div><h1>${host(site.url)}</h1>
      <p class="muted small"><a href="${safeHref(site.url)}" target="_blank" rel="noopener">${site.url}</a>${parent ? ` · competitor of ${host(parent.url)}` : ''}${site.market ? ` · sells to ${site.market}` : ''}</p></div>
      <form method="post" action="/site/${site.id}/run"><button class="btn primary" ${isRunning ? raw('disabled') : ''}>${isRunning ? 'Checking…' : 'Check now'}</button></form></div>
    <p class="headline">${chip(v.sev, v.sev === 'critical' ? 'Fix now' : v.sev === 'warn' ? 'Needs a look' : v.sev === 'good' ? 'Healthy' : 'Info')} ${v.text}</p>
    ${run ? h`<div class="stats">
      <div class="card stat"><div class="v">${run.stats.pages ?? 0}</div><div class="k">pages checked ${ago(run.finished_at)}</div></div>
      ${site.kind === 'own' ? h`<div class="card stat"><div class="v">${c.critical}</div><div class="k">problems to fix now</div></div>
      <div class="card stat"><div class="v">${c.warn}</div><div class="k">things to improve</div></div>
      <div class="card stat"><div class="v">${run.stats.resolved ?? 0}</div><div class="k">fixed since the check before</div></div>` : ''}
      <div class="card stat"><div class="v">${run.stats.events ?? 0}</div><div class="k">changes found in the last check</div></div></div>` : ''}
    <nav class="tabs">${tabs.map((t) => h`<a href="?tab=${t}" class="${t === active ? 'on' : ''}">${label[t]}</a>`)}</nav>
    ${error ? h`<div class="banner warn">${error}</div>` : ''}${body}`, { refresh: isRunning ? 6 : undefined });
}

function issuesTab(db: DatabaseSync, site: Site, trend: { at: string; critical: number; warn: number }[]): Html {
  const gs = groups(db, site.id);
  const section = (sev: Sev, title: string, intro: string) => {
    const list = gs.filter((g) => g.severity === sev);
    if (!list.length) return '';
    return h`<h2>${title}</h2><p class="muted small">${intro}</p>${list.map((g) => issueCard(site, g))}`;
  };
  const fixed = db.prepare("SELECT rule_id, subject, resolved_at FROM findings WHERE site_id = ? AND status = 'resolved' AND resolved_at >= datetime('now', '-14 days') ORDER BY resolved_at DESC LIMIT 15").all(site.id) as any[];
  const muted = groups(db, site.id, 'muted');
  return h`
    ${trend.length ? h`<div class="card">${trendChart(trend)}</div>` : ''}
    ${!gs.length ? h`<div class="card empty">${chip('good')} Nothing to fix. The watchdog will tell you as soon as something breaks.</div>` : ''}
    ${section('critical', 'Fix now', 'These stop pages from showing up in Google, or break the site for visitors.')}
    ${section('warn', 'Worth improving', 'Not urgent, but each one costs you some visibility in search or AI answers.')}
    ${gs.some((g) => g.severity === 'info') ? h`<details><summary><h2 style="display:inline">Notes</h2> <span class="muted small">small things, when you have time</span></summary>
      ${gs.filter((g) => g.severity === 'info').map((g) => issueCard(site, g))}</details>` : ''}
    ${fixed.length ? h`<h2>Recently fixed</h2><div class="card"><ul class="urls">${fixed.map((f) => h`<li><span class="u">${chip('good', 'Fixed')} ${ruleInfo(f.rule_id).title}${f.subject ? h` · <a href="/site/${site.id}/page?url=${encodeURIComponent(f.subject)}">${pathOf(f.subject)}</a>` : ''}</span><span class="m">${ago(f.resolved_at)}</span></li>`)}</ul></div>` : ''}
    ${muted.length ? h`<h2>Muted</h2><div class="card"><ul class="urls">${muted.map((g) => h`<li><span class="u">${ruleInfo(g.rule_id).title} · ${plural(g.n, 'page')}</span>
      <form method="post" action="/site/${site.id}/unmute"><input type="hidden" name="rule" value="${g.rule_id}"><button class="btn link">Unmute</button></form></li>`)}</ul></div>` : ''}`;
}

function issueCard(site: Site, g: Group): Html {
  const info = ruleInfo(g.rule_id);
  const siteWide = g.items.length === 1 && g.items[0].subject === '';
  const shown = g.items.slice(0, 50);
  return h`<details class="card issue"${g.severity === 'critical' ? raw(' open') : ''}>
    <summary>${chip(g.severity)}<div><h3>${info.title}</h3><div class="why">${info.why}</div></div><span class="count">${siteWide ? 'whole site' : plural(g.n, 'page')}</span></summary>
    <div class="body">
      ${info.fix ? h`<div class="fix"><b>How to fix:</b> ${info.fix}</div>` : ''}
      <ul class="urls">${shown.map((it) => h`<li><span class="u">${it.subject
        ? h`<a href="/site/${site.id}/page?url=${encodeURIComponent(it.subject)}">${pathOf(it.subject)}</a>` : 'Whole site'}<br><span class="m">${it.message}</span></span>
        ${it.subject ? h`<a class="small" href="${safeHref(it.subject)}" target="_blank" rel="noopener" aria-label="Open live page">Open ↗</a>` : ''}</li>`)}</ul>
      ${g.n > shown.length ? h`<p class="muted small">…and ${g.n - shown.length} more.</p>` : ''}
      <div class="row" style="margin-top:10px"><span class="area">${info.area}</span>
        <form method="post" action="/site/${site.id}/mute"><input type="hidden" name="rule" value="${g.rule_id}"><button class="btn link" title="Hide this issue type for this site until you unmute it">Mute this issue</button></form></div>
    </div></details>`;
}

const WATCHED = ['active', 'pinned', 'user_added'];
const discoveryCost = () => (process.env.SERPER_API_KEY ? 'about $0.02 (Serper + Claude)' : 'about $1 (Claude web search; add SERPER_API_KEY to cut it to about $0.02)');

function competitorsTab(db: DatabaseSync, site: Site): Html {
  const cs = candidates(db, site.id);
  const watched = cs.filter((c) => WATCHED.includes(c.status));
  const alts = cs.filter((c) => c.status === 'suggested' && c.score > 0).slice(0, 7);
  const dirs = cs.filter((c) => c.status === 'directory');
  const last = db.prepare('SELECT * FROM discoveries WHERE site_id = ? ORDER BY id DESC LIMIT 1').get(site.id) as any;
  const busy = discovering.has(site.id);
  const err = discoveryError.get(site.id);
  const gscNote = site.gsc_property ? `real Search Console queries (${site.gsc_property})` : 'generated keywords (Search Console not connected)';
  const discoverBtn = (label: string) => !hasLlm()
    ? h`<p class="muted small">Set <code>ANTHROPIC_API_KEY</code> in <code>SEO-Watchdog/.env</code> and restart the dashboard to enable discovery.</p>`
    : h`<form method="post" action="/site/${site.id}/discover"><button class="btn ${cs.length ? '' : 'primary'}" ${busy ? raw('disabled') : ''}>${busy ? 'Finding competitors…' : label}</button></form>
      <p class="muted small">Uses ${gscNote}, ~12 searches, ${discoveryCost()}.</p>`;

  const evidence = (c: Candidate) => h`<span class="m">${c.evidence.overlap ? `Shows up for ${plural(c.evidence.overlap, 'of your searches', 'of your searches')}${c.evidence.best ? `, best position #${c.evidence.best}` : ''}. ` : ''}${c.evidence.reason ?? ''}</span>
    ${c.evidence.quote ? h`<br><span class="m">“${c.evidence.quote}”</span>` : ''}`;
  const act = (c: Candidate, action: string, label: string, title = '') => h`<form method="post" action="/site/${site.id}/competitor"><input type="hidden" name="cid" value="${c.id}"><input type="hidden" name="action" value="${action}"><button class="btn link" title="${title}">${label}</button></form>`;
  const watchCard = (c: Candidate) => {
    const r = c.competitor_site_id ? lastRun(db, c.competitor_site_id) : undefined;
    const check = c.competitor_site_id && running.has(c.competitor_site_id) ? 'Checking their site now…'
      : r ? h`<a href="/site/${c.competitor_site_id}?tab=changes">${plural(r.stats.events ?? 0, 'change')} in their last check</a> · ${ago(r.finished_at)}` : 'Not checked yet.';
    return h`<div class="card comp"><div class="row"><b>${c.domain}</b><span class="counts">
        ${c.types.includes('search') ? chip('info', 'Search') : ''}${c.types.includes('local') ? chip('info', 'Local') : ''}
        ${c.status === 'user_added' ? chip('info', 'Added by you') : ''}${c.status === 'pinned' ? chip('good', 'Pinned') : ''}</span></div>
      <p class="small">${evidence(c)}</p><p class="small">${check}</p>
      <div class="row" style="justify-content:flex-start">
        ${c.status === 'active' ? act(c, 'pin', 'Pin', 'Keep watching it even if another site shows up more') : c.status === 'pinned' ? act(c, 'unpin', 'Unpin') : ''}
        ${act(c, 'stop', 'Stop watching', 'Deletes its change history; it may be suggested again')}
        ${act(c, 'exclude', 'Never suggest', 'Stop watching and never suggest it again')}</div></div>`;
  };

  // A later discovery only proposes: the strongest alternative vs the weakest watched site that isn't pinned or yours.
  const weakest = watched.filter((c) => c.status === 'active').sort((a, b) => a.score - b.score)[0];
  const swap = weakest && alts.find((c) => c.score > weakest.score);

  const p = db.prepare('SELECT data_json, source, updated_at FROM site_profiles WHERE site_id = ?').get(site.id) as { data_json: string; source: string; updated_at: string } | undefined;
  const prof: Partial<Profile> = p ? JSON.parse(p.data_json) : {};
  const stats = last ? JSON.parse(last.stats_json || '{}') : {};

  return h`<p class="muted small">The businesses that show up next to you when customers search. The watchdog checks their sites and records what they change.</p>
    ${err ? h`<div class="banner warn">The last discovery failed: ${err}</div>` : ''}
    ${!cs.length ? h`<div class="card empty"><p>No competitors yet.</p>${discoverBtn('Find my top 3 competitors')}</div>` : h`
      ${swap ? h`<div class="banner info row"><span><b>${swap.domain}</b> now shows up more than <b>${weakest.domain}</b> for your searches. Swap?</span>
        <form method="post" action="/site/${site.id}/competitor"><input type="hidden" name="action" value="swap"><input type="hidden" name="cid" value="${swap.id}"><input type="hidden" name="replace" value="${weakest.id}"><button class="btn">Swap</button></form></div>` : ''}
      <h2>Watching</h2>
      ${watched.length ? h`<div class="grid-sites">${watched.map(watchCard)}</div>` : h`<div class="card empty">Not watching any competitor. Pick one below.</div>`}
      ${alts.length ? h`<h2>Alternatives</h2><div class="card"><ul class="urls">${alts.map((c) => h`<li><span class="u"><b>${c.domain}</b><br>${evidence(c)}</span>
        <span class="acts">${act(c, 'watch', 'Watch')}${watched.length ? h`<form method="post" action="/site/${site.id}/competitor" class="inline"><input type="hidden" name="action" value="swap"><input type="hidden" name="cid" value="${c.id}">
          <button class="btn link">Watch instead of</button> <select name="replace" aria-label="Competitor to replace">${watched.map((w) => h`<option value="${w.id}">${w.domain}</option>`)}</select></form>` : ''}</span></li>`)}</ul></div>` : ''}
      ${dirs.length ? h`<h2>Directories that show up for your searches</h2><p class="muted small">Worth checking that you're listed.</p><div class="card"><ul class="urls">${dirs.map((c) => h`<li><span class="u"><b>${c.domain}</b><br>${evidence(c)}</span></li>`)}</ul></div>` : ''}`}

    <h2>Add your own competitor</h2>
    <form class="add card" method="post" action="/site/${site.id}/competitor-add" style="grid-template-columns:1fr auto">
      <label>Their website<input name="url" required placeholder="rival.com" inputmode="url" maxlength="300"></label><button class="btn">Watch it</button></form>

    <h2>What the watchdog thinks your business is</h2>
    <div class="card">
      ${p ? h`<dl class="kv">
        <dt>Industry</dt><dd>${prof.industry || '—'}</dd><dt>Services</dt><dd>${prof.services?.join(' · ') || '—'}</dd>
        <dt>Where</dt><dd>${[prof.city, prof.region, prof.country].filter(Boolean).join(', ') || '—'} (${prof.scope ?? '?'})</dd>
        <dt>Searches</dt><dd>${(prof.keywords ?? []).map((k) => h`<span class="kw">${k.query} ${chip(k.from_gsc ? 'good' : 'info', k.from_gsc ? 'Search Console' : 'no search data')}</span>`)}</dd></dl>
        <p class="muted small" style="margin-top:8px">${p.source === 'user' ? `Edited by you ${ago(p.updated_at)}; discovery reuses it as is.` : `Worked out from your site ${ago(p.updated_at)}. Edit it if it's wrong; discovery will then use your version.`}</p>`
        : h`<p class="muted small">Not worked out yet. It's built on the first discovery, or you can fill it in now.</p>`}
      <details style="margin-top:8px"><summary class="small">Edit</summary>
        <form class="stack" method="post" action="/site/${site.id}/profile">
          <label>Industry<input name="industry" value="${prof.industry ?? ''}" maxlength="120" required></label>
          <label>Services (one per line)<textarea name="services" rows="4">${(prof.services ?? []).join('\n')}</textarea></label>
          <div class="cols"><label>City<input name="city" value="${prof.city ?? ''}" maxlength="80"></label><label>Region<input name="region" value="${prof.region ?? ''}" maxlength="80"></label>
            <label>Country (2 letters)<input name="country" value="${prof.country ?? ''}" maxlength="2" pattern="[A-Za-z]{2}"></label>
            <label>Reach<select name="scope">${['local', 'national', 'online'].map((s) => h`<option ${s === prof.scope ? raw('selected') : ''}>${s}</option>`)}</select></label></div>
          <label>Searches customers type to find you (one per line, max 15)<textarea name="keywords" rows="8" required>${(prof.keywords ?? []).map((k) => k.query).join('\n')}</textarea></label>
          <div><button class="btn primary">Save profile</button></div></form></details>
    </div>

    <h2>Search Console</h2>
    <div class="card">${site.gsc_property ? h`<p class="small">${chip('good', 'Connected')} ${site.gsc_property}: discovery picks keywords from your real Google searches.</p>`
      : h`<p class="small">${chip('info', 'Not connected')} Discovery will guess keywords. Connect a service-account key to use your real Google searches.</p>`}
      <form class="add" method="post" action="/site/${site.id}/gsc" style="grid-template-columns:1fr auto;margin-top:8px">
        <label>Path to the service-account key (.json) on this machine<input name="key" value="${site.gsc_key ?? ''}" required maxlength="500" placeholder="/home/you/keys/gsc.json"></label><button class="btn">${site.gsc_property ? 'Reconnect' : 'Connect'}</button></form></div>

    ${cs.length ? h`<h2>Discovery</h2><div class="card">
      ${last ? h`<p class="small">Last run ${ago(last.at)} · ${last.provider} · ${last.model} · ${stats.cost_usd != null ? `$${stats.cost_usd}` : 'cost unknown'} · ${plural(stats.keywords ?? 0, 'search', 'searches')}, ${stats.gsc_keywords ?? 0} from Search Console.</p>` : ''}
      ${discoverBtn('Find competitors again')}<p class="muted small">Running it again only proposes swaps; it never changes who you watch on its own.</p></div>` : ''}`;
}

const NOISY = new Set(['content', 'faq_questions']);
function changesTab(db: DatabaseSync, site: Site, showAll: boolean): Html {
  const evs = db.prepare(`SELECT e.*, r.finished_at FROM events e JOIN runs r ON r.id = e.run_id
    WHERE e.site_id = ? AND e.created_at >= datetime('now', '-30 days') ORDER BY e.run_id DESC, e.type, e.subject LIMIT 2000`).all(site.id) as any[];
  const important = evs.filter((e) => !(e.type === 'page.change' && NOISY.has(e.field)) && e.type !== 'page.new');
  const list = showAll ? evs : important;
  if (!evs.length) return h`<div class="card empty">No changes in the last 30 days. Changes appear here from the second check onwards.</div>`;
  const byRun = new Map<number, any[]>();
  for (const e of list) byRun.set(e.run_id, [...(byRun.get(e.run_id) || []), e]);
  const BA = new Set(['title', 'meta_description', 'h1', 'canonical', 'robots', 'final_url', 'status', 'jsonld_types', 'lang', 'robots.txt']);
  return h`
    <div class="row"><p class="muted small">${showAll ? `Showing all ${evs.length} changes.` : `Showing ${important.length} important changes. Text edits and new pages are hidden.`}</p>
      <a class="small" href="?tab=changes${showAll ? '' : '&all=1'}">${showAll ? 'Show important only' : `Show all ${evs.length}`}</a></div>
    ${!list.length ? h`<div class="card empty">Only text edits and new pages changed recently. <a href="?tab=changes&all=1">Show them</a></div>` : ''}
    ${[...byRun.values()].map((items) => {
      // One line per kind of change ("Title changed · 11 pages"), bad news first; expand for each page's before → after.
      const kinds = new Map<string, { tone: string; text: string; evs: any[] }>();
      for (const e of items) { const d = describeChange(e); const k = d.tone + d.text; kinds.set(k, { ...d, evs: [...(kinds.get(k)?.evs || []), e] }); }
      const order = { bad: 0, good: 1, neutral: 2 } as Record<string, number>;
      const sorted = [...kinds.values()].sort((a, b) => order[a.tone] - order[b.tone] || b.evs.length - a.evs.length);
      return h`<h2>Check ${ago(items[0].finished_at)}</h2><div class="card"><ul class="changes">${sorted.map((k) => h`<li><span class="dot ${k.tone}" aria-label="${k.tone}"></span>
        <details${k.evs.length === 1 ? raw(' open') : ''}><summary>${k.text}${k.evs[0].subject ? h` · <span class="muted">${plural(k.evs.length, 'page')}</span>` : ''}</summary>
          <ul class="urls" style="margin-top:6px">${k.evs.slice(0, 100).map((e) => h`<li><span class="u">${e.subject ? h`<a href="/site/${site.id}/page?url=${encodeURIComponent(e.subject)}">${pathOf(e.subject)}</a>` : 'Whole site'}
            ${BA.has(e.field) && (e.before || e.after) ? h`<div class="ba"><del>${clip(e.before)}</del> → <ins>${clip(e.after)}</ins></div>` : ''}</span></li>`)}</ul>
          ${k.evs.length > 100 ? h`<p class="muted small">…and ${k.evs.length - 100} more.</p>` : ''}</details></li>`)}</ul></div>`;
    })}`;
}
const clip = (v: string | null) => (v == null || v === '' ? '(empty)' : v.length > 160 ? v.slice(0, 157) + '…' : v);

function checksTab(db: DatabaseSync, site: Site, run?: Run): Html {
  if (!run) return h`<div class="card empty">Run a check first.</div>`;
  const snap = (kind: string) => JSON.parse((db.prepare('SELECT data_json FROM site_snapshots WHERE run_id = ? AND kind = ?').get(run.id, kind) as any)?.data_json ?? '{}');
  const robots = snap('robots'), sm = snap('sitemap'), tls = snap('tls'), dom = snap('domain');
  const check = (ok: boolean | null, title: string, detail: string) =>
    h`<div class="card check">${chip(ok === null ? 'info' : ok ? 'good' : 'critical', ok === null ? 'Unknown' : ok ? 'OK' : 'Problem')}<div><div class="t">${title}</div><div class="d">${detail}</div></div></div>`;
  const bots: [string, boolean][] = Object.entries(robots.botAccess ?? {});
  const groupsOf = [
    ['Search engines', ['Googlebot', 'Bingbot', 'Applebot', 'DuckAssistBot']],
    ['AI search & answers', ['OAI-SearchBot', 'ChatGPT-User', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'Amazonbot', 'Google-CloudVertexBot', 'Meta-ExternalFetcher', 'MistralAI-User', 'Claude-Web']],
  ] as const;
  return h`<div class="checks">
    ${check(robots.mode !== 'disallow-all', 'robots.txt', robots.mode === 'parsed' ? 'Found and readable.' : robots.mode === 'allow-all' ? 'None found, so everything may be crawled.' : `Unavailable: ${robots.reason}`)}
    ${check(sm.found > 0, 'Sitemap', sm.found > 0 ? `${sm.urls} URLs across ${plural(sm.found, 'file')}.` : 'No sitemap found.')}
    ${check(tls.error ? false : tls.daysLeft >= 21, 'Security certificate', tls.error ? (tls.error === 'not https' ? 'Site is not on HTTPS.' : tls.error) : `Valid for ${tls.daysLeft} more days${tls.issuer ? ` (${tls.issuer})` : ''}.`)}
    ${check(dom.daysLeft == null ? null : dom.daysLeft >= 30, 'Domain registration', dom.daysLeft == null ? "The registry doesn't publish expiry dates (common for .mx)." : `Renews in ${dom.daysLeft} days.`)}
  </div>
  <h2>Who is allowed to read your site</h2>
  <p class="muted small">From robots.txt. AI answer engines can only cite pages their crawler is allowed to read.</p>
  <div class="checks">${groupsOf.map(([name, list]) => h`<div class="card"><h3>${name}</h3><ul class="urls" style="margin-top:8px">${bots.filter(([b]) => (list as readonly string[]).includes(b))
    .map(([b, ok]) => h`<li><span class="u">${b}</span>${chip(ok ? 'good' : 'critical', ok ? 'Allowed' : 'Blocked')}</li>`)}</ul></div>`)}</div>
  <p class="muted small" style="margin-top:16px">Last check: ${plural(run.stats.pages ?? 0, 'page')} in ${run.stats.seconds ?? '?'}s${run.stats.truncated ? `, stopped at the ${site.page_limit}-page limit` : ''}.</p>`;
}

function pagesTab(db: DatabaseSync, site: Site): Html {
  const run = lastRun(db, site.id);
  if (!run) return h`<div class="card empty">Run a check first.</div>`;
  const rows = db.prepare(`SELECT p.url, p.in_sitemap, s.status, json_extract(s.extract_json, '$.title') title,
      (SELECT COUNT(*) FROM findings f WHERE f.site_id = p.site_id AND f.subject = p.url AND f.status = 'open' AND f.severity != 'info') issues
    FROM snapshots s JOIN pages p ON p.id = s.page_id WHERE s.run_id = ? ORDER BY issues DESC, p.url`).all(run.id) as any[];
  return h`<div class="card" style="overflow-x:auto"><table><thead><tr><th>Page</th><th>Title</th><th>Status</th><th class="num">Issues</th></tr></thead><tbody>
    ${rows.map((r) => h`<tr><td><a href="/site/${site.id}/page?url=${encodeURIComponent(r.url)}">${pathOf(r.url)}</a>${r.in_sitemap ? '' : h` <span class="muted small">(not in sitemap)</span>`}</td>
      <td>${r.title ?? ''}</td><td>${r.status === 200 ? 'OK' : r.status || 'failed'}</td><td class="num">${r.issues || ''}</td></tr>`)}
  </tbody></table></div>`;
}

function pageView(db: DatabaseSync, site: Site, url: string): string | null {
  const page = db.prepare('SELECT * FROM pages WHERE site_id = ? AND url = ?').get(site.id, url) as any;
  if (!page) return null;
  const snap = db.prepare('SELECT * FROM snapshots WHERE page_id = ? ORDER BY run_id DESC LIMIT 1').get(page.id) as any;
  const ex = JSON.parse(snap.extract_json);
  const issues = db.prepare("SELECT * FROM findings WHERE site_id = ? AND subject = ? AND status = 'open' ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END").all(site.id, url) as any[];
  const evs = db.prepare(`SELECT e.*, r.finished_at FROM events e JOIN runs r ON r.id = e.run_id WHERE e.site_id = ? AND e.subject = ? ORDER BY e.id DESC LIMIT 100`).all(site.id, url) as any[];
  const kv = (k: string, v: unknown) => h`<dt>${k}</dt><dd>${v == null || v === '' || (Array.isArray(v) && !v.length) ? h`<span class="muted">none</span>` : Array.isArray(v) ? v.join(', ') : String(v)}</dd>`;
  return layout(pathOf(url), h`
    <p class="small"><a href="/site/${site.id}">← ${host(site.url)}</a></p>
    <h1 style="overflow-wrap:anywhere">${pathOf(url)}</h1>
    <p class="muted small"><a href="${safeHref(url)}" target="_blank" rel="noopener">${url} ↗</a> · checked ${ago(snap.fetched_at)}${page.in_sitemap ? ' · in sitemap' : ' · not in sitemap'}</p>
    <h2>Problems on this page</h2>
    ${issues.length ? issues.map((f) => { const i = ruleInfo(f.rule_id); return h`<div class="card" style="margin-bottom:10px"><div class="row"><h3>${chip(f.severity)} ${i.title}</h3></div>
      <p class="small" style="margin-top:6px">${f.message}</p>${i.fix ? h`<div class="fix"><b>How to fix:</b> ${i.fix}</div>` : ''}</div>`; })
      : h`<div class="card">${chip('good')} No problems on this page.</div>`}
    <h2>What Google sees</h2>
    <div class="card"><dl class="kv">
      ${kv('Status', ex.status === 200 ? '200 OK' : ex.status || `failed (${ex.error})`)}${ex.redirect_hops ? kv('Redirects to', ex.final_url) : ''}
      ${kv('Title', ex.title)}${kv('Description', ex.meta_description)}${kv('Main heading', ex.h1)}
      ${kv('Canonical', ex.canonical)}${kv('Robots', ex.robots || 'index (default)')}${kv('Language', ex.lang)}
      ${kv('Translations', ex.hreflang.map((x: any) => `${x.lang} → ${pathOf(x.href)}`))}
      ${kv('Structured data', ex.jsonld_types)}${ex.faq_questions.length ? kv('FAQ questions', ex.faq_questions.length) : ''}${kv('Words', ex.word_count)}
    </dl></div>
    <h2>History</h2>
    ${evs.length ? h`<div class="card"><ul class="changes">${evs.map((e) => { const d = describeChange(e); return h`<li><span class="dot ${d.tone}"></span><div>
      <div>${d.text} <span class="muted small">· ${ago(e.finished_at)}</span></div>${(e.before || e.after) && e.field !== 'noindex' ? h`<div class="ba"><del>${clip(e.before)}</del> → <ins>${clip(e.after)}</ins></div>` : ''}</div></li>`; })}</ul></div>`
      : h`<div class="card empty">No changes recorded for this page yet.</div>`}`);
}

// ---------- server ----------
// One job at a time: crawls and discoveries share a small machine (and its live trading bots).
let queue: Promise<void> = Promise.resolve();
function enqueue(id: number, set: Set<number>, job: () => Promise<void>) {
  if (set.has(id)) return;
  set.add(id);
  queue = queue.then(job).catch((e) => console.error(e)).finally(() => set.delete(id));
}
function startRun(db: DatabaseSync, site: Site) {
  enqueue(site.id, running, async () => { const r = await runSite(db, site); const t = alertText(r); if (t) await sendAlert(t); });
}
function startDiscovery(db: DatabaseSync, site: Site) {
  discoveryError.delete(site.id);
  enqueue(site.id, discovering, async () => {
    try {
      const r = await discover(db, site, (m) => console.log(`[discover ${host(site.url)}] ${m}`));
      for (const d of r.stats.activated) { const c = db.prepare('SELECT s.* FROM competitor_candidates c JOIN sites s ON s.id = c.competitor_site_id WHERE c.site_id = ? AND c.domain = ?').get(site.id, d) as Site | undefined; if (c) startRun(db, c); }
    } catch (e) { discoveryError.set(site.id, (e as Error).message); throw e; }
  });
}

/** Competitors-tab forms. Throws a plain-language Error for bad input; every field is checked here. */
async function competitorPost(db: DatabaseSync, site: Site, route: string, form: URLSearchParams): Promise<void> {
  if (site.kind !== 'own') throw new Error('Competitors are set up on your own sites.');
  const lines = (k: string) => (form.get(k) ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  const str = (k: string, max: number) => { const v = (form.get(k) ?? '').trim(); if (v.length > max) throw new Error(`${k} is too long (max ${max} characters).`); return v; };
  const cand = (k: string) => {
    const id = form.get(k) ?? '';
    const c = /^\d+$/.test(id) ? (db.prepare('SELECT * FROM competitor_candidates WHERE id = ? AND site_id = ?').get(Number(id), site.id) as { id: number; status: string } | undefined) : undefined;
    if (!c) throw new Error('That competitor is not on this site’s list.');
    return c;
  };
  const watch = (id: number) => { const compId = activate(db, site, id); startRun(db, db.prepare('SELECT * FROM sites WHERE id = ?').get(compId) as Site); };

  if (route === '/discover') {
    if (!hasLlm()) throw new Error('Set ANTHROPIC_API_KEY in SEO-Watchdog/.env to enable competitor discovery.');
    return startDiscovery(db, site);
  }
  if (route === '/competitor') {
    const c = cand('cid'), action = form.get('action');
    const isWatched = WATCHED.includes(c.status);
    if (action === 'watch' && !isWatched) return watch(c.id);
    if (action === 'pin' && c.status === 'active') { db.prepare("UPDATE competitor_candidates SET status = 'pinned' WHERE id = ?").run(c.id); return; }
    if (action === 'unpin' && c.status === 'pinned') { db.prepare("UPDATE competitor_candidates SET status = 'active' WHERE id = ?").run(c.id); return; }
    if ((action === 'stop' || action === 'exclude') && (isWatched || action === 'exclude')) return deactivate(db, site, c.id, action === 'exclude');
    if (action === 'swap' && !isWatched) {
      const old = cand('replace');
      if (!WATCHED.includes(old.status)) throw new Error('The competitor to replace is not being watched.');
      deactivate(db, site, old.id, false);
      return watch(c.id);
    }
    throw new Error('That action does not apply to this competitor any more. The page may be out of date.');
  }
  if (route === '/competitor-add') {
    const compId = await addOwnCompetitor(db, site, str('url', 300));
    return startRun(db, db.prepare('SELECT * FROM sites WHERE id = ?').get(compId) as Site);
  }
  if (route === '/profile') {
    const country = str('country', 2).toUpperCase();
    if (country && !/^[A-Z]{2}$/.test(country)) throw new Error('Country takes a 2-letter code, e.g. MX.');
    const scope = form.get('scope') as Profile['scope'];
    if (!['local', 'national', 'online'].includes(scope)) throw new Error('Reach must be local, national or online.');
    const services = lines('services'), queries = [...new Set(lines('keywords'))];
    if (services.length > 20 || services.some((s) => s.length > 120)) throw new Error('Up to 20 services, 120 characters each.');
    if (!queries.length || queries.length > 15 || queries.some((q) => q.length > 120)) throw new Error('Give 1 to 15 searches, 120 characters each.');
    const saved = db.prepare('SELECT data_json FROM site_profiles WHERE site_id = ?').get(site.id) as { data_json: string } | undefined;
    const old: Partial<Profile> = saved ? JSON.parse(saved.data_json) : {};
    const prev = new Map((old.keywords ?? []).map((k) => [k.query.toLowerCase(), k]));
    const p: Profile = {
      business_name: old.business_name ?? host(site.url), languages: old.languages ?? [], brand_terms: old.brand_terms ?? [], evidence: old.evidence ?? '',
      industry: str('industry', 120), services, city: str('city', 80), region: str('region', 80), country, scope,
      // A query keeps its Search Console badge only if it was a real one before; anything typed in is not.
      keywords: queries.map((q) => prev.get(q.toLowerCase()) ?? { query: q, lang: old.languages?.[0] ?? '', from_gsc: false }),
    };
    if (!p.industry) throw new Error('Industry is required.');
    db.prepare("INSERT INTO site_profiles (site_id, data_json, source, updated_at) VALUES (?, ?, 'user', datetime('now')) ON CONFLICT(site_id) DO UPDATE SET data_json = excluded.data_json, source = 'user', updated_at = excluded.updated_at").run(site.id, JSON.stringify(p));
    return;
  }
  if (route === '/gsc') {
    const key = str('key', 500);
    if (!key.startsWith('/') || !key.endsWith('.json')) throw new Error('Give the full path to the key file, ending in .json.');
    const prop = await findProperty(key, site.url).catch((e: Error) => { throw new Error(e.message.startsWith('ENOENT') ? `No file at ${key}` : e.message); });
    db.prepare('UPDATE sites SET gsc_key = ?, gsc_property = ? WHERE id = ?').run(key, prop, site.id);
    return;
  }
  throw new Error('Unknown action.');
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 16_384) throw new Error('form too large'); }
  return new URLSearchParams(body);
}

export function startServer(port = Number(process.env.PORT) || 4321) {
  const db = openDb();
  setPriority(19); // live trading bots share this machine
  const send = (res: ServerResponse, status: number, html: string) => res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
  const redirect = (res: ServerResponse, to: string) => res.writeHead(303, { location: to }).end();
  const notFound = (res: ServerResponse) => send(res, 404, layout('Not found', h`<div class="card empty">Not found. <a href="/">Back to all sites</a></div>`));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const siteMatch = url.pathname.match(/^\/site\/(\d+)(\/[a-z-]+)?$/);
      const site = siteMatch ? (db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(siteMatch[1])) as Site | undefined) : undefined;
      if (req.method === 'POST') {
        // Localhost-only app, but a page in another tab could still POST here: require same-origin.
        const origin = req.headers.origin;
        if ((origin && new URL(origin).host !== req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, 'Cross-site request refused');
        const form = await readForm(req);
        if (url.pathname === '/sites') {
          const r = await addSite(db, { url: form.get('url') ?? '', market: form.get('market') ?? '' });
          if (!r.ok) return send(res, 400, overviewPage(db, { error: r.error }));
          startRun(db, db.prepare('SELECT * FROM sites WHERE id = ?').get(r.id) as Site);
          return redirect(res, `/site/${r.id}`);
        }
        if (!site) return notFound(res);
        const rule = form.get('rule') ?? '';
        if (siteMatch![2] === '/run') { startRun(db, site); return redirect(res, `/site/${site.id}`); }
        if (['/discover', '/competitor', '/competitor-add', '/profile', '/gsc'].includes(siteMatch![2])) {
          try { await competitorPost(db, site, siteMatch![2], form); }
          catch (e) { return send(res, 400, sitePage(db, site, 'competitors', false, (e as Error).message)); }
          return redirect(res, `/site/${site.id}?tab=competitors`);
        }
        if (siteMatch![2] === '/mute' && RULES[rule]) db.prepare("UPDATE findings SET status = 'muted' WHERE site_id = ? AND rule_id = ? AND status = 'open'").run(site.id, rule);
        else if (siteMatch![2] === '/unmute' && RULES[rule]) db.prepare("UPDATE findings SET status = 'open' WHERE site_id = ? AND rule_id = ? AND status = 'muted'").run(site.id, rule);
        else return notFound(res);
        return redirect(res, `/site/${site.id}?tab=issues`);
      }
      if (url.pathname === '/') return send(res, 200, overviewPage(db));
      if (site && !siteMatch![2]) return send(res, 200, sitePage(db, site, url.searchParams.get('tab') ?? '', url.searchParams.has('all')));
      if (site && siteMatch![2] === '/page') { const p = pageView(db, site, url.searchParams.get('url') ?? ''); return p ? send(res, 200, p) : notFound(res); }
      return notFound(res);
    } catch (e) {
      console.error(e);
      send(res, 500, layout('Error', h`<div class="card empty">Something went wrong: ${String(e)}</div>`));
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(`SEO Watchdog dashboard: http://127.0.0.1:${port}`));
  return server;
}
