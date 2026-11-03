import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clampFutureDates } from '../src/agents/agents.ts';

function setup() {
  const wt = mkdtempSync(join(tmpdir(), 'wd-future-dates-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com'); g('config', 'user.name', 'Test');
  writeFileSync(join(wt, 'initial.txt'), 'initial\n');
  g('add', '.'); g('commit', '-qm', 'initial');
  g('checkout', '-qb', 'agent/x');
  const original = '    modifiedAt: "2026-11-09",\n    intro: "Promo valida hasta 2026-11-09 en tienda",\n';
  writeFileSync(join(wt, 'post.ts'), original);
  g('add', '.'); g('commit', '-qm', 'post');
  return { wt, g, original };
}

test('clamps future date fields and amends the branch commit', (t) => {
  const { wt, g } = setup(); t.after(() => rmSync(wt, { recursive: true, force: true }));
  const count = g('rev-list', '--count', 'main..HEAD');
  assert.equal(clampFutureDates(wt, 'main', '2026-11-09', '2026-11-03'), 1);
  assert.equal(readFileSync(join(wt, 'post.ts'), 'utf8'), '    modifiedAt: "2026-11-03",\n    intro: "Promo valida hasta 2026-11-09 en tienda",\n');
  assert.equal(g('rev-list', '--count', 'main..HEAD'), count);
});

test('leaves dates unchanged when publishAt is today or undefined', (t) => {
  const { wt, original } = setup(); t.after(() => rmSync(wt, { recursive: true, force: true }));
  assert.equal(clampFutureDates(wt, 'main', '2026-11-03', '2026-11-03'), 0);
  assert.equal(readFileSync(join(wt, 'post.ts'), 'utf8'), original);
  assert.equal(clampFutureDates(wt, 'main', undefined, '2026-11-03'), 0);
  assert.equal(readFileSync(join(wt, 'post.ts'), 'utf8'), original);
});
