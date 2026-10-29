import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOrder, orderPrompt, fixPrompt, BIG, writeStepFiles, clearStepFiles, applyCheck, verbatimCheck, simulateOrder, preflightOrder, compareFiles, type WorkOrder, type EditStep } from '../src/agents/orders.ts';

const step: EditStep = { n: 1, file: 'a.txt', do: 'insert-after', anchor: 'old', text: 'new' };
const order = (steps: EditStep[] = [{ ...step }]): WorkOrder => ({ title: 'Test', steps, mustContain: [], forbiddenPaths: [], doneWhen: '' });
const done = 'Your last message must be `DONE` followed by one line per step (`1 ok`, `2 ok`, ...). Nothing else.';

test('parseOrder accepts fenced JSON and applies defaults', () => {
  assert.deepEqual(parseOrder('```json\n' + JSON.stringify({ title: 'Test', steps: [step] }) + '\n```'), order());
  assert.equal(parseOrder(JSON.stringify({ ...order(), steps: [{ ...step, note: 'keep' }] })).steps[0].note, 'keep');
  assert.equal(parseOrder(JSON.stringify({ ...order(), steps: [{ ...step, note: 2 }] })).steps[0].note, undefined);
});

for (const [name, patch, message] of [
  ['parent path', { file: '../x' }, /relative path/],
  ['absolute path', { file: '/x' }, /relative path/],
  ['backslash path', { file: 'a\\b' }, /backslash/],
  ['wrong sequence', { n: 2 }, /n must equal 1/],
  ['missing anchor', { anchor: undefined }, /anchor/],
  ['delete text', { do: 'delete' }, /delete must not have text/],
  ['create anchor', { do: 'create' }, /create must not have anchor/],
  ['unknown operation', { do: 'move' }, /unknown do/],
] as const) {
  test(`parseOrder rejects ${name}`, () => {
    assert.throws(() => parseOrder(JSON.stringify({ ...order(), steps: [{ ...step, ...patch }] })), message);
  });
}

test('parseOrder enforces allowed and forbidden paths independently', () => {
  assert.throws(() => parseOrder(JSON.stringify(order()), { allowedPaths: ['public/*'] }), /outside allowedPaths/);
  assert.throws(() => parseOrder(JSON.stringify({ ...order(), forbiddenPaths: ['a'] })), /under forbiddenPaths/);
  assert.deepEqual(parseOrder(JSON.stringify(order()), { allowedPaths: ['a*'] }), order());
});

test('parseOrder rejects empty steps and collects all three problems', () => {
  assert.throws(() => parseOrder(JSON.stringify(order([]))), /steps must have 1 to 40 items/);
  assert.throws(() => parseOrder(JSON.stringify({ ...order(), title: '', steps: [{ ...step, n: 3, anchor: undefined }] })), (error: Error) => {
    assert.match(error.message, /^Invalid work order: /);
    assert.match(error.message, /title/);
    assert.match(error.message, /n must equal 1/);
    assert.match(error.message, /anchor/);
    assert.equal(error.message.split('; ').length, 3);
    return true;
  });
});

test('parseOrder validates array fields, limits and required text', () => {
  for (const patch of [{ mustContain: [''] }, { forbiddenPaths: [2] }, { doneWhen: null }, { steps: Array(41).fill(step) }]) {
    assert.throws(() => parseOrder(JSON.stringify({ ...order(), ...patch })), /Invalid work order:/);
  }
  for (const op of ['create', 'append', 'insert-before', 'insert-after'] as const) {
    const s = { ...step, do: op, text: '', ...(['create', 'append'].includes(op) ? { anchor: undefined } : {}) };
    assert.throws(() => parseOrder(JSON.stringify(order([s]))), /text must be/);
  }
  assert.equal(parseOrder(JSON.stringify(order([{ ...step, do: 'replace', text: '' }]))).steps[0].text, '');
});

