import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('restore generated preserves staged source and removes staged new pages', () => {
  const wt = mkdtempSync(join(tmpdir(), 'restore-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: wt, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
    mkdirSync(join(wt, '_src')); writeFileSync(join(wt, '_src/p.py'), 'old'); writeFileSync(join(wt, 'a.html'), 'original');
    git('add', '.'); git('commit', '-qm', 'initial');
    mkdirSync(join(wt, 'blog')); writeFileSync(join(wt, 'blog/new.html'), 'new'); writeFileSync(join(wt, '_src/p.py'), 'modified');
    git('add', '.'); writeFileSync(join(wt, 'a.html'), 'changed');
    execFileSync('python3', ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import prep; prep.restore_generated(sys.argv[2])', resolve('src/agents/dizayn'), wt], { stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(readFileSync(join(wt, 'a.html'), 'utf8'), 'original');
    assert.equal(existsSync(join(wt, 'blog/new.html')), false);
    assert.equal(readFileSync(join(wt, '_src/p.py'), 'utf8'), 'modified');
  } finally { rmSync(wt, { recursive: true, force: true }); }
});
