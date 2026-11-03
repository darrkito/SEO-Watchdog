import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, syncWorktree, guidesOf } from '../src/agents/agents.ts';
import type { AgentSite } from '../src/agents/sites.ts';

test('syncs latest main, cleans changes, and reads guides from worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-'));
  try {
    git(root, 'init', '--bare', '-q', '-b', 'main', 'remote.git');
    git(root, 'clone', '-q', 'remote.git', 'wt');
    const wt = join(root, 'wt');
    git(wt, 'config', 'user.email', 'test@example.com'); git(wt, 'config', 'user.name', 'test');
    writeFileSync(join(wt, 'a'), 'one'); writeFileSync(join(wt, 'CLAUDE.md'), 'worktree');
    git(wt, 'add', '.'); git(wt, 'commit', '-qm', 'first'); git(wt, 'push', '-q', '-u', 'origin', 'main');
    const cfg = { repo: wt, worktree: wt, remote: 'origin', guideFiles: ['CLAUDE.md'] } as AgentSite;
    assert.equal(syncWorktree(cfg, 'agent/x').moved, true);
    assert.equal(syncWorktree(cfg, 'agent/x').moved, false);
    git(root, 'clone', '-q', 'remote.git', 'other');
    const other = join(root, 'other'); git(other, 'config', 'user.email', 'test@example.com'); git(other, 'config', 'user.name', 'test');
    writeFileSync(join(other, 'a'), 'two'); git(other, 'add', '.'); git(other, 'commit', '-qm', 'second'); git(other, 'push', '-q');
    const synced = syncWorktree(cfg, 'agent/x'); assert.equal(synced.moved, true); assert.equal(git(wt, 'rev-parse', 'HEAD').trim(), synced.head);
    writeFileSync(join(wt, 'a'), 'dirty'); writeFileSync(join(wt, 'untracked'), 'dirty');
    assert.equal(syncWorktree(cfg, 'agent/x').moved, true); assert.equal(readFileSync(join(wt, 'a'), 'utf8'), 'two'); assert.equal(existsSync(join(wt, 'untracked')), false);
    const owner = join(root, 'owner'); mkdirSync(owner); writeFileSync(join(owner, 'CLAUDE.md'), 'owner');
    assert.equal(guidesOf({ ...cfg, repo: owner }, 14000, wt)[0].text, 'worktree');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
