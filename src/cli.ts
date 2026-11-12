#!/usr/bin/env node
// SEO Watchdog CLI. Every site is user input; nothing here knows about any particular website.
import { parseArgs } from 'node:util';
try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch { /* .env is optional */ }
import { setPriority } from 'node:os';
import { openDb, findSite, addSite, type Site } from './db.ts';
import { runSite } from './crawl.ts';
import { alertText, sendAlert } from './alert.ts';

const HELP = `seo-watchdog <command>

  add <url> [--market MX,US] [--limit 500] [--competitor-of <site>] [--ua googlebot|bingbot|default|"<string>"]
                            watch a site (own by default; --competitor-of marks it as a rival).
                            Own sites are fetched as Googlebot unless --ua says otherwise.
  sites                     list watched sites
  run <site|all> [--concurrency 2] [--no-alert]
                            crawl, snapshot, diff, update findings, alert on new criticals
  findings <site> [--severity critical|warn|info] [--status open|resolved|muted|all]
  changes <site> [--run <id>]   change events from a run (default: latest)
  gsc <site> <key.json>     connect Search Console (service-account key) for real keyword demand
  discover <site>           find the site's top competitors (needs ANTHROPIC_API_KEY; SERPER_API_KEY optional)
  competitors <site>        list discovered competitors and alternatives
  serve [port]              localhost dashboard (default http://127.0.0.1:4321); also runs the agent scheduler
  agent <name> <site>       run one agent now and wait (crawl|collect|analyst|researcher|writer|fixer)
  research-replay <site> [--no-expand]  report demand clusters without an LLM
  tokens [days]             token and cost report (default: 7 days)
  approvals                 list pending drafts/fixes; approve|reject <id> decides one
  mute <finding-id> | unmute <finding-id>
  remove <site>

<site> = id, URL or host. Env: WATCHDOG_DATA, WATCHDOG_CONTACT, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID`;

const { positionals: [cmd, arg], values: opt } = parseArgs({
  allowPositionals: true,
  options: {
    market: { type: 'string' }, limit: { type: 'string' }, 'competitor-of': { type: 'string' }, ua: { type: 'string' },
    concurrency: { type: 'string' }, 'no-alert': { type: 'boolean' }, 'no-expand': { type: 'boolean' },
    severity: { type: 'string' }, status: { type: 'string' }, run: { type: 'string' },
  },
});
const db = openDb();
const die = (m: string): never => { console.error(m); process.exit(1); };
const site = (ref?: string): Site => findSite(db, ref ?? die('missing <site>')) ?? die(`unknown site: ${ref} (see: sites)`);
const posInt = (v: string | undefined, d: number, name: string) => {
  if (v == null) return d;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : die(`--${name} must be a positive integer`);
};

