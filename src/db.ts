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
`;

export function openDb(file = join(DATA_DIR, 'watchdog.db')): DatabaseSync {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // ponytail: additive migrations by try/ALTER; adopt a migrations table when one needs data changes.
  for (const sql of ["ALTER TABLE sites ADD COLUMN ua TEXT NOT NULL DEFAULT ''"]) try { db.exec(sql); } catch { /* already applied */ }
  return db;
}

export type Site = { id: number; url: string; kind: 'own' | 'competitor'; parent_site_id: number | null; market: string; page_limit: number; ua: string };

/** Accepts an id, a URL, or a bare host. */
export function findSite(db: DatabaseSync, ref: string): Site | undefined {
  if (/^\d+$/.test(ref)) return db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(ref)) as Site | undefined;
  const host = ref.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase();
  return (db.prepare('SELECT * FROM sites').all() as Site[]).find((s) => new URL(s.url).hostname.replace(/^www\./, '') === host);
}