test('orderPrompt preserves exact blocks and requested structure', () => {
  const text = '  `code` ${x}\n\nlast\n';
  const anchor = '  old\nline';
  const value = order([{ ...step, text, anchor, note: 'Exact' }]);
  const prompt = orderPrompt(value, 'Keep spacing');
  assert.ok(prompt.startsWith('You are an executor, not a designer. Do exactly the numbered steps below.'));
  assert.ok(prompt.includes('STEP 1: insert-after in a.txt\nNOTE: Exact'));
  assert.ok(prompt.includes('<<<ANCHOR\n' + anchor + '\nANCHOR>>>'));
  assert.ok(prompt.includes('<<<TEXT\n' + text + '\nTEXT>>>'));
  assert.ok(prompt.includes('SITE RULES (already applied by the planner and checked afterwards by a reviewer; you only execute, never enforce them):\nKeep spacing'));
  assert.ok(!orderPrompt(value, '').includes('SITE RULES (already applied by the planner and checked afterwards by a reviewer; you only execute, never enforce them):'));
  assert.ok(prompt.includes('FORBIDDEN PATHS: none'));
  assert.ok(prompt.includes('DONE WHEN: all steps are applied'));
  assert.ok(prompt.endsWith(done));
  assert.ok(orderPrompt(order([{ ...step, do: 'replace', text: '' }]), '').includes('<<<TEXT\n\nTEXT>>>'));
});

test('fixPrompt shares header, caps error and lists files and rules', () => {
  const error = 'x'.repeat(5000);
  const prompt = fixPrompt(error, ['a.txt', 'b.txt'], 'Keep spacing');
  assert.equal(prompt.split('\n').slice(0, 4).join('\n'), orderPrompt(order(), '').split('\n').slice(0, 4).join('\n'));
  assert.ok(prompt.includes('A check failed after your edit. Fix ONLY what this error says. Change nothing else.'));
  assert.ok(prompt.includes('ERROR:\n' + 'x'.repeat(3000) + '\nFILES YOU MAY CHANGE: a.txt, b.txt'));
  assert.ok(!prompt.includes('x'.repeat(3001)));
  assert.ok(prompt.includes('SITE RULES (already applied by the planner and checked afterwards by a reviewer; you only execute, never enforce them):\nKeep spacing'));
  assert.ok(!fixPrompt('oops', [], '').includes('SITE RULES (already applied by the planner and checked afterwards by a reviewer; you only execute, never enforce them):'));
  assert.ok(prompt.endsWith(done));
});

test('applyCheck checks text, old anchors, required strings and missing files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orders-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.txt'), 'old\r\nnew\r\nrequired');
  const good = { ...order(), mustContain: ['required', 'old\nnew'] };
  assert.deepEqual(applyCheck(good, root), []);
  assert.deepEqual(applyCheck(order([{ ...step, text: 'absent' }]), root), ['step 1: the text is not in a.txt']);
  assert.deepEqual(applyCheck(order([{ ...step, do: 'replace' }]), root), ['step 1: the old text is still in a.txt']);
  assert.deepEqual(applyCheck(order([{ n: 1, file: 'a.txt', do: 'delete', anchor: 'old' }]), root), ['step 1: the old text is still in a.txt']);
  assert.deepEqual(applyCheck({ ...order(), mustContain: ['missing'] }, root), ['missing required text: missing']);
  assert.deepEqual(applyCheck(order([{ ...step, file: 'missing.txt' }]), root), ['step 1: the text is not in missing.txt']);
  assert.deepEqual(applyCheck(order([{ ...step, do: 'replace', text: 'old\r\nnew' }]), root), []);
  assert.deepEqual(applyCheck(order([{ ...step, do: 'replace', anchor: 'gone', text: '' }]), root), []);
  assert.deepEqual(applyCheck(order([{ n: 1, file: 'a.txt', do: 'delete', anchor: 'gone' }]), root), []);
  for (const op of ['create', 'append', 'insert-before'] as const) {
    assert.deepEqual(applyCheck(order([{ ...step, do: op, text: '  new\nrequired  ' }]), root), []);
  }
  writeFileSync(join(root, 'b.txt'), 'elsewhere');
  assert.deepEqual(applyCheck({ ...order([step, { n: 2, file: 'b.txt', do: 'append', text: 'elsewhere' }]), mustContain: ['elsewhere'] }, root), []);
});

