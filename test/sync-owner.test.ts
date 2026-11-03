import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncOwnerCheckout } from '../src/agents/agents.ts';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'wd-sync-owner-'));
  const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  g(root, 'clone', '-q', 'origin.git', 'owner');
  const owner = join(root, 'owner');
  g(owner, 'config', 'user.email', 'test@example.com'); g(owner, 'config', 'user.name', 'Test');
  writeFileSync(join(owner, 'initial.txt'), 'initial\n');
  g(owner, 'add', '.'); g(owner, 'commit', '-qm', 'initial'); g(owner, 'push', '-q', 'origin', 'main');
  g(root, 'clone', '-q', 'origin.git', 'agent');
  const agent = join(root, 'agent');
  g(agent, 'config', 'user.email', 'test@example.com'); g(agent, 'config', 'user.name', 'Test');
  writeFileSync(join(agent, 'agent.txt'), 'agent\n');
  g(agent, 'add', '.'); g(agent, 'commit', '-qm', 'agent'); g(agent, 'push', '-q', 'origin', 'main');
  g(owner, 'fetch', '-q', 'origin');
  return { root, owner, agent, g };
}

test('syncOwnerCheckout fast-forwards main to the agent push', (t) => {
  const { root, owner, agent, g } = setup(); t.after(() => rmSync(root, { recursive: true, force: true }));
  syncOwnerCheckout({ repo: owner, remote: 'origin' });
  assert.equal(g(owner, 'rev-parse', 'HEAD'), g(agent, 'rev-parse', 'HEAD'));
});

test('syncOwnerCheckout leaves diverged main unchanged', (t) => {
  const { root, owner, g } = setup(); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(owner, 'owner.txt'), 'owner\n');
  g(owner, 'add', '.'); g(owner, 'commit', '-qm', 'owner');
  const head = g(owner, 'rev-parse', 'HEAD');
  assert.doesNotThrow(() => syncOwnerCheckout({ repo: owner, remote: 'origin' }));
  assert.equal(g(owner, 'rev-parse', 'HEAD'), head);
});

test('syncOwnerCheckout leaves other branches unchanged', (t) => {
  const { root, owner, g } = setup(); t.after(() => rmSync(root, { recursive: true, force: true }));
  g(owner, 'checkout', '-qb', 'other');
  const head = g(owner, 'rev-parse', 'HEAD');
  assert.doesNotThrow(() => syncOwnerCheckout({ repo: owner, remote: 'origin' }));
  assert.equal(g(owner, 'rev-parse', 'HEAD'), head);
});
