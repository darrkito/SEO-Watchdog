import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rivalBattle } from '../src/gaps.ts';
import type { Site } from '../src/db.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, site_id INTEGER, status TEXT);
    CREATE TABLE pages (id INTEGER PRIMARY KEY, url TEXT);
    CREATE TABLE snapshots (page_id INTEGER, run_id INTEGER, extract_json TEXT);
    CREATE TABLE competitor_candidates (site_id INTEGER, domain TEXT, status TEXT, competitor_site_id INTEGER)`);
  const site = { id: 1, url: 'https://own.test/' } as Site;
  const run = (id: number, siteId: number, status = 'ok') => db.prepare('INSERT INTO runs VALUES (?, ?, ?)').run(id, siteId, status);
  const page = (id: number, runId: number, url: string, title: string, h1: string, words: number, extra: object = {}) => {
    db.prepare('INSERT INTO pages VALUES (?, ?)').run(id, url);
    db.prepare('INSERT INTO snapshots VALUES (?, ?, ?)').run(id, runId, JSON.stringify({ url, title, h1: [h1], word_count: words, is_html: true, status: 200, noindex: false, meta_description: '', jsonld_types: [], faq_questions: [], ...extra }));
  };
  const rival = (domain: string, id: number, status = 'active') => db.prepare('INSERT INTO competitor_candidates VALUES (1, ?, ?, ?)').run(domain, status, id);
  return { db, site, run, page, rival };
}

test('compares watched competitor pages and finds unrelated services', () => {
  const { db, site, run, page, rival } = fixture();
  run(1, 1); run(2, 2); run(3, 3);
  rival('rival.test', 2); rival('rejected.test', 3, 'rejected');
  page(1, 1, 'https://own.test/oficinas', 'Renta de oficinas móviles', 'Renta de oficinas móviles en Guadalajara', 120);
  page(2, 2, 'https://rival.test/oficinas', 'Renta de oficinas móviles en Guadalajara | Rival', 'Renta de oficinas móviles en Guadalajara', 500, { jsonld_types: ['Product'], faq_questions: ['¿Cuánto cuesta?'] });
  page(3, 2, 'https://rival.test/venta-gruas', 'Renta de baños portátiles móviles', 'Renta de baños portátiles móviles', 200);
  page(4, 3, 'https://rejected.test/venta', 'Venta de excavadoras industriales', 'Venta de excavadoras industriales', 300);
  const result = rivalBattle(db, site)!;
  assert.equal(result.rows.length, 1);
  const issues = result.rows[0].rivals[0].issues;
  assert.ok(issues.some((i) => i.text.includes('title') && i.text.includes('guadalajara')));
  assert.ok(issues.some((i) => i.text.includes('500 words')));
  assert.ok(issues.some((i) => i.text.includes('FAQ')));
  assert.ok(issues.every((i) => i.fix.trim()));
  assert.ok(result.rivalOnly.some((r) => r.url.endsWith('/venta-gruas')));
  assert.ok(!result.rows.some((r) => r.rivals.some((v) => v.url.endsWith('/venta-gruas'))));
  assert.deepEqual(result.rivals.map((r) => r.domain), ['rival.test']);
  assert.ok(!result.rivalOnly.some((r) => r.domain === 'rejected.test'));
  db.close();
});

test('returns null without a successful own run', () => {
  const { db, site, run } = fixture();
  run(1, 1, 'failed');
  assert.equal(rivalBattle(db, site), null);
  db.close();
});

test('pages you lack only cover services in the site profile', () => {
  const { db, site, run, page, rival } = fixture();
  db.exec("CREATE TABLE IF NOT EXISTS site_profiles (site_id INTEGER PRIMARY KEY, data_json TEXT NOT NULL, source TEXT, updated_at TEXT)");
  db.prepare("INSERT INTO site_profiles VALUES (?, ?, 'user', '')").run(site.id, JSON.stringify({ services: ['Renta de oficinas móviles'], industry: 'Renta de oficinas móviles para obra', city: 'Zapopan', region: 'Jalisco' }));
  run(1, 1); run(2, 2);
  rival('rival.test', 2);
  page(1, 1, 'https://own.test/', 'Inicio', 'Vexon', 200);
  page(2, 2, 'https://rival.test/dormitorios', 'Dormitorios Móviles', 'Dormitorios Móviles', 200);
  page(3, 2, 'https://rival.test/plantas', 'Plantas de tratamiento', 'Plantas de tratamiento', 200);
  page(4, 2, 'https://rival.test/oficina-12x60', 'Renta de oficina de obra 12x60', 'Renta de oficina de obra 12x60', 200);
  page(5, 2, 'https://rival.test/oficina-8x20', 'Oficina de obra 8x20', 'Oficina de obra 8x20', 200);
  const result = rivalBattle(db, site)!;
  assert.ok(result.rivalOnly.some((r) => r.title.includes('oficina de obra')));
  assert.ok(!result.rivalOnly.some((r) => /Dormitorios|Plantas/.test(r.title)));
});