test('verbatimCheck returns only missing strings, normalizes CRLF and truncates', () => {
  const value = { ...order(), mustContain: ['present', 'a\r\nb', 'c\nd', 'missing', 'z'.repeat(100)] };
  assert.deepEqual(verbatimCheck(value, 'present\na\nb\nc\r\nd'), ['missing in diff: missing', 'missing in diff: ' + 'z'.repeat(80)]);
});

test('parseOrder validates replace-range anchors and text', () => {
  const range: EditStep = { ...step, do: 'replace-range', endAnchor: 'end' };
  assert.deepEqual(parseOrder(JSON.stringify(order([range]))), order([range]));
  assert.equal(parseOrder(JSON.stringify(order([{ ...range, text: '' }]))).steps[0].text, '');
  for (const endAnchor of [undefined, '', '  ', 2]) {
    assert.throws(() => parseOrder(JSON.stringify({ ...order(), steps: [{ ...range, endAnchor }] })), /step 1: endAnchor must be a non-empty string/);
  }
  for (const anchor of [undefined, '', '  ', 2]) {
    assert.throws(() => parseOrder(JSON.stringify({ ...order(), steps: [{ ...range, anchor }] })), /step 1: anchor must be a non-empty string/);
  }
  for (const text of [undefined, null, 2]) {
    assert.throws(() => parseOrder(JSON.stringify({ ...order(), steps: [{ ...range, text }] })), /step 1: text must be a string/);
  }
  assert.throws(() => parseOrder(JSON.stringify(order([{ ...range, do: 'replace' }]))), /step 1: replace must not have endAnchor/);
});

test('orderPrompt describes replace-range and preserves its end anchor block', () => {
  const endAnchor = '  end\nexact line\n';
  const prompt = orderPrompt(order([{ ...step, do: 'replace-range', endAnchor }]), '');
  assert.ok(prompt.includes('ANCHOR (must occur exactly once in the file; the replaced range starts here):\n<<<ANCHOR\nold\nANCHOR>>>'));
  assert.ok(prompt.includes('ANCHOR>>>\nEND ANCHOR (first occurrence AFTER the anchor; everything from the start of ANCHOR up to, but NOT including, END ANCHOR is replaced by TEXT):\n<<<ENDANCHOR\n' + endAnchor + '\nENDANCHOR>>>\nTEXT:'));
  const operations = 'Operations: create writes the whole file (replacing it if it exists); replace swaps ANCHOR for TEXT; replace-range swaps everything from ANCHOR up to END ANCHOR (not included) for TEXT; insert-after / insert-before put TEXT next to ANCHOR; append adds TEXT at the end of the file; delete removes ANCHOR.';
  assert.equal(prompt.split('\n')[5], operations);
  assert.equal(fixPrompt('oops', ['a.txt'], '').split('\n')[5], operations);
});

test('applyCheck checks replace-range text and old anchors', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orders-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const range: EditStep = { ...step, do: 'replace-range', endAnchor: 'end' };
  writeFileSync(join(root, 'a.txt'), 'new\nend');
  assert.deepEqual(applyCheck(order([range]), root), []);
  assert.deepEqual(applyCheck(order([{ ...range, text: 'absent' }]), root), ['step 1: the text is not in a.txt']);
  writeFileSync(join(root, 'a.txt'), 'old\nnew\nend');
  assert.deepEqual(applyCheck(order([range]), root), ['step 1: the old text is still in a.txt']);
  assert.deepEqual(applyCheck(order([{ ...range, text: 'old\nnew' }]), root), []);
  writeFileSync(join(root, 'a.txt'), 'end');
  assert.deepEqual(applyCheck(order([{ ...range, text: '' }]), root), []);
});

