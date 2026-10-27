// The fleet. Each agent = deterministic prep (SQL/git) + one `claude -p` call on the subscription + deterministic checks.
// Nothing here pushes to production without passing typecheck, a path allowlist, and (unless autonomy=auto and low risk) a human approval.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Site } from '../db.ts';
import { runSite } from '../crawl.ts';
import { alertText, sendAlert } from '../alert.ts';
import { battle } from '../gaps.ts';
import { collect } from './collect.ts';
import { blogScores } from './blogscore.ts';
import { audienceBrief, customerQuestions, seoPlaybook, segmentOf, TARGET } from './audience.ts';
import { runClaude, extractJson, type ClaudeResult } from './runner.ts';
import { AGENT_SITES, pathAllowed, type AgentSite } from './sites.ts';

export class LimitError extends Error {}
export type Ctx = { db: DatabaseSync; site: Site; cfg: AgentSite | undefined; usage: ClaudeResult[]; log: (m: string) => void; args?: { slug?: string; ids?: number[]; topicId?: number } };
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
const git = (cwd: string, ...a: string[]) => sh(cwd, 'git', a);
/** git against the site's remote. With `remoteUrl` the remote is defined for this one command only (the owner's checkout stays untouched). */
const gitRemote = (cfg: AgentSite, ...a: string[]) => git(cfg.worktree, ...(cfg.remoteUrl ? ['-c', `remote.${cfg.remote}.url=${cfg.remoteUrl}`, '-c', `remote.${cfg.remote}.fetch=+refs/heads/*:refs/remotes/${cfg.remote}/*`] : []), ...a);

async function ask(c: Ctx, o: { prompt: string; cwd: string; tools: string[]; maxTurns: number; timeoutMs: number }): Promise<string> {
  const r = await runClaude(o);
  c.usage.push(r);
  if (r.limited) throw new LimitError(r.error ?? 'usage limit');
  if (!r.ok) throw new Error(r.error ?? 'claude failed');
  return r.text;
}

const audience = (c: Ctx) => audienceBrief(new URL(c.site.url).hostname) + seoPlaybook();
/** Ranking used to pick the next topic: the owner's target customers first, bulk/industrial last. */
export const TOPIC_ORDER = "(score + CASE segment WHEN 'event' THEN 3 WHEN 'corporate-event' THEN 3 WHEN 'planner' THEN 3 WHEN 'bulk' THEN -4 ELSE 0 END)";

// ---------- worktree ----------
/** A clean checkout of origin/main on `branch`, in the agents' own worktree (the owner's checkout is never touched). */
export function prepareWorktree(cfg: AgentSite, branch: string): string {
  if (!existsSync(cfg.worktree)) git(cfg.repo, 'worktree', 'add', '--detach', cfg.worktree, 'HEAD');
  gitRemote(cfg, 'fetch', cfg.remote, 'main');
  git(cfg.worktree, 'reset', '--hard');
  git(cfg.worktree, 'clean', '-fd');
  git(cfg.worktree, 'checkout', '-B', branch, `${cfg.remote}/main`);
  const nm = join(cfg.worktree, 'node_modules');
  if (!existsSync(nm) && existsSync(join(cfg.repo, 'node_modules'))) symlinkSync(join(cfg.repo, 'node_modules'), nm);
  return cfg.worktree;
}
// node_modules is a symlink to the owner's install: some repos ignore `node_modules/` (directories only), so it must never be staged.
const changedFiles = (wt: string) => { git(wt, 'add', '-A', '--', '.', ':(exclude)node_modules'); return git(wt, 'diff', '--cached', '--name-only').split('\n').filter(Boolean); };
const typecheck = (cfg: AgentSite) => { try { sh(cfg.worktree, cfg.typecheck[0], cfg.typecheck.slice(1), 900_000); return null; } catch (e) { return String((e as any).stdout ?? e).slice(0, 1500); } };
const commit = (wt: string, msg: string) => git(wt, 'commit', '-m', `${msg}\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`);

