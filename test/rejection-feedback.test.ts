import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHybrid, type HybridDeps, type HybridInput } from '../src/agents/hybrid.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'feedback-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.txt'), 'initial');
  let n = 0, revisions = 0;
  const order = (anchor: string, text: string) => JSON.stringify({ title: 'Change', steps: [{ n: 1, file: 'a.txt', do: 'replace', anchor, text }], mustContain: [text], forbiddenPaths: [], doneWhen: 'changed' });
  const d: HybridDeps = {
    root, plan: async () => order('initial', 'version0'),
    revise: async (prompt) => { assert.match(prompt, /diagnóstico/); revisions++; return order(`version${n}`, `version${++n}`); },
    execute: async () => assert.fail('unexpected execute'), verify: () => null, addedText: () => '',
    diff: () => 'wide', reviewDiff: () => 'short', review: async () => ({ ok: true, problems: [] }), log: () => {},
  };
  const input: HybridInput = { planPrompt: 'brief', rules: '', allowedPaths: ['a.txt'] };
  return { d, input, revisions: () => revisions };
}

test('missing context retries with wide diff without revision', async (t) => {
  const { d, input, revisions } = fixture(t); let calls = 0;
  d.review = async (_orders, diff, previous) => {
    calls++; assert.equal(diff, calls === 1 ? 'short' : 'wide');
    if (calls === 2) assert.equal(previous.length, 1);
    return calls === 1 ? { ok: false, problems: ['no se ve el contexto'] } : { ok: true, problems: [] };
  };
  const result = await runHybrid(d, input);
  assert.equal(calls, 2); assert.equal(revisions(), 0); assert.equal(result.stages.reviews, 2); assert.equal(result.stages.rounds, 0);
});
test('repeated content stops immediately', async (t) => {
  const { d, input, revisions } = fixture(t);
  d.review = async () => ({ ok: false, problems: ['Cambiar el título'] });
  await assert.rejects(runHybrid(d, input), (e: Error) => /stuck after 2 rounds/.test(e.message) && /qué hacer \(repeat\)/.test(e.message));
  assert.equal(revisions(), 1);
});
test('different objections reach the round limit', async (t) => {
  const { d, input } = fixture(t); let calls = 0;
  d.review = async () => ({ ok: false, problems: [['Cambiar título', 'Corregir descripción', 'Añadir enlace'][calls++]] });
  await assert.rejects(runHybrid(d, input), (e: Error) => /not approved after 3 rounds/.test(e.message) && /qué hacer \(content\)/.test(e.message));
});