test('simulateOrder applies every operation sequentially with exact contents', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orders-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.txt'), 'overwritten');
  writeFileSync(join(root, 'b.txt'), 'end before START old end tail end');
  writeFileSync(join(root, 'untouched.txt'), 'untouched');
  const value = order([
    { n: 1, file: 'a.txt', do: 'create', text: 'base' },
    { n: 2, file: 'a.txt', do: 'append', text: '|tail' },
    { n: 3, file: 'a.txt', do: 'insert-after', anchor: 'base', text: '|new' },
    { n: 4, file: 'a.txt', do: 'insert-before', anchor: 'new', text: 'before-' },
    { n: 5, file: 'a.txt', do: 'replace', anchor: 'before-new', text: 'changed' },
    { n: 6, file: 'a.txt', do: 'delete', anchor: '|tail' },
    { n: 7, file: 'b.txt', do: 'replace-range', anchor: 'START', endAnchor: 'end', text: 'replacement ' },
    { n: 8, file: 'c.txt', do: 'create', text: 'fresh' },
    { n: 9, file: 'c.txt', do: 'append', text: '!' },
  ]);
  value.mustContain = ['base|changed', 'replacement end', 'fresh!'];
  const result = simulateOrder(value, root);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.files, new Map([
    ['a.txt', 'base|changed'], ['b.txt', 'end before replacement end tail end'], ['c.txt', 'fresh!'],
  ]));
  assert.deepEqual(preflightOrder(value, root), []);
});

test('simulateOrder reports problems, skips failed steps and continues', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orders-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.txt'), 'twice twice START');
  const value = order([
    { n: 1, file: 'a.txt', do: 'replace', anchor: 'absent', text: 'bad' },
    { n: 2, file: 'a.txt', do: 'delete', anchor: 'twice' },
    { n: 3, file: 'a.txt', do: 'replace-range', anchor: 'START', endAnchor: 'END', text: 'bad' },
    { n: 4, file: 'missing.txt', do: 'replace', anchor: 'x', text: 'bad' },
    { n: 5, file: 'missing.txt', do: 'append', text: 'bad' },
    { n: 6, file: 'a.txt', do: 'append', text: '!' },
    { n: 7, file: 'b.txt', do: 'create', text: 'other' },
  ]);
  value.mustContain = ['missing', 'z'.repeat(100), 'START!\nother'];
  const result = simulateOrder(value, root);
  assert.deepEqual(result.problems, [
    'step 1: anchor occurs 0 times in a.txt (needs exactly 1)',
    'step 2: anchor occurs 2 times in a.txt (needs exactly 1)',
    'step 3: end anchor not found after the anchor in a.txt',
    'step 4: missing.txt does not exist',
    'step 5: missing.txt does not exist (use create)',
    'missing required text: missing',
    'missing required text: ' + 'z'.repeat(80),
    'missing required text: START!\nother',
  ]);
  assert.deepEqual(result.files, new Map([['a.txt', 'twice twice START!'], ['b.txt', 'other']]));
  assert.deepEqual(preflightOrder(value, root), result.problems);
});

test('simulateOrder normalizes CRLF files, anchors, end anchors and text', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orders-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.txt'), 'start\r\nold\r\nend\r\n');
  const value = order([
    { n: 1, file: 'a.txt', do: 'replace', anchor: 'start\nold', text: 'start\r\nnew' },
    { n: 2, file: 'a.txt', do: 'replace-range', anchor: 'start\r\n', endAnchor: 'end\r\n', text: 'final\r\n' },
  ]);
  value.mustContain = ['final\r\nend'];
  assert.deepEqual(simulateOrder(value, root), { files: new Map([['a.txt', 'final\nend\n']]), problems: [] });
});

