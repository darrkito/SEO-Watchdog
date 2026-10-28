// executorMode: env switch and fallback when Codex is not on the ChatGPT plan
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executorMode } from '../src/agents/agents.ts';
import { resetCodexAuthCache } from '../src/agents/runner.ts';

test('executorMode env switch and subscription fallback', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'executor-mode-'));
  const path = process.env.PATH, executor = process.env.AGENT_EXECUTOR;
  const calls = join(dir, 'calls');
  const fake = (status: string) => writeFileSync(join(dir, 'codex'), `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
if [ "$1" = login ] && [ "$2" = status ]; then
  printf '%s\\n' '${status}'
fi
`, { mode: 0o755 });
  try {
    process.env.PATH = `${dir}:${path ?? ''}`;
    delete process.env.AGENT_EXECUTOR;
    resetCodexAuthCache();
    fake('Logged in using ChatGPT');
    await t.test('claude bypasses codex', () => {
      process.env.AGENT_EXECUTOR = 'claude';
      try {
        assert.equal(executorMode(), 'claude');
        assert.equal(existsSync(calls), false);
      } finally { delete process.env.AGENT_EXECUTOR; }
    });
    await t.test('ChatGPT login selects hybrid', () => {
      assert.equal(executorMode(), 'hybrid');
      assert.equal(readFileSync(calls, 'utf8'), 'login status\n');
    });
    delete process.env.AGENT_EXECUTOR;
    await t.test('missing login falls back and warns only once', () => {
      resetCodexAuthCache();
      fake('Not logged in');
      const warn = t.mock.method(console, 'warn', () => {});
      try {
        assert.equal(executorMode(), 'claude');
        assert.equal(executorMode(), 'claude');
        assert.equal(warn.mock.callCount(), 1);
        assert.match(warn.mock.calls[0].arguments[0], /^\[agents\] Codex is not available, falling back to the Claude-only executor: .*Not logged in/);
      } finally { warn.mock.restore(); }
    });
  } finally {
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
    if (executor === undefined) delete process.env.AGENT_EXECUTOR; else process.env.AGENT_EXECUTOR = executor;
    resetCodexAuthCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
