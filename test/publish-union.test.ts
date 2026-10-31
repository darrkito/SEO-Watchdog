import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { placeInsertion, pushAndVerify, resolveRebaseByUnion } from '../src/agents/agents.ts';

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const post = (slug: string) => ({ slug, improve: false, merge: null });
const paths = ['src/data/blog-posts.ts', 'public/sitemap.xml', 'src/lib/i18n.ts'];
const entry = (slug: string, title = slug) => `  {\n    slug: "${slug}",\n    title: "${title}",\n  },\n`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wd-replay-test-'));
  g(root, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
  g(root, 'clone', '-q', 'remote.git', 'first');
  const first = join(root, 'first');
  g(first, 'config', 'user.email', 'test@example.com'); g(first, 'config', 'user.name', 'Test');
  g(first, 'checkout', '-qb', 'main');
  const initial: Record<string, string> = { [paths[0]]: `const posts = [\n${entry('existing')}];\n`, [paths[1]]: '<urlset>\n</urlset>\n', [paths[2]]: 'const translations = [\n];\n', 'derived.json': 'base\n', 'other.txt': 'base\n' };
  for (const [file, content] of Object.entries(initial)) { mkdirSync(dirname(join(first, file)), { recursive: true }); writeFileSync(join(first, file), content); }
  g(first, 'add', '.'); g(first, 'commit', '-qm', 'base'); g(first, 'push', '-q', 'origin', 'main');
  g(root, 'clone', '-q', 'remote.git', 'second'); const second = join(root, 'second');
  g(second, 'config', 'user.email', 'test@example.com'); g(second, 'config', 'user.name', 'Test');
  const cfg = (worktree: string): any => ({ worktree, remote: 'origin', typecheck: ['true'], unionPaths: paths, derivedPaths: ['derived.json'] });
  return { root, first, second, cfg };
}
function draft(wt: string, slug: string, extra?: () => void, title = slug) {
  for (const [file, marker, addition] of [[paths[0], '];', entry(slug, title)], [paths[1], '</urlset>', `  <url>${slug}</url>\n`], [paths[2], '];', `  "${slug}",\n`]]) {
    const path = join(wt, file); writeFileSync(path, readFileSync(path, 'utf8').replace(marker, addition + marker));
  }
  extra?.(); g(wt, 'add', '.'); g(wt, 'commit', '-qm', slug);
}
function conflict(first: string, second: string, cfg: (wt: string) => any, slug = 'first') {
  pushAndVerify(cfg(first), [], post(slug));
  g(second, 'fetch', 'origin', 'main');
  assert.throws(() => g(second, 'rebase', 'origin/main'));
}
const remoteFile = (root: string, file: string) => g(root, `--git-dir=${join(root, 'remote.git')}`, 'show', `main:${file}`);

test('places repeated-ending entries after the latest main entry, including a slid hunk', () => {
  const item = (name: string) => `  {\n    slug: "${name}",\n    content: {\n      body: \`Content of ${name}\n\n\`,\n    },\n  },\n`;
  const base = `const posts = [\n${item('A')}${item('B')}${item('C')}`;
  const addition = item('N');
  const draftLines = `${base}${addition}];\n`.split('\n');
  const main = `${base}${item('X')}];\n`;
  const start = base.split('\n').length - 1;
  const count = addition.split('\n').length - 1;
  const expected = `${base}${item('X')}${addition}];\n`;
  for (const hunkStart of [start, start - 3]) {
    const mainLines = main.split('\n');
    const placement = placeInsertion(draftLines, hunkStart, count, mainLines);
    assert.ok(placement);
    mainLines.splice(placement.index, 0, ...placement.block);
    const result = mainLines.join('\n');
    assert.equal(result, expected);
    assert.equal((result.match(/^  \{$/gm) ?? []).length, (result.match(/^  \},$/gm) ?? []).length);
    assert.ok(result.includes(item('X')));
    assert.ok(result.endsWith(`${addition}];\n`));
  }
});

test('returns null when insertion context does not match', () => {
  assert.equal(placeInsertion(['before', 'new', 'after'], 1, 1, ['different', 'unrelated']), null);
});