test('compareFiles checks exact lines, truncates both excerpts and reports missing files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orders-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.txt'), 'first\r\n' + 'a'.repeat(100) + '\r\nlast');
  const expected = new Map([['a.txt', 'first\n' + 'a'.repeat(100) + '\nlast']]);
  assert.deepEqual(compareFiles(expected, root), []);
  expected.set('a.txt', 'first\n' + 'b'.repeat(100) + '\nlast');
  expected.set('missing.txt', 'content');
  assert.deepEqual(compareFiles(expected, root), [
    `a.txt: differs from the order's expected result at line 2: expected "${'b'.repeat(80)}" but found "${'a'.repeat(80)}"`,
    'missing.txt: expected file is missing',
  ]);
  writeFileSync(join(root, 'a.txt'), 'first');
  assert.deepEqual(compareFiles(new Map([['a.txt', 'first\nsecond']]), root), [
    `a.txt: differs from the order's expected result at line 2: expected "second" but found "<end of file>"`,
  ]);
  assert.deepEqual(compareFiles(new Map([['a.txt', 'first\n']]), root), [
    `a.txt: differs from the order's expected result at line 2: expected "" but found "<end of file>"`,
  ]);
});

test('parseOrder keeps string analysis, ignores other types and omits it from prompts', () => {
  for (const analysis of ['Human reasoning only', '']) {
    const parsed = parseOrder(JSON.stringify({ ...order(), analysis }));
    assert.equal(parsed.analysis, analysis);
    assert.equal(orderPrompt(parsed, ''), orderPrompt(order(), ''));
  }
  for (const analysis of [42, null, false, {}, []]) {
    assert.deepEqual(parseOrder(JSON.stringify({ ...order(), analysis })), order());
  }
});


test('claims are parsed from meta, filtered, and overridden by top-level claims', () => {
  const valid = { claim: 'A fact', source: 'a.txt' };
  const meta = { claims: [valid, null, {}, { claim: ' ', source: 'x' }, { claim: 'x', source: '' }] };
  assert.deepEqual(parseOrder(JSON.stringify({ ...order(), meta })).claims, [valid]);
  assert.deepEqual(parseOrder(JSON.stringify({ ...order(), meta, claims: [{ claim: 'Other', source: 'url' }] })).claims, [{ claim: 'Other', source: 'url' }]);
  assert.equal(parseOrder(JSON.stringify({ ...order(), meta: { claims: 'bad' } })).claims, undefined);
});

test('executor prompt includes verified claims and mechanical blocking instruction', () => {
  const claim = 'c'.repeat(301), source = 's'.repeat(301);
  const prompt = orderPrompt({ ...order(), claims: [{ claim, source }] }, 'rules');
  assert.ok(prompt.includes('Block ONLY for mechanical reasons (anchor missing or ambiguous, file missing, text that cannot be placed). NEVER block, edit, soften or question the CONTENT of a text block: its facts were checked by the planner against the sources listed under VERIFIED CLAIMS and a reviewer checks it afterwards.'));
  assert.ok(prompt.includes('VERIFIED CLAIMS (each one was checked by the planner against the source shown; they are not yours to re-verify):\n- ' + claim.slice(0, 300) + ' [source: ' + source.slice(0, 300) + ']'));
  assert.ok(prompt.indexOf('VERIFIED CLAIMS (each') > prompt.indexOf('rules\n'));
  assert.ok(prompt.indexOf('VERIFIED CLAIMS (each') < prompt.indexOf('STEP 1:'));
  assert.ok(!orderPrompt(order(), '').includes('VERIFIED CLAIMS (each'));
});


