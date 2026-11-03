import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dizaynEsSlug } from '../src/agents/hooks.ts';
import { AGENT_SITES, pathAllowed } from '../src/agents/sites.ts';

const repo = '/home/darrkito/dizaynseo';
const skip = (!existsSync(repo) || !existsSync(join(repo, '_src/posts_es.py'))) && 'the Spanish blog checkout is unavailable';
const checker = join(import.meta.dirname, '../src/agents/dizayn/check_post.py');
const signs = 'signs-your-website-is-losing-customers';

test('Spanish twins validate in a committed scratch clone', { skip, timeout: 120_000 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dizayn-es-')), clone = join(root, 'site');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['clone', '-q', repo, clone]);
  const check = (slug: string, mode: string) => spawnSync('python3', [checker, clone, slug, mode], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  for (const [slug, mode] of [[signs, 'existing'], ['how-to-get-more-google-reviews', 'new']]) {
    const result = check(slug, mode); assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(result.stdout, '');
  }
  assert.equal(dizaynEsSlug(clone, signs), 'senales-de-que-tu-sitio-web-te-hace-perder-clientes');
  assert.equal(dizaynEsSlug(clone, 'geo-vs-seo'), null);
  const file = join(clone, '_src/posts_es.py'), original = readFileSync(file, 'utf8');
  const start = original.indexOf(`'en': '${signs}'`), heading = original.indexOf('<h2 id="', start);
  assert.ok(start >= 0 && heading >= 0);
  const end = original.indexOf('"', heading + '<h2 id="'.length);
  writeFileSync(file, original.slice(0, heading) + '<h2 id="zz' + original.slice(end));
  let result = check(signs, 'existing'); assert.equal(result.status, 1); assert.match(result.stdout, /h2/i);
  assert.ok(original.includes('%(t_signs)s'));
  writeFileSync(file, original.replace('%(t_signs)s', ''));
  result = check(signs, 'existing'); assert.equal(result.status, 1); assert.match(result.stdout, /table/i);
  writeFileSync(file, original);
  result = check('geo-vs-seo', 'new'); assert.match(result.stdout, /no Spanish twin/);
  result = check('geo-vs-seo', 'existing'); assert.equal(result.status, 0, result.stdout); assert.doesNotMatch(result.stdout, /Spanish/);
});

test('Dizayn briefs and paths include Spanish twins', () => {
  const site = AGENT_SITES['dizaynseo.com'];
  const opts = { title: '', slug: '', query: '', why: '', merge: null, publishAt: '' };
  assert.match(site.postBrief!({ ...opts, kind: 'new' }), /gemelo en español/);
  assert.match(site.postBrief!({ ...opts, kind: 'improve' }), /Si no tiene gemelo en español/);
  assert.ok(pathAllowed(site.contentPaths, 'es/blog/x.html'));
  assert.ok(pathAllowed(site.contentPaths, 'md/es/blog/x.md'));
});
