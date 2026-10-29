import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pushAndVerify, resolveRebaseByUnion } from '../src/agents/agents.ts';

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const post = (slug: string) => ({ slug, improve: false, merge: null });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wd-union-test-'));
  g(root, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
  g(root, 'clone', '-q', 'remote.git', 'first');
  const first = join(root, 'first');
  g(first, 'config', 'user.email', 'test@example.com'); g(first, 'config', 'user.name', 'Test');
  g(first, 'checkout', '-qb', 'main');
  for (const [f, content] of Object.entries({ 'posts.ts': 'const posts = [\n];\n', 'map.txt': 'start\nend\n', 'derived.json': 'base\n', 'other.txt': 'base\n' })) writeFileSync(join(first, f), content);
  g(first, 'add', '.'); g(first, 'commit', '-qm', 'base'); g(first, 'push', '-q', 'origin', 'main');
  g(root, 'clone', '-q', 'remote.git', 'second'); const second = join(root, 'second');
  g(second, 'config', 'user.email', 'test@example.com'); g(second, 'config', 'user.name', 'Test');
  const cfg = (worktree: string): any => ({ worktree, remote: 'origin', typecheck: ['true'], unionPaths: ['posts.ts', 'map.txt'], derivedPaths: ['derived.json'] });
  return { root, first, second, cfg };
}
function draft(wt: string, slug: string, extra?: () => void) {
  writeFileSync(join(wt, 'posts.ts'), `const posts = [\n  { slug: "${slug}" },\n];\n`);
  writeFileSync(join(wt, 'map.txt'), `start\n${slug}\nend\n`);
  extra?.(); g(wt, 'add', '.'); g(wt, 'commit', '-qm', slug);
}

test('publishing drafts from one base unions both content files and regenerates derived files', () => {
  const { root, first, second, cfg } = fixture();
  try {
    draft(first, 'first', () => writeFileSync(join(first, 'derived.json'), 'first\n'));
    draft(second, 'second', () => writeFileSync(join(second, 'derived.json'), 'second\n'));
    pushAndVerify(cfg(first), [], post('first'));
    const c = cfg(second); c.postEdit = (wt: string) => { assert.equal(readFileSync(join(wt, 'derived.json'), 'utf8'), 'first\n'); writeFileSync(join(wt, 'derived.json'), 'regenerated\n'); };
    pushAndVerify(c, [], post('second'));
    for (const f of ['posts.ts', 'map.txt']) {
      const text = g(first, '--git-dir=' + join(root, 'remote.git'), 'show', `main:${f}`);
      for (const slug of ['first', 'second']) assert.equal(text.split(slug).length - 1, 1);
    }
    assert.equal(g(first, '--git-dir=' + join(root, 'remote.git'), 'show', 'main:derived.json'), 'regenerated\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('conflicts outside the allowlist still abort and throw', () => {
  const { root, first, second, cfg } = fixture();
  try {
    draft(first, 'first', () => writeFileSync(join(first, 'other.txt'), 'first\n'));
    draft(second, 'second', () => writeFileSync(join(second, 'other.txt'), 'second\n'));
    pushAndVerify(cfg(first), [], post('first'));
    assert.throws(() => pushAndVerify(cfg(second), [], post('second')), /rebase conflict/);
    assert.equal(g(second, 'status', '--porcelain'), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('duplicate slug guard rejects and restores the original draft', () => {
  const { root, first, second, cfg } = fixture();
  try {
    draft(first, 'same'); draft(second, 'same', () => writeFileSync(join(second, 'map.txt'), 'start\nsame second\nend\n'));
    // Make the identical slug entries differ so the union contains both.
    writeFileSync(join(second, 'posts.ts'), "const posts = [\n  { slug: 'same', title: 'second' },\n];\n");
    g(second, 'add', '.'); g(second, 'commit', '--amend', '--no-edit', '-q');
    const original = g(second, 'rev-parse', 'HEAD').trim();
    pushAndVerify(cfg(first), [], post('same')); g(second, 'fetch', 'origin', 'main');
    assert.throws(() => g(second, 'rebase', 'origin/main'));
    let regenerated = false; const c = cfg(second); c.postEdit = () => { regenerated = true; };
    assert.equal(resolveRebaseByUnion(c, post('same')), false);
    assert.equal(regenerated, true, 'duplicate check runs after successful rebase');
    assert.equal(g(second, 'rev-parse', 'HEAD').trim(), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
