// executorMode: an explicit env switch only. A missing Codex login must never silently select the costly Claude-only executor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executorMode } from '../src/agents/agents.ts';

test('executorMode never probes Codex and never falls back on its own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'executor-mode-'));
  const path = process.env.PATH, executor = process.env.AGENT_EXECUTOR;
  const calls = join(dir, 'calls');
  writeFileSync(join(dir, 'codex'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nprintf '%s\\n' 'Not logged in'\n`, { mode: 0o755 });
  try {
    process.env.PATH = `${dir}:${path ?? ''}`;
    delete process.env.AGENT_EXECUTOR;
    assert.equal(executorMode(), 'hybrid');
    process.env.AGENT_EXECUTOR = 'claude';
    assert.equal(executorMode(), 'claude');
    assert.equal(existsSync(calls), false);
  } finally {
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
    if (executor === undefined) delete process.env.AGENT_EXECUTOR; else process.env.AGENT_EXECUTOR = executor;
    rmSync(dir, { recursive: true, force: true });
  }
});
