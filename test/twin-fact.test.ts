import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { twinFacts } from '../src/agents/agents.ts';
import { reviewPrompt } from '../src/agents/prompts.ts';

const slug = 'what-ai-visibility-checker-measures';
const twin = { file: '_src/posts_es.py', key: 'en' };

test('twin facts verify the link and handle missing inputs', () => {
  const wt = mkdtempSync(join(tmpdir(), 'twin-fact-'));
  try {
    mkdirSync(join(wt, '_src'));
    writeFileSync(join(wt, twin.file), `POSTS_ES.append({
"en": "what-ai-visibility-checker-measures",
"slug": "como-saber-si-mi-negocio-aparece-en-busqueda-con-ia",
"stage": "solution",
`);
    const facts = twinFacts({ twin }, wt, slug);
    assert.equal(facts.length, 1);
    assert.match(facts[0], /como-saber-si-mi-negocio-aparece-en-busqueda-con-ia/);
    assert.match(facts[0], /línea 2/);
    assert.deepEqual(twinFacts({ twin }, wt, 'missing'), []);
    assert.deepEqual(twinFacts({}, wt, slug), []);
    assert.deepEqual(twinFacts({ twin: { ...twin, file: 'missing.py' } }, wt, slug), []);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test('review prompt includes verified facts only when provided', () => {
  const args = { rules: '', writerRules: '', audience: '', facts: [], orders: [], diff: '' };
  const heading = 'HECHOS VERIFICADOS POR EL CÓDIGO (son ciertos:';
  assert.ok(reviewPrompt({ ...args, verified: ['X'] }).includes(heading));
  assert.ok(reviewPrompt({ ...args, verified: ['X'] }).includes('- X'));
  assert.ok(!reviewPrompt(args).includes(heading));
});