test('replays both drafts onto main as balanced insertions', () => {
  const { root, first, second, cfg } = fixture();
  try {
    draft(first, 'first'); draft(second, 'second');
    pushAndVerify(cfg(first), [], post('first')); pushAndVerify(cfg(second), [], post('second'));
    for (const slug of ['first', 'second']) {
      assert.equal(remoteFile(root, paths[0]).split(`slug: "${slug}"`).length - 1, 1);
      assert.equal(remoteFile(root, paths[1]).split(`<url>${slug}</url>`).length - 1, 1);
      assert.equal(remoteFile(root, paths[2]).split(`"${slug}"`).length - 1, 1);
    }
    const posts = remoteFile(root, paths[0]);
    assert.equal((posts.match(/\bslug:/g) ?? []).length, 3);
    assert.equal(posts.trimEnd().split('\n').at(-1), '];');
    assert.equal((posts.match(/\{/g) ?? []).length, (posts.match(/\}/g) ?? []).length);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects a draft that also edits existing text', () => {
  const { root, first, second, cfg } = fixture();
  try {
    draft(first, 'first'); draft(second, 'second', () => { const p = join(second, paths[0]); writeFileSync(p, readFileSync(p, 'utf8').replace('title: "existing"', 'title: "edited"')); });
    conflict(first, second, cfg);
    assert.equal(resolveRebaseByUnion(cfg(second), post('second')), false);
    assert.throws(() => pushAndVerify(cfg(second), [], post('second')), /rebase conflict/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('regenerates conflicting derived files on latest main', () => {
  const { root, first, second, cfg } = fixture();
  try {
    draft(first, 'first', () => writeFileSync(join(first, 'derived.json'), 'first\n'));
    draft(second, 'second', () => writeFileSync(join(second, 'derived.json'), 'second\n'));
    pushAndVerify(cfg(first), [], post('first'));
    const c = cfg(second); c.postEdit = (wt: string) => { assert.equal(readFileSync(join(wt, 'derived.json'), 'utf8'), 'first\n'); writeFileSync(join(wt, 'derived.json'), 'regenerated\n'); };
    pushAndVerify(c, [], post('second'));
    assert.equal(remoteFile(root, 'derived.json'), 'regenerated\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('duplicate slug guard restores the draft', () => {
  const { root, first, second, cfg } = fixture();
  try {
    draft(first, 'same', undefined, 'first'); draft(second, 'same', undefined, 'second');
    const original = g(second, 'rev-parse', 'HEAD').trim();
    conflict(first, second, cfg, 'same');
    assert.equal(resolveRebaseByUnion(cfg(second), post('same')), false);
    assert.equal(g(second, 'rev-parse', 'HEAD').trim(), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects changes outside union and derived paths', () => {
  const { root, first, second, cfg } = fixture();
  try {
    draft(first, 'first'); draft(second, 'second', () => writeFileSync(join(second, 'other.txt'), 'changed\n'));
    conflict(first, second, cfg);
    assert.equal(resolveRebaseByUnion(cfg(second), post('second')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('publish: a rebase stopping only on a generated file keeps main\'s copy, regenerates it and continues', () => {
  const { root, first, second, cfg } = fixture();
  try {
    const regen = (wt: string) => writeFileSync(join(wt, 'derived.json'), `${readFileSync(join(wt, paths[0]), 'utf8').length}\n`);
    const withEdit = (wt: string): any => ({ ...cfg(wt), postEdit: regen });
    const edit = (wt: string, f: () => void) => { f(); regen(wt); g(wt, 'add', '.'); g(wt, 'commit', '-qm', 'edit'); };
    // first: an improve-style change to line 1 (not an insertion) plus the regenerated file, pushed to main
    edit(first, () => { const p = join(first, paths[0]); writeFileSync(p, readFileSync(p, 'utf8').replace('const posts = [', 'const posts = [ // improved')); });
    g(first, 'push', '-q', 'origin', 'main');
    // second: improves another line of the post (an edit, not an insertion, so the union replay refuses it) and also rewrote the generated file from the old base
    edit(second, () => { const p = join(second, paths[0]); writeFileSync(p, readFileSync(p, 'utf8').replace('title: "existing"', 'title: "existing v2"')); });
    pushAndVerify(withEdit(second), [], post('second'));
    const posts = remoteFile(root, paths[0]);
    assert.match(posts, /improved/); assert.match(posts, /existing v2/);
    assert.equal(remoteFile(root, 'derived.json').trim(), String(posts.length));
    assert.equal(g(second, 'status', '--short').trim(), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
