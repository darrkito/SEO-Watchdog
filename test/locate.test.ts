import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { locatePost, postText, currentOf, exampleOf } from '../src/agents/locate.ts';

function fixture(t: { after: (fn: () => void) => void }, files: Record<string, string>): string {
  const wt = mkdtempSync(join(tmpdir(), 'wd-locate-'));
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(wt, file)), { recursive: true });
    writeFileSync(join(wt, file), text);
  }
  return wt;
}
const luvory = { postFiles: () => ['src/data/blog-posts.ts'] };
const yume = { postFiles: () => ['src/content/blog.ts', 'src/content/blog-dulceros.ts'] };
const vexon = { postFiles: (slug: string) => [`src/content/blog/${slug}.mdx`], wholeFile: true };
const object = (slug: string, body = 'text') => `  {\n    slug: "${slug}",\n    title: "${body}",\n  },\n`;

test('Luvory range includes the nested en block and excludes the next post', (t) => {
  const expected = '    slug: "a-b",\n    title: "Spanish",\n    en: {\n      title: "English",\n    },';
  const wt = fixture(t, {
    'src/data/blog-posts.ts': `export const posts = [\n  {\n${expected}\n  },\n${object('next')}];\n`,
    'src/lib/i18n.ts': '"/blog/a-b": "/blog/a-b-en"',
    'src/data/blog-posts.en.ts': object('a-b-en'),
  });
  const ranges = locatePost(luvory, wt, 'a-b');
  assert.deepEqual(ranges, [{ file: 'src/data/blog-posts.ts', whole: false, anchor: '    slug: "a-b",\n', endAnchor: '\n  },\n', lang: 'primary' }]);
  assert.equal(postText(wt, ranges[0]), expected);
});

test('Dizayn uses zero-indent quoted slug and closing marker', (t) => {
  const cfg = { postFiles: () => ['_src/posts.py', '_src/posts_funnel.py', '_src/posts_agent.py'] };
  const wt = fixture(t, { '_src/posts_funnel.py': '{\n"slug": "x",\n"title": "X",\n},\n' });
  const ranges = locatePost(cfg, wt, 'x');
  assert.deepEqual(ranges, [{ file: '_src/posts_funnel.py', whole: false, anchor: '"slug": "x",\n', endAnchor: '\n},\n', lang: 'primary' }]);
  assert.equal(postText(wt, ranges[0]), '"slug": "x",\n"title": "X",');
});

test('Vexon reads a whole file exactly and skips missing files', (t) => {
  const content = "---\ntitle: 'Post'\n---\n\nBody\r\n";
  const wt = fixture(t, { 'src/content/blog/post.mdx': content });
  assert.deepEqual(locatePost(vexon, wt, 'post'), [{ file: 'src/content/blog/post.mdx', whole: true, lang: 'primary' }]);
  assert.equal(currentOf(vexon, wt, 'post'), `=== src/content/blog/post.mdx ===\n${content}`);
  assert.deepEqual(locatePost(vexon, wt, 'missing'), []);
  assert.deepEqual(locatePost({ ...vexon, postFiles: () => ['missing.mdx', 'src/content/blog/post.mdx'] }, wt, 'post'), locatePost(vexon, wt, 'post'));
});

test('Yume locates primary and translated objects with either slug-map format', (t) => {
  for (const prefix of ['', '/blog/']) {
    const wt = fixture(t, {
      'src/content/blog.ts': object('slug-es'),
      'src/content/blog.en.ts': object('slug-en', 'English'),
      'src/lib/i18n.ts': `"${prefix}slug-es": "${prefix}slug-en"`,
    });
    const ranges = locatePost(yume, wt, 'slug-es');
    assert.deepEqual(ranges.map((r) => [r.file, r.lang]), [['src/content/blog.ts', 'primary'], ['src/content/blog.en.ts', 'en']]);
    assert.equal(postText(wt, ranges[1]), '    slug: "slug-en",\n    title: "English",');
    assert.equal(currentOf(yume, wt, 'slug-es'), ranges.map((r) => `=== ${r.file} ===\n${postText(wt, r)}`).join('\n'));
  }
});

test('missing slugs and absent optional configuration produce no text', (t) => {
  const wt = fixture(t, { 'src/data/blog-posts.ts': object('present') });
  assert.deepEqual(locatePost(luvory, wt, 'missing'), []);
  assert.equal(currentOf(luvory, wt, 'missing'), '');
  assert.deepEqual(locatePost({}, wt, 'present'), []);
});

test('exampleOf uses the last listed post, worktree argument, and 7000-character cap', (t) => {
  const content = 'last text '.repeat(3000);
  const wt = fixture(t, { 'src/content/blog/first.mdx': 'first', 'src/content/blog/last.mdx': content });
  const cfg = { ...vexon, repo: '/unused', listPosts: (repo: string) => {
    assert.equal(repo, wt);
    return [{ slug: 'first', title: 'First' }, { slug: 'last', title: 'Last' }];
  } };
  const expected = `=== src/content/blog/last.mdx ===\n${content}`;
  assert.equal(exampleOf(cfg, wt), expected.slice(0, 7000));
  assert.equal(currentOf(cfg, wt, 'last'), expected.slice(0, 24000));
  assert.equal(currentOf(cfg, wt, 'last', 50), expected.slice(0, 50));
  assert.equal(exampleOf({ ...cfg, listPosts: () => [] }, wt), '');
});

test('final object before array close retains its closing marker; missing marker uses EOF', (t) => {
  const wt = fixture(t, { 'src/data/blog-posts.ts': `[\n${object('first')}${object('last')}];` });
  const [last] = locatePost(luvory, wt, 'last');
  assert.equal(last.endAnchor, '\n  },\n');
  assert.equal(postText(wt, last), '    slug: "last",\n    title: "text",');
  const unfinished = '    slug: "last",\n    title: "unfinished",';
  writeFileSync(join(wt, 'src/data/blog-posts.ts'), `[\n  {\n${unfinished}`);
  const [tail] = locatePost(luvory, wt, 'last');
  assert.equal(tail.endAnchor, undefined);
  assert.equal(postText(wt, tail), unfinished);
});

test('slug regex escapes metacharacters and stops at the first matching candidate', (t) => {
  const wt = fixture(t, {
    'src/content/blog.ts': object('axb') + object('a.b', 'first'),
    'src/content/blog-dulceros.ts': object('a.b', 'second'),
  });
  const ranges = locatePost(yume, wt, 'a.b');
  assert.equal(ranges.length, 1);
  assert.equal(postText(wt, ranges[0]), '    slug: "a.b",\n    title: "first",');
});
