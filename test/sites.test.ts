import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_SITES } from '../src/agents/sites.ts';

test('site rules do not instruct models to read guide files', () => {
  const guides: Record<string, string[]> = { 'studioyume.mx': ['AGENTS.md', 'CLAUDE.md'], 'luvory.com.mx': ['CLAUDE.md', 'SEO.md'], 'vexonmexico.com.mx': ['README.md'], 'dizaynseo.com': [] };
  assert.deepEqual(Object.keys(AGENT_SITES).sort(), Object.keys(guides).sort());
  for (const [host, cfg] of Object.entries(AGENT_SITES)) {
    assert.doesNotMatch(cfg.rules, /Read CLAUDE|Lee primero|read (the )?README/i);
    assert.doesNotMatch(cfg.writerRules, /Read CLAUDE|Lee primero|read (the )?README/i);
    assert.deepEqual(cfg.guideFiles, guides[host]);
  }
});
