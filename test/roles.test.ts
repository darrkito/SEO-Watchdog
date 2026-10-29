import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { systemPrompt, EFFORT, type Role } from '../src/agents/templates/roles.ts';
import { claudeArgs } from '../src/agents/runner.ts';
import { claudeOptions } from '../src/agents/agents.ts';

test('rules and role prompts', () => {
  const rules = readFileSync(new URL('../src/agents/templates/claude-rules.md', import.meta.url), 'utf8').trimEnd();
  const lines = rules.split('\n');
  assert.ok(lines.length <= 25);
  assert.equal(lines.length, 8);
  for (let i = 0; i < 8; i++) assert.match(lines[i], new RegExp(`^${i + 1}\\. `));
  for (const [role, fragment] of Object.entries({ research: '900 palabras', plan: 'UNA orden', revise: 'problemas', review: '60 palabras', fixplan: 'UNA orden', analyst: '', other: '' })) {
    const prompt = systemPrompt(role as Role);
    assert.ok(prompt.startsWith(rules));
    assert.ok(fragment ? prompt.includes(`\n\n`) && prompt.includes(fragment) : prompt === rules);
  }
});

test('effort defaults and validated overrides', () => {
  const keys = ['AGENT_EFFORT', ...(['research', 'plan', 'revise', 'review', 'fixplan', 'analyst', 'other'] as Role[]).map(r => `AGENT_EFFORT_${r.toUpperCase()}`)];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    assert.deepEqual({ ...EFFORT }, { research: 'medium', plan: 'medium', revise: 'low', review: 'low', fixplan: 'medium', analyst: 'medium', other: 'medium' });
    process.env.AGENT_EFFORT = 'xhigh';
    process.env.AGENT_EFFORT_REVIEW = 'max';
    assert.equal(EFFORT.review, 'max');
    assert.equal(EFFORT.plan, 'xhigh');
    process.env.AGENT_EFFORT_REVIEW = 'invalid';
    assert.equal(EFFORT.review, 'xhigh');
    process.env.AGENT_EFFORT = 'invalid';
    assert.equal(EFFORT.review, 'low');
  } finally {
    for (const k of keys) saved[k] === undefined ? delete process.env[k] : process.env[k] = saved[k];
  }
});

test('Claude arguments and role options preserve the old call shape', () => {
  const o = { prompt: 'hi', cwd: '/tmp', tools: ['Read'], maxTurns: 2, timeoutMs: 1000, model: 'existing-model' };
  const old = claudeArgs(o);
  assert.deepEqual(old, ['-n', '19', 'claude', '-p', '--output-format', 'json', '--max-turns', '2', '--no-session-persistence', '--setting-sources', 'project', '--model', 'existing-model', '--tools', 'Read', '--allowedTools', 'Read']);
  assert.deepEqual(claudeArgs({ ...o, system: 'one argument', effort: 'low' }), [...old, '--system-prompt', 'one argument', '--effort', 'low']);
  assert.deepEqual(claudeOptions(o), o);
  const roleOptions = claudeOptions({ ...o, role: 'review' });
  assert.equal(roleOptions.system, systemPrompt('review'));
  assert.equal(roleOptions.effort, EFFORT.review);
});
