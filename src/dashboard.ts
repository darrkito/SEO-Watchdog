// Localhost dashboard: plain-language health per site, issues ranked by urgency, changes as sentences.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setPriority } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, addSite, type Site } from './db.ts';
import { runSite } from './crawl.ts';
import { alertText, sendAlert } from './alert.ts';
import { ruleInfo, describeChange, RULES } from './catalog.ts';
import { h, raw, layout, chip, trendChart, safeHref, pathOf, ago, type Html, type Sev } from './html.ts';

type Counts = { critical: number; warn: number; info: number };
type Run = { id: number; status: string; started_at: string; finished_at: string | null; stats: any };
type Group = { rule_id: string; severity: Sev; n: number; items: { id: number; subject: string; message: string }[] };

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const running = new Set<number>();

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
  const sites = db.prepare('SELECT * FROM sites ORDER BY kind, id').all() as Site[];
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
    <div class="muted small">${x.r ? `Checked ${ago(x.r.finished_at)} · ${plural(x.r.stats.pages ?? 0, 'page')}` : 'Never checked'}</div></a>`;
  return layout('Overview', h`
    <div class="hero"><h1>Your websites</h1><p class="headline">${headline}</p>
      <p class="muted">${plural(own.length, 'site')} watched${rows.length > own.length ? ` · ${plural(rows.length - own.length, 'competitor')}` : ''}. Click a site to see what to fix and what changed.</p></div>
    ${msg?.error ? h`<div class="banner warn">${msg.error}</div>` : ''}${msg?.ok ? h`<div class="banner info">${msg.ok}</div>` : ''}
    ${sites.length ? h`<div class="grid-sites">${rows.map(card)}</div>` : ''}
    <h2>Watch a website</h2>
    <form class="add card" method="post" action="/sites">
      <label>Website address<input name="url" required placeholder="example.com" autocomplete="url" inputmode="url"></label>
      <label>Countries it sells to <input name="market" placeholder="MX or MX,US" maxlength="40"></label>
      <label>Competitor of
        <select name="competitorOf"><option value="">No, it's my site</option>${sites.filter((s) => s.kind === 'own').map((s) => h`<option value="${s.id}">${host(s.url)}</option>`)}</select></label>
      <button class="btn primary">Add site</button>
    </form>
    <p class="muted small">Countries are optional. They let the watchdog flag language tags that target the wrong country.</p>`, { refresh: running.size ? 8 : undefined });
}

function sitePage(db: DatabaseSync, site: Site, tab: string, showAll: boolean): string {
  const c = counts(db, site.id), run = lastRun(db, site.id), v = verdict(db, site, c, run);
  const runs = (db.prepare("SELECT * FROM runs WHERE site_id = ? AND status = 'ok' ORDER BY id DESC LIMIT 20").all(site.id) as any[]).reverse();
  const trend = runs.map((r) => ({ at: r.finished_at, ...JSON.parse(r.stats_json || '{}') })).filter((r) => r.open).map((r) => ({ at: r.at, critical: r.open.critical ?? 0, warn: r.open.warn ?? 0 }));
  const isRunning = running.has(site.id);
  const tabs = ['issues', 'changes', 'checks', 'pages'].filter((t) => site.kind === 'own' || t !== 'issues');
  const active = tabs.includes(tab) ? tab : tabs[0];
  const label: Record<string, string> = { issues: 'What to fix', changes: 'What changed', checks: 'Site checks', pages: 'All pages' };
  const body = active === 'issues' ? issuesTab(db, site, trend) : active === 'changes' ? changesTab(db, site, showAll) : active === 'checks' ? checksTab(db, site, run) : pagesTab(db, site);
  return layout(host(site.url), h`
    <p class="small"><a href="/">← All sites</a></p>
    <div class="row"><div><h1>${host(site.url)}</h1>
      <p class="muted small"><a href="${safeHref(site.url)}" target="_blank" rel="noopener">${site.url}</a>${site.kind === 'competitor' ? ' · competitor' : ''}${site.market ? ` · sells to ${site.market}` : ''}</p></div>
      <form method="post" action="/site/${site.id}/run"><button class="btn primary" ${isRunning ? raw('disabled') : ''}>${isRunning ? 'Checking…' : 'Check now'}</button></form></div>
    <p class="headline">${chip(v.sev, v.sev === 'critical' ? 'Fix now' : v.sev === 'warn' ? 'Needs a look' : v.sev === 'good' ? 'Healthy' : 'Info')} ${v.text}</p>
    ${run ? h`<div class="stats">
      <div class="card stat"><div class="v">${run.stats.pages ?? 0}</div><div class="k">pages checked ${ago(run.finished_at)}</div></div>
      ${site.kind === 'own' ? h`<div class="card stat"><div class="v">${c.critical}</div><div class="k">problems to fix now</div></div>
      <div class="card stat"><div class="v">${c.warn}</div><div class="k">things to improve</div></div>
      <div class="card stat"><div class="v">${run.stats.resolved ?? 0}</div><div class="k">fixed since the check before</div></div>` : ''}
      <div class="card stat"><div class="v">${run.stats.events ?? 0}</div><div class="k">changes found in the last check</div></div></div>` : ''}
    <nav class="tabs">${tabs.map((t) => h`<a href="?tab=${t}" class="${t === active ? 'on' : ''}">${label[t]}</a>`)}</nav>
    ${body}`, { refresh: isRunning ? 6 : undefined });
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
function startRun(db: DatabaseSync, site: Site) {
  if (running.has(site.id)) return;
  running.add(site.id);
  runSite(db, site)
    .then(async (r) => { const t = alertText(r); if (t) await sendAlert(t); })
    .catch((e) => console.error(`run ${site.url} failed:`, e))
    .finally(() => running.delete(site.id));
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
      const siteMatch = url.pathname.match(/^\/site\/(\d+)(\/[a-z]+)?$/);
      const site = siteMatch ? (db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(siteMatch[1])) as Site | undefined) : undefined;
      if (req.method === 'POST') {
        // Localhost-only app, but a page in another tab could still POST here: require same-origin.
        const origin = req.headers.origin;
        if ((origin && new URL(origin).host !== req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, 'Cross-site request refused');
        const form = await readForm(req);
        if (url.pathname === '/sites') {
          const r = await addSite(db, { url: form.get('url') ?? '', market: form.get('market') ?? '', competitorOf: form.get('competitorOf') || undefined });
          if (!r.ok) return send(res, 400, overviewPage(db, { error: r.error }));
          startRun(db, db.prepare('SELECT * FROM sites WHERE id = ?').get(r.id) as Site);
          return redirect(res, `/site/${r.id}`);
        }
        if (!site) return notFound(res);
        const rule = form.get('rule') ?? '';
        if (siteMatch![2] === '/run') { startRun(db, site); return redirect(res, `/site/${site.id}`); }
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
