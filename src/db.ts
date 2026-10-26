// SQLite store (node:sqlite, zero deps). Plain SQL kept Postgres-portable for the SaaS move.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DATA_DIR = process.env.WATCHDOG_DATA || join(import.meta.dirname, '..', 'data');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL DEFAULT 1, url TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'own' CHECK (kind IN ('own','competitor')),
  parent_site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  market TEXT NOT NULL DEFAULT '', page_limit INTEGER NOT NULL DEFAULT 500,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (org_id, url));
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running', stats_json TEXT);
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  url TEXT NOT NULL, first_seen TEXT NOT NULL DEFAULT (datetime('now')), last_seen TEXT,
  in_sitemap INTEGER NOT NULL DEFAULT 0, UNIQUE (site_id, url));
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY, page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')), status INTEGER, html_hash TEXT, extract_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS snapshots_page ON snapshots(page_id, run_id);
CREATE TABLE IF NOT EXISTS site_snapshots (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE, kind TEXT NOT NULL, data_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE, subject TEXT NOT NULL,
  type TEXT NOT NULL, field TEXT, before TEXT, after TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL, subject TEXT NOT NULL, severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','muted')),
  message TEXT NOT NULL, evidence_json TEXT, ref TEXT,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')), last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_run_id INTEGER, UNIQUE (site_id, rule_id, subject));
CREATE TABLE IF NOT EXISTS site_profiles (
  site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE, data_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('auto','user')), updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS discoveries (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (datetime('now')), provider TEXT NOT NULL, model TEXT NOT NULL, keywords_json TEXT NOT NULL, stats_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS competitor_candidates (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  domain TEXT NOT NULL, url TEXT NOT NULL, score REAL NOT NULL DEFAULT 0, types_json TEXT, evidence_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('suggested','active','pinned','user_added','excluded','directory','rejected')),
  discovery_id INTEGER REFERENCES discoveries(id) ON DELETE SET NULL,
  competitor_site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL, UNIQUE (site_id, domain));
-- Agent fleet (src/agents). site_id 0 + agent '*' is the global kill switch.
CREATE TABLE IF NOT EXISTS agent_settings (
  agent TEXT NOT NULL, site_id INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  autonomy TEXT NOT NULL DEFAULT 'approve' CHECK (autonomy IN ('approve','auto')), PRIMARY KEY (agent, site_id));
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY, agent TEXT NOT NULL, site_id INTEGER NOT NULL, slot TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','failed','limited')),
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
  output TEXT, error TEXT);
CREATE INDEX IF NOT EXISTS agent_runs_slot ON agent_runs(agent, site_id, slot);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, agent TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
  payload_json TEXT NOT NULL, diff TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','published','failed')),
  note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), decided_at TEXT);
-- Clicked-but-not-finished agent jobs, so a restart re-queues them instead of silently dropping them.
CREATE TABLE IF NOT EXISTS agent_queue (
  id INTEGER PRIMARY KEY, agent TEXT NOT NULL, site_id INTEGER NOT NULL, slug TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (agent, site_id, slug));
CREATE TABLE IF NOT EXISTS metrics (
  site_id INTEGER NOT NULL, source TEXT NOT NULL, date TEXT NOT NULL, query TEXT NOT NULL DEFAULT '', page TEXT NOT NULL DEFAULT '',
  clicks REAL NOT NULL DEFAULT 0, impressions REAL NOT NULL DEFAULT 0, position REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, source, date, query, page));
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, title TEXT NOT NULL, slug TEXT NOT NULL, query TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT 'new', why TEXT NOT NULL DEFAULT '', score REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','drafted','published','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (site_id, slug));
`;

export function openDb(file = join(DATA_DIR, 'watchdog.db')): DatabaseSync {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // ponytail: additive migrations by try/ALTER; adopt a migrations table when one needs data changes.
  for (const sql of ["ALTER TABLE sites ADD COLUMN ua TEXT NOT NULL DEFAULT ''", 'ALTER TABLE findings ADD COLUMN resolved_at TEXT',
    'ALTER TABLE sites ADD COLUMN gsc_key TEXT', 'ALTER TABLE sites ADD COLUMN gsc_property TEXT',
    'ALTER TABLE discoveries ADD COLUMN serp_json TEXT', 'ALTER TABLE agent_runs ADD COLUMN detail TEXT', "ALTER TABLE topics ADD COLUMN segment TEXT NOT NULL DEFAULT 'other'"]) try { db.exec(sql); } catch { /* already applied */ }
  return db;
}

export type Site = { id: number; url: string; kind: 'own' | 'competitor'; parent_site_id: number | null; market: string; page_limit: number; ua: string; gsc_key: string | null; gsc_property: string | null };

/** Validate user input and add a site. Shared by the CLI and the dashboard so both accept the same inputs. */
export async function addSite(db: DatabaseSync, input: { url: string; market?: string; limit?: number; competitorOf?: string; ua?: string }):
  Promise<{ ok: true; id: number; url: string; note: string } | { ok: false; error: string }> {
  const raw = input.url.trim();
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { return { ok: false, error: `Not a URL: ${raw}` }; }
  if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) return { ok: false, error: `Not a public website address: ${raw}` };
  const market = (input.market ?? '').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (market.some((m) => !/^[A-Z]{2}$/.test(m))) return { ok: false, error: 'Market takes 2-letter country codes, e.g. MX or MX,US' };
  const limit = input.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) return { ok: false, error: 'Page limit must be between 1 and 10000' };
  let parent: Site | undefined;
  if (input.competitorOf) { parent = findSite(db, input.competitorOf); if (!parent) return { ok: false, error: `Unknown site: ${input.competitorOf}` }; }
  const { fetchRaw } = await import('./vendor/claude-seo-ai/fetch.mjs');
  const probe = await fetchRaw(url.href, { timeoutMs: 20_000 });
  if (probe.status === 0) return { ok: false, error: `Can't reach ${url.hostname}: ${probe.error}` };
  const home = new URL(probe.final_url);
  const stored = home.origin + home.pathname;
  // Same host is fine with a different path: https://x.mx/us is its own site (a market section).
  const key = (u: URL) => u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
  if ((db.prepare('SELECT url FROM sites').all() as { url: string }[]).some((s) => key(new URL(s.url)) === key(home))) return { ok: false, error: `Already watching ${key(home)}` };
  const id = Number(db.prepare('INSERT INTO sites (url, kind, parent_site_id, market, page_limit, ua) VALUES (?, ?, ?, ?, ?, ?)')
    .run(stored, parent ? 'competitor' : 'own', parent?.id ?? null, market.join(','), limit, input.ua ?? '').lastInsertRowid);
  return { ok: true, id, url: stored, note: `${parent ? `competitor of ${parent.url}` : 'own site'}, HTTP ${probe.status}` };
}

/** Accepts an id, a URL, or a bare host. */
export function findSite(db: DatabaseSync, ref: string): Site | undefined {
  if (/^\d+$/.test(ref)) return db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(ref)) as Site | undefined;
  const host = ref.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase();
  return (db.prepare('SELECT * FROM sites').all() as Site[]).find((s) => new URL(s.url).hostname.replace(/^www\./, '') === host);
}