/** Added lines only: the em-dash rule applies to new copy, not to what already exists. */
export function addedLines(diff: string): string[] { return diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)); }
export function lintAdded(diff: string): string[] {
  const added = addedLines(diff), bad: string[] = [];
  if (added.some((l) => l.includes('—'))) bad.push('em-dash in new copy');
  if (added.some((l) => /\b(100% garantizad|el mejor del mundo|certificad[oa] iso)/i.test(l))) bad.push('unverifiable superlative/certification claim');
  return bad;
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
    cwd: c.cfg?.worktree && existsSync(c.cfg.worktree) ? c.cfg.worktree : '/tmp', tools: [], maxTurns: 2, timeoutMs: 300_000,
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
/** Get Found: how to pick keywords. The researcher is told, and the writer later runs the mini audit against the real #1. */
const KEYWORD_CRITERIA = `Criterios del playbook para elegir cada tema (aplícalos y verifícalos con búsquedas reales): (1) palabra clave long-tail de 3 o más palabras con intención clara (informativa, comercial o transaccional); (2) perenne antes que de moda; (3) con modificador geográfico cuando el negocio es local; (4) baja dificultad: que los primeros resultados sean sitios pequeños o genéricos, no marcas enormes (estrategia avalancha, 10 a 100 búsquedas al mes al empezar); (5) responde una pregunta concreta de un cliente real (revisa "otras preguntas de la gente" y las dudas del brief); (6) no canibaliza un post existente: si se parece, usa action "merge:<slug>". En "why" di qué verificaste en los primeros resultados.`;

type Topic = { title: string; slug: string; query: string; action: string; why: string; score: number };

export const researcherAgent: AgentFn = async (c) => {
  if (!c.cfg) throw new Error('no agent config for this site');
  const posts = c.cfg.listPosts(c.cfg.repo), s = weeklySummary(c.db, c.site.id, !!c.cfg.segments), b = battle(c.db, c.site);
  const top = c.db.prepare("SELECT query, SUM(clicks) clicks, SUM(impressions) impressions, ROUND(SUM(position*impressions)/NULLIF(SUM(impressions),0),1) position FROM metrics WHERE site_id = ? AND source = 'gsc' AND date >= ? GROUP BY query ORDER BY impressions DESC LIMIT 40").all(c.site.id, dayAgo(60));
  const backlog = c.db.prepare("SELECT slug FROM topics WHERE site_id = ?").all(c.site.id).map((r: any) => r.slug);
  const wt = prepareWorktree(c.cfg, 'agent/research');
  const text = await ask(c, {
    cwd: wt, tools: ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob'], maxTurns: 25, timeoutMs: 1_200_000,
    prompt: `Eres el investigador de temas SEO y GEO de ${c.site.url}. Escribe los temas, el campo query y el slug en ${c.cfg.lang === 'en' ? 'inglés' : 'español'}. Propón hasta 8 temas de blog NUEVOS que aún no cubrimos y que pueden traer búsquedas reales o ser citados por buscadores con IA.
Datos reales (no inventes volúmenes de búsqueda; usa solo estos números y lo que verifiques en la web):
- Consultas de Search Console (60 días): ${JSON.stringify(top)}
- Consultas cerca de la primera página (posición 8-20): ${JSON.stringify(s.strikingDistance)}
- Temas donde la competencia tiene más páginas que nosotros: ${JSON.stringify(b?.topicGaps?.slice(0, 12) ?? [])}
- Posts que YA existen (no los dupliques; si un tema se parece, usa action "merge:<slug-existente>" para ampliarlo): ${JSON.stringify(posts)}
- Slugs ya en el backlog (no repetir): ${JSON.stringify(backlog)}
${c.cfg.research.context}
${c.cfg.research.priority} Considera la temporada (hoy es ${mxNow().date}).
${KEYWORD_CRITERIA}
${audience(c)}${customerQuestions(new URL(c.site.url).hostname)}
Responde SOLO con un arreglo JSON, sin texto extra: [{"title":"...","slug":"kebab-case","query":"búsqueda principal","action":"new"|"merge:<slug>","why":"evidencia concreta, máx 40 palabras","score":1-10}]
${c.cfg.rules}\n${c.cfg.writerRules}`,
  });
  const topics = extractJson<Topic[]>(text).filter((t) => t.title && /^[a-z0-9-]+$/.test(t.slug));
  const ins = c.db.prepare('INSERT OR IGNORE INTO topics (site_id, title, slug, query, action, why, score, segment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const taken = new Set(posts.map((p) => p.slug));
  let n = 0;
  for (const t of topics) { if (t.action === 'new' && taken.has(t.slug)) continue; n += Number(ins.run(c.site.id, t.title, t.slug, t.query ?? '', t.action ?? 'new', t.why ?? '', Number(t.score) || 0, segmentOf(`${t.title} ${t.query}`)).changes); }
  return `${n} new topics in the backlog (${topics.length} proposed)`;
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
  return lines.map((l) => l.match(/heading:\s*"([^"]{8,80})"/)?.[1]).find(Boolean) ?? md ?? lines.map((l) => l.match(/^\s*"([^"\\]{30,70})/)?.[1]).find(Boolean);
}

function approvalFor(c: Ctx, kind: string, title: string, payload: object, diff: string): number {
  return Number(c.db.prepare('INSERT INTO approvals (site_id, agent, kind, title, payload_json, diff) VALUES (?, ?, ?, ?, ?, ?)').run(c.site.id, kind === 'post' ? 'writer' : 'fixer', kind, title, JSON.stringify(payload), diff).lastInsertRowid);
}

/** From the Get Found playbook: compare against the #1 result before writing, and place the keyword where it counts. Operational, so the writer cannot skip it. */
const MINI_AUDIT = `Antes de escribir haz la mini auditoría del playbook: busca en la web la consulta principal, abre los 3 primeros resultados y anota sus palabras, sus H2 y cuántas veces usan la palabra clave. Tu texto cubre lo mismo con tus propias palabras (no copies encabezados idénticos) y supera ligeramente al #1 en profundidad útil, no en relleno. La palabra clave principal va en title (<=60 caracteres), meta description (80 a 156), URL, H1 y al menos un H2. Mínimo 3 enlaces internos, al menos uno a la página que vende (producto o servicio) con ancla descriptiva de 1 a 5 palabras. Cada H2 abre con una respuesta directa de 40 a 60 palabras. Si algo no lo puedes verificar, déjalo fuera.`;

type Draftable = { id: number | null; title: string; slug: string; query: string; why: string; action: string; improve?: boolean };

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
  return draftTopic(c, { id: null, title: row.title || slug, slug, query: row.topQuery ?? '', action: `merge:${slug}`, improve: true,
    why: `${row.reasons.join('; ')}${row.impressions ? `. Search Console 90d: ${row.impressions} impresiones, ${row.clicks} clics, posición media ${row.position}` : '. Sin datos de búsqueda aún'}` }, mxNow().date);
};

async function draftTopic(c: Ctx, topic: Draftable, publishAt: string): Promise<string> {
  const cfg = c.cfg!;
  // unique per run: a re-run (restart, retry) must never reset the branch of a draft that is still waiting for approval
  const branch = `agent/post-${topic.slug}${topic.improve ? '-' + publishAt : ''}-${Date.now().toString(36)}`;
  const wt = prepareWorktree(cfg, branch);
  const merge = String(topic.action).startsWith('merge:') ? String(topic.action).slice(6) : null;
  if (!cfg.postBrief) throw new Error('this site has no writer brief configured');
  const opts = { slug: merge ?? topic.slug, improve: !!topic.improve, merge };
  const brief = cfg.postBrief({ kind: topic.improve ? 'improve' : merge ? 'merge' : 'new', title: topic.title, slug: topic.slug, query: topic.query, why: topic.why, merge, publishAt });
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
  /** Deterministic checks after every model edit: regenerate derived files, typecheck, then the site's "is it wired in everywhere" rules. */
  const verify = (): string | null => {
    try { cfg.postEdit?.(wt, opts); } catch (e) { return `post-edit step failed: ${String((e as any).stderr ?? (e as Error).message).slice(0, 600)}`; }
    const tc = typecheck(cfg); if (tc) return tc;
    const v = cfg.validate?.(wt, opts) ?? [];
    return v.length ? `The post is not wired in correctly:\n- ${v.join('\n- ')}` : null;
  };
  let text = await run();
  let err = verify();
  if (err) { text = await run(`Los chequeos automáticos fallaron, corrige solo esto:\n${err}`); err = verify(); }
  const files = changedFiles(wt), diff = git(wt, 'diff', '--cached');
  const bad = [...(err ? [`checks: ${err.slice(0, 300)}`] : []), ...files.filter((f) => !pathAllowed(cfg.contentPaths, f)).map((f) => `touched forbidden file ${f}`), ...(files.length ? [] : ['no changes made']), ...lintAdded(diff)];
  if (bad.length) { git(wt, 'reset', '--hard'); throw new Error(`draft rejected by checks: ${bad.join('; ')}`); }
  const meta = extractJson<{ slug: string; enSlug?: string; claims?: unknown[] }>(text);
  commit(wt, `content(blog): ${topic.title}`);
  const slug = merge ?? meta.slug ?? topic.slug;
  const enSlug = enSlugFor(cfg, slug, meta.enSlug);
  const id = approvalFor(c, 'post', `${topic.improve ? 'Improve' : merge ? 'Update' : 'New post'}: ${topic.title}`, { branch, slug, enSlug, topicId: topic.id ?? null, publishAt, files, claims: meta.claims ?? [], urls: cfg.blogUrl(slug, enSlug), marker: pickMarker(diff) }, diff);
  if (topic.id) c.db.prepare("UPDATE topics SET status = 'drafted' WHERE id = ?").run(topic.id);
  await sendAlert(`✍️ Borrador listo para aprobar: ${topic.title} (${topic.improve ? 'mejora de post existente' : 'publicar ' + publishAt}). Revisa en el dashboard: /agents`);
  return `draft #${id} "${topic.title}" for ${publishAt}: ${files.length} files`;
};


// ---------- fixer ----------
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
  const text = await ask(c, {
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
  const forbidden = files.filter((f) => FORBIDDEN.test(f)), err = typecheck(cfg), lint = lintAdded(diff);
  if (forbidden.length || err || lint.length) { git(wt, 'reset', '--hard'); throw new Error(`fix rejected by checks: ${[...forbidden.map((f) => `forbidden ${f}`), err ? `typecheck ${err.slice(0, 200)}` : '', ...lint].filter(Boolean).join('; ')}`); }
  const meta = (() => { try { return extractJson<{ fixed?: number[]; skipped?: unknown[] }>(text); } catch { return {} as { fixed?: number[]; skipped?: unknown[] }; } })();
  commit(wt, `seo(fix): ${meta.fixed?.length ?? files.length} watchdog findings\n\nFindings: ${(meta.fixed ?? []).join(', ')}`);
  const low = files.every((f) => pathAllowed(cfg.lowRiskPaths, f));
  if (autonomy === 'auto' && low) { pushAndVerify(cfg, []); return `pushed ${files.length} low-risk files (${(meta.fixed ?? []).length} findings)`; }
  const id = approvalFor(c, 'fix', `Fix ${meta.fixed?.length ?? files.length} findings (${files.length} files${low ? '' : ', touches code outside content'})`, { branch, files, fixed: meta.fixed ?? [], skipped: meta.skipped ?? [], urls: [] }, diff);
  await sendAlert(`🔧 Lote de correcciones listo para aprobar (#${id}, ${files.length} archivos). Revisa en el dashboard: /agents`);
  return `fix batch approval #${id}: ${files.length} files`;
};

// ---------- publish ----------
/** Rebase onto the latest main, typecheck, push. Throws on any conflict or failure; never force-pushes. */
export function pushAndVerify(cfg: AgentSite, _urls: string[]): void {
  const wt = cfg.worktree;
  gitRemote(cfg, 'fetch', cfg.remote, 'main');
  try { git(wt, 'rebase', `${cfg.remote}/main`); } catch (e) { try { git(wt, 'rebase', '--abort'); } catch { /* none in progress */ } throw new Error(`rebase conflict: ${String((e as any).stderr ?? e).slice(0, 300)}`); }
  const err = typecheck(cfg); if (err) throw new Error(`typecheck after rebase: ${err.slice(0, 300)}`);
  gitRemote(cfg, 'push', cfg.remote, 'HEAD:main');
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
    pushAndVerify(cfg, p.urls);
    console.log(`[publish #${a.id}] pushed; confirming the deploy in the background`);
    if (cfg.deployHint) await sendAlert(`📤 ${a.title}: ${cfg.deployHint}`);
    // The push is the only step that needs the shared worktree. Waiting for Vercel (minutes) must not hold up the next publish,
    // so the live check, IndexNow and the final status run detached. A restart before it finishes simply repeats it (the push is a no-op).
    void (async () => {
      let note = 'pushed';
      try {
        if (p.urls?.length) {
          const mins = cfg.liveTimeoutMin ?? 15;
          const live = await waitLive(p.urls.slice(0, 1), p.marker, mins * 60_000, mins > 15 ? 120_000 : 30_000); // the ES page carries the marker; EN follows the same deploy
          note = live ? 'live (200)' : `pushed, but not live after ${mins >= 120 ? Math.round(mins / 60) + ' h' : mins + ' min'}: ${cfg.deployHint ?? 'check Vercel'}`;
          if (live && cfg.indexnow) { try { sh(cfg.worktree, cfg.indexnow[0], [...cfg.indexnow.slice(1), ...p.urls]); note += ', IndexNow sent'; } catch (e) { note += `, IndexNow failed: ${String(e).slice(0, 120)}`; } }
          if (live && cfg.indexnowKey) { try { note += `, ${await submitIndexNow(cfg, p.urls)}`; } catch (e) { note += `, IndexNow failed: ${String(e).slice(0, 120)}`; } }
        }
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
