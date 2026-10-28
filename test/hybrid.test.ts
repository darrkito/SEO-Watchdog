import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HybridLimit, revisePrompt, runHybrid, type HybridDeps, type HybridInput } from '../src/agents/hybrid.ts';
import { simulateOrder, type WorkOrder } from '../src/agents/orders.ts';
import type { CodexResult } from '../src/agents/runner.ts';

const ok: CodexResult = { ok: true, blocked: false, limited: false, text: 'DONE' };
const approved = { ok: true, problems: [] };
const initial: WorkOrder = { title: 'Create', steps: [{ n: 1, file: 'a.txt', do: 'create', text: 'hello' }], mustContain: ['hello'], forbiddenPaths: [], doneWhen: 'created' };
const change: WorkOrder = { title: 'Change', steps: [{ n: 1, file: 'a.txt', do: 'replace', anchor: 'hello', text: 'better' }], mustContain: ['better'], forbiddenPaths: [], doneWhen: 'changed' };
const invalid: WorkOrder = { ...change, steps: [{ ...change.steps[0], anchor: 'missing' }] };
const raw = (order: WorkOrder) => JSON.stringify(order);
function applyOrder(order: WorkOrder, root: string): CodexResult {
  const result = simulateOrder(order, root);
  assert.deepEqual(result.problems, []);
  for (const [file, content] of result.files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return { ...ok };
}
function fakeCodex(root: string, opts: { actions: ((prompt: string, root: string) => CodexResult)[] }) {
  const prompts: string[] = [];
  return {
    prompts,
    execute: async (prompt: string): Promise<CodexResult> => {
      prompts.push(prompt);
      const action = opts.actions.shift();
      assert.ok(action, 'unexpected execute call');
      return action(prompt, root);
    },
  };
}
function fixture(t: { after: (fn: () => void) => void }, actions: ((prompt: string, root: string) => CodexResult)[]) {
  const root = mkdtempSync(join(tmpdir(), 'hybrid-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const codex = fakeCodex(root, { actions });
  const d: HybridDeps = {
    root, plan: async () => raw(initial), revise: async () => assert.fail('unexpected revise'),
    execute: codex.execute, verify: () => null,
    addedText: () => existsSync(join(root, 'a.txt')) ? readFileSync(join(root, 'a.txt'), 'utf8') : '',
    diff: () => ' context\n+hello', review: async () => approved, log: () => {},
  };
  const input: HybridInput = { planPrompt: 'Make the first order', rules: 'Keep it exact', allowedPaths: ['a.txt'] };
  return { root, codex, d, input };
}
const apply = (order: WorkOrder) => (_prompt: string, root: string) => applyOrder(order, root);

test('first order succeeds with exact stage counters', async (t) => {
  const { d, input, root } = fixture(t, [apply(initial)]);
  d.plan = async (prompt) => { assert.equal(prompt, input.planPrompt); return raw(initial); };
  d.review = async (order, diff) => { assert.deepEqual(order, initial); assert.equal(diff, d.diff()); return approved; };
  const result = await runHybrid(d, input);
  assert.deepEqual(result.stages, { plans: 1, revisions: 0, executions: 1, reviews: 1, rounds: 0 });
  assert.deepEqual(result.orders, [initial]);
  assert.deepEqual(result.review, approved);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'hello');
});

test('preflight retries before executing and includes anchor failure', async (t) => {
  const { d, input, root, codex } = fixture(t, [apply(change)]);
  writeFileSync(join(root, 'a.txt'), 'hello');
  let plans = 0;
  d.plan = async (prompt) => {
    assert.equal(codex.prompts.length, 0);
    if (++plans === 1) return raw(invalid);
    assert.ok(prompt.startsWith(input.planPrompt));
    assert.match(prompt, /Your previous order failed validation/);
    assert.match(prompt, /occurs 0 times/);
    return raw(change);
  };
  const result = await runHybrid(d, input);
  assert.equal(result.stages.plans, 2);
  assert.equal(result.stages.executions, 1);
});

test('three invalid plans reject without executing', async (t) => {
  const { d, input, codex } = fixture(t, []);
  let plans = 0;
  d.plan = async () => { plans++; return 'invalid'; };
  await assert.rejects(runHybrid(d, input), /plan rejected/);
  assert.equal(plans, 3);
  assert.equal(codex.prompts.length, 0);
});

test('deviating output gets one deterministic fix', async (t) => {
  const { d, input } = fixture(t, [(_prompt, root) => {
    writeFileSync(join(root, 'a.txt'), 'wrong'); return ok;
  }, (prompt, root) => {
    assert.match(prompt, /differs from the order's expected result/);
    assert.match(prompt, /Fix ONLY/);
    return applyOrder(initial, root);
  }]);
  const result = await runHybrid(d, input);
  assert.equal(result.stages.executions, 2);
  assert.equal(result.stages.revisions, 0);
});

test('blocked executor goes directly to revision', async (t) => {
  const { d, input } = fixture(t, [() => ({ ...ok, ok: false, blocked: true, error: 'BLOCKED: anchor missing' }), apply(initial)]);
  d.revise = async (prompt) => { assert.match(prompt, /executor: BLOCKED: anchor missing/); return raw(initial); };
  const result = await runHybrid(d, input);
  assert.equal(result.stages.revisions, 1);
  assert.equal(result.stages.rounds, 1);
  assert.equal(result.orders.length, 2);
});

test('reviewer supplied change order skips revise', async (t) => {
  const { d, input } = fixture(t, [apply(initial), apply(change)]);
  let reviews = 0;
  d.review = async () => ++reviews === 1 ? { ok: false, problems: ['improve'], changeOrder: raw(change) } : approved;
  const result = await runHybrid(d, input);
  assert.equal(result.stages.rounds, 1);
  assert.equal(result.orders.length, 2);
  assert.equal(result.stages.revisions, 0);
  assert.equal(result.stages.reviews, 2);
});

test('review without change order requests revision with diff and problem', async (t) => {
  const { d, input } = fixture(t, [apply(initial), apply(change)]);
  let reviews = 0;
  d.review = async () => ++reviews === 1 ? { ok: false, problems: ['improve'] } : approved;
  d.revise = async (prompt) => {
    assert.ok(prompt.includes(d.diff()));
    assert.match(prompt, /reviewer: improve/);
    return raw(change);
  };
  assert.equal((await runHybrid(d, input)).stages.revisions, 1);
});

test('never approved stops after three rounds', async (t) => {
  const { d, input, codex } = fixture(t, [apply(initial), apply(initial), apply(initial)]);
  let revisions = 0, reviews = 0;
  d.review = async () => { reviews++; return { ok: false, problems: ['still wrong'] }; };
  d.revise = async () => { revisions++; return raw(initial); };
  await assert.rejects(runHybrid(d, input), /not approved after 3 rounds: reviewer: still wrong/);
  assert.equal(codex.prompts.length, 3);
  assert.equal(reviews, 3);
  assert.equal(revisions, 2);
});

test('usage limit throws HybridLimit before review or revision', async (t) => {
  const { d, input } = fixture(t, [() => ({ ...ok, ok: false, limited: true })]);
  d.review = async () => assert.fail('unexpected review');
  await assert.rejects(runHybrid(d, input), (e) => e instanceof HybridLimit && e.message === 'codex usage limit');
});

test('persistent verification failure gets a fix then revision', async (t) => {
  const { d, input } = fixture(t, [apply(initial), (prompt) => {
    assert.match(prompt, /Fix ONLY/); assert.match(prompt, /validator failed/); return ok;
  }, apply(change)]);
  let checks = 0;
  d.verify = () => ++checks <= 2 ? 'validator failed' : null;
  d.revise = async (prompt) => { assert.match(prompt, /validator failed/); return raw(change); };
  const result = await runHybrid(d, input);
  assert.deepEqual(result.stages, { plans: 1, revisions: 1, executions: 3, reviews: 1, rounds: 1 });
  assert.equal(checks, 3);
});

test('change order preflight retries use revise and report problems', async (t) => {
  const { d, input, codex } = fixture(t, [apply(initial), apply(change)]);
  let reviews = 0, revisions = 0;
  d.review = async () => ++reviews === 1 ? { ok: false, problems: ['improve'], changeOrder: raw(invalid) } : approved;
  d.revise = async (prompt) => {
    assert.equal(codex.prompts.length, 1);
    assert.ok(prompt.includes(input.planPrompt));
    assert.ok(prompt.includes(JSON.stringify(initial, null, 2)));
    assert.match(prompt, /Your previous order failed validation/);
    assert.match(prompt, /occurs 0 times/);
    return raw(++revisions === 1 ? invalid : change);
  };
  const result = await runHybrid(d, input);
  assert.equal(result.stages.revisions, 2);
  assert.equal(result.orders.length, 2);
});

test('change orders stop after three invalid attempts including supplied order', async (t) => {
  const { d, input, codex } = fixture(t, [apply(initial)]);
  let revisions = 0;
  d.review = async () => ({ ok: false, problems: ['improve'], changeOrder: 'invalid' });
  d.revise = async () => { revisions++; return 'invalid'; };
  await assert.rejects(runHybrid(d, input), /plan rejected/);
  assert.equal(revisions, 2);
  assert.equal(codex.prompts.length, 1);
});

test('revision generated change orders count each attempt once', async (t) => {
  const { d, input } = fixture(t, [apply(initial), apply(change)]);
  let reviews = 0, revisions = 0;
  d.review = async () => ++reviews === 1 ? { ok: false, problems: ['improve'] } : approved;
  d.revise = async (prompt) => {
    if (++revisions === 1) return 'invalid';
    assert.match(prompt, /Your previous order failed validation/);
    return raw(change);
  };
  assert.equal((await runHybrid(d, input)).stages.revisions, 2);
});

test('revisePrompt caps only diff and preserves exact instructions', () => {
  const ctx = { planPrompt: 'Original brief', previousOrder: initial };
  const suffix = '\n=== END OF DIFF ===\nReturn a CHANGE ORDER: the same JSON format as in the brief (analysis, title, meta, steps, mustContain, forbiddenPaths, doneWhen). If the diff is empty, nothing was written: the steps must then apply to the ORIGINAL files exactly as in the brief (use the verified anchors from the brief). If the diff is not empty, the steps fix ONLY the problems against the CURRENT state of the files, and every anchor must occur exactly once in the current files: copy it from the diff context. If a problem says text is not allowed or not in the repo facts, REMOVE that text instead of rewording it. JSON only, no prose.';
  const prefix = [
    'Below is the ORIGINAL BRIEF you were given, then the order you wrote from it, then why it is not approved. Write a corrected order.',
    '=== ORIGINAL BRIEF ===', ctx.planPrompt, '=== END OF ORIGINAL BRIEF ===',
    '=== YOUR PREVIOUS ORDER (JSON) ===', JSON.stringify(initial, null, 2), '=== END OF PREVIOUS ORDER ===',
    '=== PROBLEMS ===', '- one', '- two',
    '=== CURRENT CHANGES IN THE WORKTREE (diff with context; empty means nothing was written) ===', '',
  ].join('\n');
  assert.equal(revisePrompt(['one', 'two'], 'x'.repeat(60000) + 'OVER', ctx), prefix + 'x'.repeat(60000) + '\n[diff cut]' + suffix);
  assert.equal(revisePrompt(['one', 'two'], 'x'.repeat(60000), ctx), prefix + 'x'.repeat(60000) + suffix);
});

test('revisePrompt includes original brief, previous order, and problems when nothing was written', () => {
  const prompt = revisePrompt(['executor refused', 'text is not allowed'], '', { planPrompt: 'Original planning brief with verified anchors', previousOrder: initial });
  assert.ok(prompt.includes('Original planning brief with verified anchors'));
  assert.ok(prompt.includes(initial.title));
  assert.ok(prompt.includes(JSON.stringify(initial, null, 2)));
  assert.ok(prompt.includes('=== PROBLEMS ===\n- executor refused\n- text is not allowed'));
  assert.ok(prompt.includes('empty means nothing was written'));
});
