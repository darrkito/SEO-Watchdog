import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Site } from '../src/db.ts';
import { extractPage } from '../src/extract.ts';
import { collectSerpPages } from '../src/serppages.ts';
import { battle } from '../src/gaps.ts';

const response = (url: string, status = 200, contentType = 'text/html') => ({ url, final_url: url, status, error: null, headers: { 'content-type': contentType }, status_chain: [], redirects: { hops: 0, loop: false }, body: { text: `<html><head><title>Mobile office rental</title></head><body><h1>Mobile office rental</h1>${'office rental '.repeat(400)}</body></html>` } });
function fixture() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO sites (url) VALUES ('https://own.test/')").run();
  const site = db.prepare('SELECT * FROM sites WHERE id = 1').get() as Site;
  db.prepare("INSERT INTO site_profiles VALUES (1, ?, 'user', datetime('now'))").run(JSON.stringify({ brand_terms: ['Ownbrand'] }));
  const candidate = (domain: string, status = 'suggested', competitor: number | null = null) => db.prepare('INSERT INTO competitor_candidates (site_id, domain, url, status, competitor_site_id) VALUES (1, ?, ?, ?, ?)').run(domain, `https://${domain}/`, status, competitor);
  const discovery = (organic: { rank: number; url: string; domain: string }[]) => db.prepare("INSERT INTO discoveries (site_id, provider, model, keywords_json, stats_json, serp_json) VALUES (1, '', '', '[]', '{}', ?)").run(JSON.stringify({ 'mobile office rental': { organic, places: [] } }));
  const snapshot = (siteId: number, url: string, html?: string) => {
    const run = Number(db.prepare("INSERT INTO runs (site_id, status) VALUES (?, 'ok')").run(siteId).lastInsertRowid);
    const page = Number(db.prepare('INSERT INTO pages (site_id, url) VALUES (?, ?)').run(siteId, url).lastInsertRowid);
    const f = response(url); if (html) f.body.text = html;
    db.prepare('INSERT INTO snapshots (page_id, run_id, extract_json) VALUES (?, ?, ?)').run(page, run, JSON.stringify(extractPage(f)));
  };
  return { db, site, candidate, discovery, snapshot };
}
const hit = (rank: number, url: string, domain: string) => ({ rank, url, domain });

test('collects eligible subdomain results and ignores rejected, own and brand domains', async () => {
  const { db, site, candidate, discovery } = fixture();
  candidate('rival.test', 'active'); candidate('bad.test', 'rejected'); candidate('ownbrand-rentals.test'); candidate('own.test');
  discovery([hit(1, 'https://branch.rival.test/a?utm_source=x#part', 'rival.test'), hit(2, 'https://bad.test/a', 'bad.test'), hit(3, 'https://ownbrand-rentals.test/a', 'ownbrand-rentals.test'), hit(4, 'https://own.test/page', 'own.test')]);
  const calls: string[] = [];
  const result = await collectSerpPages(db, site, { fetcher: async (url: string) => { calls.push(url); return response(url); } });
  assert.deepEqual(result, { fetched: 1, skipped: 0 });
  assert.deepEqual(calls, ['https://branch.rival.test/a?utm_source=x#part']);
  assert.equal((db.prepare('SELECT url FROM serp_pages').get() as { url: string }).url, 'https://branch.rival.test/a');
  assert.deepEqual(await collectSerpPages(db, site, { fetcher: async () => { throw Error('unexpected'); } }), { fetched: 0, skipped: 1 });
  db.close();
});

test('skips a page already crawled by a watched competitor', async () => {
  const { db, site, candidate, discovery, snapshot } = fixture();
  const id = Number(db.prepare("INSERT INTO sites (url, kind) VALUES ('https://rival.test/', 'competitor')").run().lastInsertRowid);
  candidate('rival.test', 'active', id); snapshot(id, 'https://sub.rival.test/page');
  discovery([hit(1, 'https://sub.rival.test/page?utm_source=x', 'rival.test')]);
  assert.deepEqual(await collectSerpPages(db, site, { fetcher: async () => { throw Error('unexpected'); } }), { fetched: 0, skipped: 1 });
  db.close();
});

test('battle compares the stored ranking page and avoids blog mismatches', async () => {
  const { db, site, candidate, discovery, snapshot } = fixture();
  candidate('rival.test');
  snapshot(1, 'https://own.test/page', '<html><head><title>Office</title></head><body><h1>Office</h1></body></html>');
  discovery([hit(1, 'https://sub.rival.test/page', 'rival.test'), hit(2, 'https://own.test/page', 'own.test')]);
  await collectSerpPages(db, site, { fetcher: async (url: string) => response(url) });
  const row = battle(db, site)!.keywords[0];
  assert.equal(row.rival?.url, 'https://sub.rival.test/page');
  assert.equal(row.above[0].fetched, true); assert.equal(row.above[0].watched, false);
  assert.ok(row.issues.length > 0);
  const stored = db.prepare('SELECT extract_json FROM serp_pages').get() as { extract_json: string };
  const ex = JSON.parse(stored.extract_json); ex.jsonld_types = ['BlogPosting'];
  db.prepare('UPDATE serp_pages SET extract_json = ?').run(JSON.stringify(ex));
  assert.deepEqual(battle(db, site)!.keywords[0].issues, []);
  db.close();
});

test('counts non-200 and non-html responses as skipped', async () => {
  const { db, site, candidate, discovery } = fixture(); candidate('rival.test');
  discovery([hit(1, 'https://rival.test/error', 'rival.test'), hit(2, 'https://rival.test/file', 'rival.test')]);
  assert.deepEqual(await collectSerpPages(db, site, { fetcher: async (url: string) => response(url, url.endsWith('error') ? 404 : 200, url.endsWith('file') ? 'application/pdf' : 'text/html') }), { fetched: 0, skipped: 2 });
  assert.equal((db.prepare('SELECT count(*) n FROM serp_pages').get() as { n: number }).n, 0);
  db.close();
});
