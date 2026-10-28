import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { uniqueTailAnchor, lastLineMatching, insertPointsFor } from '../src/agents/insertpoints.ts';

function fixture(t: { after: (fn: () => void) => void }, files: Record<string, string> = {}) {
  const wt = mkdtempSync('/tmp/insertpoints-');
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(wt, file)), { recursive: true });
    writeFileSync(join(wt, file), content);
  }
  return wt;
}

const posts = 'export const posts = [\n  {\n    slug: "one",\n  },\n  {\n    slug: "two",\n  },\n  {\n    slug: "three",\n  },\n];\n';
const block = (loc: string) => `  <url>\n    <loc>${loc}</loc>\n    <lastmod>2026-10-28</lastmod>\n  </url>\n`;

test('uniqueTailAnchor grows through repeated closing lines and respects maxLines', () => {
  const content = 'one\n    },\n  },\ntwo\n    },\n  },\nthree\n    },\n  },\n];\n';
  const end = content.lastIndexOf('\n];\n') + 1;
  assert.equal(uniqueTailAnchor(content, end), 'three\n    },\n  },\n');
  assert.equal(uniqueTailAnchor(content, end, 2), null);
  assert.equal(uniqueTailAnchor(content, end, 0), null);
  assert.equal(uniqueTailAnchor(content, 0), null);
  assert.equal(uniqueTailAnchor('\n', 1), '\n');
});

test('lastLineMatching returns the last whole line with newline only when unique', () => {
  const re = /^\s*"[a-z]+": "[a-z]+",[ \t]*\n/m;
  assert.equal(lastLineMatching('map {\n  "a": "b",\n  "c": "d",\n}\n', re), '  "c": "d",\n');
  assert.equal(lastLineMatching('  "a": "b",\n  "a": "b",\n', re), null);
  assert.equal(lastLineMatching('nothing\n', re), null);
  assert.equal(lastLineMatching('first\nlast\n', /^\w+$/m), 'last\n');
  assert.equal(lastLineMatching('last', /^last$/m), null);
});

test('Luvory returns three unique anchors, including the final complete blog url block', t => {
  const en = block('https://luvory.com.mx/en/blog/second');
  const wt = fixture(t, {
    'src/data/blog-posts.ts': posts.replace(/\n/g, '\r\n'),
    'src/lib/i18n.ts': 'const EN_SLUG_MAP = {\n  "/blog/uno": "/blog/one",\n  "/blog/dos": "/blog/two",\n};\n',
    'public/sitemap.xml': '<urlset>\n' + block('https://luvory.com.mx/blog/segundo') + en + block('https://luvory.com.mx/about') + '</urlset>\n',
  });
  const points = insertPointsFor('luvory.com.mx', wt, 'nuevo');
  assert.equal(points.length, 3);
  for (const point of points) {
    assert.equal(point.do, 'insert-after');
    assert.ok(point.anchor);
    const content = readFileSync(join(wt, point.file), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(content.split(point.anchor).length - 1, 1);
  }
  assert.ok(points[0].anchor!.endsWith('  },\n'));
  assert.equal(points[2].anchor, en);
  assert.ok(points[1].note!.includes('/blog/nuevo'));
});

test('Vexon always creates and Dizayn appends only to an existing file', t => {
  const wt = fixture(t);
  assert.deepEqual(insertPointsFor('vexonmexico.com.mx', wt, 'new-post'), [{ label: 'new post file', file: 'src/content/blog/new-post.mdx', do: 'create', note: 'text = the COMPLETE .mdx file (frontmatter + body)' }]);
  assert.deepEqual(insertPointsFor('dizaynseo.com', wt, 'new-post'), []);
  const existing = fixture(t, { '_src/posts_agent.py': '' });
  const points = insertPointsFor('dizaynseo.com', existing, 'new-post');
  assert.equal(points.length, 1);
  assert.equal(points[0].do, 'append');
  assert.equal(points[0].file, '_src/posts_agent.py');
  assert.equal(points[0].anchor, undefined);
});

test('Yume selects the last entry inside BLOG_SLUG_EN', t => {
  const wt = fixture(t, {
    'src/content/blog.ts': posts,
    'src/content/blog.en.ts': posts,
    'src/lib/i18n.ts': 'const OTHER = {\n  "before": "earlier",\n};\nconst BLOG_SLUG_EN = {\n  "uno": "one",\n  "dos": "two",\n};\nconst AFTER = {\n  "after": "later",\n};\n',
  });
  const points = insertPointsFor('studioyume.mx', wt, 'nuevo');
  assert.equal(points.length, 3);
  assert.equal(points[2].anchor, '  "dos": "two",\n');
  assert.ok(points[0].anchor!.endsWith('  },\n'));
  assert.ok(points[1].anchor!.endsWith('  },\n'));
});

test('Yume rejects an entry duplicated outside BLOG_SLUG_EN', t => {
  const wt = fixture(t, { 'src/lib/i18n.ts': 'const OTHER = {\n  "uno": "one",\n};\nconst BLOG_SLUG_EN = {\n  "uno": "one",\n};\n' });
  assert.deepEqual(insertPointsFor('studioyume.mx', wt, 'nuevo'), []);
});

test('unknown hosts, missing files and unusable anchors are skipped without throwing', t => {
  const wt = fixture(t);
  for (const host of ['unknown', 'luvory.com.mx', 'studioyume.mx', 'dizaynseo.com']) {
    assert.deepEqual(insertPointsFor(host, wt, 'new'), []);
  }
  const invalid = fixture(t, {
    'src/data/blog-posts.ts': 'no array terminator\n',
    'src/lib/i18n.ts': 'const BLOG_SLUG_EN = {};\n',
    'public/sitemap.xml': block('https://example.com/blog/same').repeat(2),
  });
  assert.deepEqual(insertPointsFor('luvory.com.mx', invalid, 'new'), []);
  assert.deepEqual(insertPointsFor('studioyume.mx', invalid, 'new'), []);
});