test('large step fields are written exactly and referenced in prompts', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orders-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(writeStepFiles(order([{ ...step, text: 'x'.repeat(BIG) }]), root), new Map());
  assert.equal(existsSync(join(root, '.agent-order')), false);
  const big = '`code` ${x} unicode ☃\n\n' + 'x'.repeat(BIG) + '\n';
  const value = order([{ ...step, do: 'replace-range', text: big, anchor: big, endAnchor: big }, { n: 2, file: 'b', do: 'create', text: 'small' }]);
  const files = writeStepFiles(value, root);
  assert.deepEqual(files, new Map([[1, { text: '.agent-order/step-1.text', anchor: '.agent-order/step-1.anchor', endAnchor: '.agent-order/step-1.endAnchor' }]]));
  for (const path of Object.values(files.get(1)!)) assert.deepEqual(readFileSync(join(root, path)), Buffer.from(big, 'utf8'));
  const prompt = orderPrompt(value, '', files);
  for (const [label, path] of [['TEXT', files.get(1)!.text], ['ANCHOR', files.get(1)!.anchor], ['END ANCHOR', files.get(1)!.endAnchor]]) {
    assert.ok(prompt.includes(`${label}: stored in the file ${path} (${big.length} characters, ${big.split('\n').length} lines); use its content exactly and in full.`));
  }
  assert.ok(prompt.includes('LARGE TEXT: some texts are stored in files under .agent-order/'));
  assert.ok(!prompt.includes(big));
  assert.ok(prompt.includes('<<<TEXT\nsmall\nTEXT>>>'));
  clearStepFiles(root);
  assert.equal(existsSync(join(root, '.agent-order')), false);
});

test('orderPrompt without files retains the inline snapshot', () => {
  const snapshot = [
    'You are an executor, not a designer. Do exactly the numbered steps below. Do not improve, reformat, rename, refactor, translate, shorten or add anything.',
    'Only the files named in the steps may be edited. Files generated by the repo hook may also have changes; ignore them. Do not touch any other file. Never run installs, network access, or git commands that write. Read-only commands (ls, cat, grep, git diff, git status) are allowed. The only exception is the LARGE TEXT section below, when it is present.',
    'If a step cannot be done exactly as written (an anchor is missing, or occurs more than once, or the file does not exist when it should), change NOTHING and make your last line `BLOCKED: <one-line reason>`.',
    'Block ONLY for mechanical reasons (anchor missing or ambiguous, file missing, text that cannot be placed). NEVER block, edit, soften or question the CONTENT of a text block: its facts were checked by the planner against the sources listed under VERIFIED CLAIMS and a reviewer checks it afterwards.',
    'Text blocks below are copied character for character, including indentation and blank lines. Keep it that way.',
    'Operations: create writes the whole file (replacing it if it exists); replace swaps ANCHOR for TEXT; replace-range swaps everything from ANCHOR up to END ANCHOR (not included) for TEXT; insert-after / insert-before put TEXT next to ANCHOR; append adds TEXT at the end of the file; delete removes ANCHOR.',
    '', 'ORDER: Test', '', 'STEP 1: insert-after in a.txt', 'ANCHOR (must occur exactly once in the file):', '<<<ANCHOR', 'old', 'ANCHOR>>>', 'TEXT:', '<<<TEXT', 'new', 'TEXT>>>', '', 'FORBIDDEN PATHS: none', 'DONE WHEN: all steps are applied', done,
  ].join('\n');
  assert.equal(orderPrompt(order(), '', undefined), snapshot);
  assert.equal(orderPrompt(order(), '', new Map()), snapshot);
  assert.ok(!snapshot.includes('LARGE TEXT:'));
  assert.ok(snapshot.split('\n')[1].endsWith('The only exception is the LARGE TEXT section below, when it is present.'));
});


test('parseOrder drops derived steps before validation and retains mustContain', () => {
  const input = { ...order(), steps: [{ ...step, file: 'generated/x' }, { ...step, n: 2 }], mustContain: ['keep'] };
  const result = parseOrder(JSON.stringify(input), { allowedPaths: ['a.txt'], derivedPaths: ['generated/*'] });
  assert.deepEqual(result.steps, [step]);
  assert.deepEqual(result.mustContain, ['keep']);
  assert.throws(() => parseOrder(JSON.stringify({ ...input, steps: [input.steps[0]] }), { derivedPaths: ['generated/*'] }), /steps must have 1 to 40 items/);
});