switch (cmd) {
  case 'add': {
    if (!arg) die('usage: add <url>');
    const r = await addSite(db, { url: arg!, market: opt.market, limit: posInt(opt.limit, 500, 'limit'), competitorOf: opt['competitor-of'], ua: opt.ua });
    if (!r.ok) die(r.error);
    else console.log(`#${r.id} ${r.url} (${r.note})`);
    break;
  }
  case 'sites': {
    const rows = db.prepare(`SELECT s.id, s.url, s.kind, s.market, s.page_limit,
      (SELECT status || ' ' || COALESCE(finished_at, started_at) FROM runs WHERE site_id = s.id ORDER BY id DESC LIMIT 1) last_run,
      (SELECT COUNT(*) FROM findings WHERE site_id = s.id AND status = 'open') open FROM sites s ORDER BY s.id`).all();
    console.table(rows);
    break;
  }
  case 'run': {
    setPriority(19); // live trading bots share this machine
    const targets = arg === 'all' ? (db.prepare('SELECT * FROM sites ORDER BY id').all() as Site[]) : [site(arg)];
    for (const s of targets) {
      console.log(`→ ${s.url}`);
      const r = await runSite(db, s, { concurrency: posInt(opt.concurrency, 2, 'concurrency'), log: (m) => console.log('  ' + m) });
      console.log(`  run #${r.runId} ${r.status}: ${r.pages} pages${r.truncated ? ' (limit hit)' : ''}, ${r.events} changes, ` +
        `${r.newFindings.length} new / ${r.resolved.length} resolved findings, open ${JSON.stringify(r.open)}, ${r.seconds}s`);
      const text = alertText(r);
      if (text) { console.log(text); if (!opt['no-alert'] && !(await sendAlert(text))) console.log('  (no Telegram configured; alert printed only)'); }
    }
    break;
  }
  case 'findings': {
    const s = site(arg);
    const st = opt.status ?? 'open';
    const rows = db.prepare(`SELECT id, severity sev, rule_id rule, message, subject, ref FROM findings
      WHERE site_id = ? AND (? = 'all' OR status = ?) AND (? IS NULL OR severity = ?)
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, rule_id, subject`)
      .all(s.id, st, st, opt.severity ?? null, opt.severity ?? null) as any[];
    for (const r of rows) console.log(`#${r.id} [${r.sev}] ${r.rule}: ${r.message}${r.subject ? `\n    ${r.subject}` : ''}${r.ref ? `  (${r.ref})` : ''}`);
    console.log(`${rows.length} ${st} finding(s)`);
    break;
  }
  case 'changes': {
    const s = site(arg);
    const runId = opt.run ? posInt(opt.run, 0, 'run') : (db.prepare('SELECT MAX(id) id FROM runs WHERE site_id = ?').get(s.id) as { id: number | null }).id;
    if (!runId) die('no runs yet');
    const rows = db.prepare('SELECT type, field, before, after, subject FROM events WHERE site_id = ? AND run_id = ? ORDER BY type, subject').all(s.id, runId) as any[];
    const clip = (v: string | null) => (v == null ? '∅' : v.length > 120 ? v.slice(0, 117) + '…' : v);
    for (const e of rows) console.log(`${e.type}${e.field ? `.${e.field}` : ''}  ${e.subject || '(site)'}${e.before != null || e.after != null ? `\n    ${clip(e.before)}  →  ${clip(e.after)}` : ''}`);
    console.log(`${rows.length} change(s) in run #${runId}`);
    break;
  }
  case 'gsc': {
    const s = site(arg);
    const key = process.argv.slice(2).filter((a) => !a.startsWith('--'))[2] ?? die('usage: gsc <site> <service-account-key.json>');
    const { findProperty } = await import('./gsc.ts');
    const prop = await findProperty(key, s.url).catch((e) => die(e.message));
    db.prepare('UPDATE sites SET gsc_key = ?, gsc_property = ? WHERE id = ?').run(key, prop, s.id);
    console.log(`connected ${s.url} → Search Console property ${prop}`);
    break;
  }
  case 'discover': {
    const { discover } = await import('./competitors.ts');
    const r = await discover(db, site(arg), (m) => console.log('  ' + m)).catch((e) => die(e.message));
    console.log(`discovery #${r.discoveryId}: ${JSON.stringify(r.stats)}`);
    break;
  }
  case 'competitors': {
    const { candidates } = await import('./competitors.ts');
    for (const c of candidates(db, site(arg).id).filter((c) => c.status !== 'rejected'))
      console.log(`[${c.status}] ${c.domain}  score ${c.score}  ${c.types.join('+')}  ${c.evidence.overlap ?? 0} shared keywords${c.evidence.best ? `, best #${c.evidence.best}` : ''}${c.evidence.reason ? `\n    ${c.evidence.reason}` : ''}`);
    break;
  }
  case 'research-replay': {
    const s = site(arg), { AGENT_SITES } = await import('./agents/sites.ts');
    const { buildDemandPool, clusterQueries, replayReport } = await import('./agents/topicdata.ts');
    const cfg = AGENT_SITES[new URL(s.url).hostname.replace(/^www\./, '')];
    const row = db.prepare('SELECT data_json FROM site_profiles WHERE site_id = ?').get(s.id) as { data_json: string } | undefined;
    let profile: any = {}; try { profile = JSON.parse(row?.data_json ?? '{}'); } catch { /* no profile */ }
    const posts = cfg?.listPosts(cfg.repo) ?? [];
    const backlog = db.prepare('SELECT slug FROM topics WHERE site_id = ?').all(s.id) as { slug: string }[];
    const pool = await buildDemandPool(db, s.id, { lang: cfg?.lang ?? (s.market.split(',')[0]?.trim().toUpperCase() === 'US' ? 'en' : 'es'), country: s.market.split(',')[0]?.trim() || profile.country || '', location: profile.city || '', services: Array.isArray(profile.services) ? profile.services : [], brandTerms: Array.isArray(profile.brand_terms) ? profile.brand_terms : [], taken: [...posts.flatMap((p) => [p.slug, p.title]), ...backlog.map((p) => p.slug)] }, { expand: !opt['no-expand'] });
    console.log(replayReport(clusterQueries(pool), pool));
    break;
  }
  case 'agent': {
    setPriority(19);
    const { runAgent, seedSettings } = await import('./agents/scheduler.ts');
    const name = arg ?? die('usage: agent <name> <site>');
    const s = site(process.argv.slice(2).filter((a) => !a.startsWith('--'))[2]);
    seedSettings(db);
    await runAgent(db, name, s);
    const r = db.prepare('SELECT * FROM agent_runs ORDER BY id DESC LIMIT 1').get() as any;
    console.log(`#${r.id} ${r.agent} ${r.status} ${r.tokens_in} in / ${r.tokens_out} out\n${r.error ?? ''}${r.output ?? ''}`);
    process.exit(r.status === 'ok' ? 0 : 1);
  }
  case 'tokens': {
    const days = posInt(arg, 7, 'days');
    const window = `-${days} days`;
    const table = (headers: string[], rows: string[][]) => {
      const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
      for (const row of [headers, ...rows]) console.log(row.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd());
    };
    const runs = db.prepare(`SELECT agent, status, COUNT(*) runs, AVG(tokens_in) avg_in, AVG(tokens_out) avg_out,
      SUM(cost_usd) total_cost, AVG(cost_usd) avg_cost FROM agent_runs
      WHERE started_at >= datetime('now', ?) AND agent NOT IN ('crawl', 'collect') GROUP BY agent, status ORDER BY agent, status`).all(window) as any[];
    console.log('Runs by agent and status');
    table(['agent', 'status', 'runs', 'avg tokens_in', 'avg tokens_out', 'total cost', 'avg cost'], runs.map((r) => [r.agent, r.status, String(r.runs), r.avg_in.toFixed(0), r.avg_out.toFixed(0), `$${r.total_cost.toFixed(4)}`, `$${r.avg_cost.toFixed(4)}`]));
    const calls = db.prepare(`SELECT r.agent, c.role, COUNT(*) calls, AVG(c.fresh) fresh, AVG(c.cache_write) cache_write,
      AVG(c.cache_read) cache_read, AVG(c.tokens_out) tokens_out, SUM(c.cost_usd) total_cost, AVG(c.cost_usd) avg_cost
      FROM agent_calls c JOIN agent_runs r ON r.id = c.run_id WHERE r.started_at >= datetime('now', ?)
      GROUP BY r.agent, c.role ORDER BY r.agent, c.role`).all(window) as any[];
    console.log('\nCalls by agent and role');
    table(['agent', 'role', 'calls', 'avg fresh', 'avg cache_write', 'avg cache_read', 'avg tokens_out', 'total cost', 'avg cost'], calls.map((r) => [r.agent, r.role, String(r.calls), r.fresh.toFixed(0), r.cache_write.toFixed(0), r.cache_read.toFixed(0), r.tokens_out.toFixed(0), `$${r.total_cost.toFixed(4)}`, `$${r.avg_cost.toFixed(4)}`]));
    const costs = db.prepare(`SELECT agent, SUM(cost_usd) total_cost, SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) ok_runs
      FROM agent_runs WHERE started_at >= datetime('now', ?) AND agent IN ('writer', 'improver') GROUP BY agent`).all(window) as any[];
    console.log('\nCost per ok run');
    table(['agent', 'cost per ok run'], ['writer', 'improver'].map((agent) => {
      const row = costs.find((r) => r.agent === agent);
      return [agent, row?.ok_runs ? `$${(row.total_cost / row.ok_runs).toFixed(4)}` : 'n/a'];
    }));
    break;
  }
  case 'approvals': {
    for (const a of db.prepare("SELECT id, kind, title, status, created_at FROM approvals ORDER BY id DESC LIMIT 20").all() as any[]) console.log(`#${a.id} [${a.status}] ${a.kind}: ${a.title} (${a.created_at})`);
    break;
  }
  case 'approve':
  case 'reject': {
    const { decide, serial } = await import('./agents/scheduler.ts');
    decide(db, posInt(arg, 0, 'id'), cmd);
    await serial(async () => {}); // wait for the queued publish
    console.log((db.prepare('SELECT status, note FROM approvals WHERE id = ?').get(Number(arg)) as any));
    process.exit(0);
  }
  case 'serve': {
    const { startServer } = await import('./dashboard.ts');
    startServer(arg ? posInt(arg, 4321, 'port') : undefined);
    break;
  }
  case 'mute':
  case 'unmute': {
    const id = posInt(arg, 0, 'finding-id');
    const r = db.prepare('UPDATE findings SET status = ? WHERE id = ?').run(cmd === 'mute' ? 'muted' : 'open', id);
    console.log(r.changes ? `#${id} ${cmd}d` : `no finding #${id}`);
    break;
  }
  case 'remove': {
    const s = site(arg);
    db.prepare('DELETE FROM sites WHERE id = ?').run(s.id);
    console.log(`removed #${s.id} ${s.url} and its history`);
    break;
  }
  default:
    console.log(HELP);
}
