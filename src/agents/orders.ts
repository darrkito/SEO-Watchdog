import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractJson } from './runner.ts';
import { pathAllowed } from './sites.ts';

export type EditOp = 'create' | 'replace' | 'replace-range' | 'insert-after' | 'insert-before' | 'append' | 'delete';
export type EditStep = { n: number; file: string; do: EditOp; anchor?: string; endAnchor?: string; text?: string; note?: string };
export type WorkOrder = { title: string; steps: EditStep[]; mustContain: string[]; forbiddenPaths: string[]; doneWhen: string; analysis?: string };

const ops: EditOp[] = ['create', 'replace', 'replace-range', 'insert-after', 'insert-before', 'append', 'delete'];
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseOrder(reply: string, o: { allowedPaths?: string[] } = {}): WorkOrder {
  const problems: string[] = [];
  let value: unknown;
  try { value = extractJson(reply); }
  catch (error) { problems.push(`JSON: ${(error as Error).message}`); }
  if (!record(value)) problems.push('order must be an object');
  const data = record(value) ? value : {};
  if (!nonempty(data.title)) problems.push('title must be a non-empty string');
  const mustContain = data.mustContain === undefined ? [] : data.mustContain;
  const forbiddenPaths = data.forbiddenPaths === undefined ? [] : data.forbiddenPaths;
  const doneWhen = data.doneWhen === undefined ? '' : data.doneWhen;
  if (!Array.isArray(mustContain) || !mustContain.every(nonempty)) problems.push('mustContain must be an array of non-empty strings');
  if (!Array.isArray(forbiddenPaths) || !forbiddenPaths.every((p) => typeof p === 'string')) problems.push('forbiddenPaths must be an array of strings');
  if (typeof doneWhen !== 'string') problems.push('doneWhen must be a string');
  if (!Array.isArray(data.steps) || data.steps.length < 1 || data.steps.length > 40) problems.push('steps must have 1 to 40 items');
  const steps: EditStep[] = [];
  if (Array.isArray(data.steps)) data.steps.forEach((value, index) => {
    const label = `step ${index + 1}`;
    if (!record(value)) { problems.push(`${label} must be an object`); return; }
    const step = value;
    if (step.n !== index + 1) problems.push(`${label}: n must equal ${index + 1}`);
    if (!nonempty(step.file) || step.file.startsWith('/') || step.file.includes('\\') || step.file.split('/').includes('..')) {
      problems.push(`${label}: file must be a non-empty relative path with no .. segment or backslash`);
    }
    if (typeof step.file === 'string') {
      const file = step.file;
      if (o.allowedPaths !== undefined && !pathAllowed(o.allowedPaths, file)) problems.push(`${label}: ${file} is outside allowedPaths`);
      if (Array.isArray(forbiddenPaths) && forbiddenPaths.some((p) => typeof p === 'string' && file.startsWith(p))) problems.push(`${label}: ${file} is under forbiddenPaths`);
    }
    if (!ops.includes(step.do as EditOp)) problems.push(`${label}: unknown do`);
    if (['replace', 'replace-range', 'insert-after', 'insert-before', 'delete'].includes(step.do as string) && !nonempty(step.anchor)) problems.push(`${label}: anchor must be a non-empty string`);
    if (step.do === 'replace-range' && !nonempty(step.endAnchor)) problems.push(`${label}: endAnchor must be a non-empty string`);
    if (step.do !== 'replace-range' && 'endAnchor' in step) problems.push(`${label}: ${step.do} must not have endAnchor`);
    if (step.do === 'replace-range' && typeof step.text !== 'string') problems.push(`${label}: text must be a string`);
    if (['create', 'append'].includes(step.do as string) && 'anchor' in step) problems.push(`${label}: ${step.do} must not have anchor`);
    if (step.do === 'delete' && 'text' in step) problems.push(`${label}: delete must not have text`);
    if (['create', 'replace', 'insert-after', 'insert-before', 'append'].includes(step.do as string)
      && (typeof step.text !== 'string' || (step.do !== 'replace' && step.text.length === 0))) problems.push(`${label}: text must be a string, non-empty except for replace`);
    steps.push({ n: step.n as number, file: step.file as string, do: step.do as EditOp,
      ...(typeof step.anchor === 'string' ? { anchor: step.anchor } : {}),
      ...(typeof step.endAnchor === 'string' ? { endAnchor: step.endAnchor } : {}),
      ...(typeof step.text === 'string' ? { text: step.text } : {}),
      ...(typeof step.note === 'string' ? { note: step.note } : {}) });
  });
  if (problems.length) throw new Error('Invalid work order: ' + problems.join('; '));
  return { title: data.title as string, steps, mustContain: mustContain as string[], forbiddenPaths: forbiddenPaths as string[], doneWhen: doneWhen as string,
    ...(typeof data.analysis === 'string' ? { analysis: data.analysis } : {}) };
}

const HEADER = [
  'You are an executor, not a designer. Do exactly the numbered steps below. Do not improve, reformat, rename, refactor, translate, shorten or add anything.',
  'Only the files named in the steps may change. Do not touch any other file. Never run installs, network access, or git commands that write. Read-only commands (ls, cat, grep, git diff, git status) are allowed.',
  'If a step cannot be done exactly as written (an anchor is missing, or occurs more than once, or the file does not exist when it should), change NOTHING and make your last line `BLOCKED: <one-line reason>`.',
  'Text blocks below are copied character for character, including indentation and blank lines. Keep it that way.',
  'Operations: create writes the whole file (replacing it if it exists); replace swaps ANCHOR for TEXT; replace-range swaps everything from ANCHOR up to END ANCHOR (not included) for TEXT; insert-after / insert-before put TEXT next to ANCHOR; append adds TEXT at the end of the file; delete removes ANCHOR.',
].join('\n');
const DONE = 'Your last message must be `DONE` followed by one line per step (`1 ok`, `2 ok`, ...). Nothing else.';
const rulesBlock = (rules: string): string[] => rules ? ['RULES (hard limits):', rules] : [];

export function orderPrompt(order: WorkOrder, rules: string): string {
  const blocks = order.steps.map((step) => [
    `STEP ${step.n}: ${step.do} in ${step.file}`,
    ...(step.note ? [`NOTE: ${step.note}`] : []),
    ...(step.anchor !== undefined ? [step.do === 'replace-range' ? 'ANCHOR (must occur exactly once in the file; the replaced range starts here):' : 'ANCHOR (must occur exactly once in the file):', '<<<ANCHOR', step.anchor, 'ANCHOR>>>'] : []),
    ...(step.endAnchor !== undefined ? ['END ANCHOR (first occurrence AFTER the anchor; everything from the start of ANCHOR up to, but NOT including, END ANCHOR is replaced by TEXT):', '<<<ENDANCHOR', step.endAnchor, 'ENDANCHOR>>>'] : []),
    ...(step.text !== undefined ? ['TEXT:', '<<<TEXT', step.text, 'TEXT>>>'] : []),
  ].join('\n'));
  return [HEADER, '', `ORDER: ${order.title}`, ...rulesBlock(rules), '', blocks.join('\n\n'), '',
    `FORBIDDEN PATHS: ${order.forbiddenPaths.join(', ') || 'none'}`,
    `DONE WHEN: ${order.doneWhen || 'all steps are applied'}`, DONE].join('\n');
}

export function fixPrompt(error: string, files: string[], rules: string): string {
  return [HEADER, 'A check failed after your edit. Fix ONLY what this error says. Change nothing else.',
    'ERROR:', error.slice(0, 3000), `FILES YOU MAY CHANGE: ${files.join(', ')}`, ...rulesBlock(rules), DONE].join('\n');
}

const normalize = (text: string): string => text.replace(/\r\n/g, '\n');

export function simulateOrder(order: WorkOrder, root: string): { files: Map<string, string>; problems: string[] } {
  const files = new Map<string, string>();
  const loaded = new Set<string>();
  const problems: string[] = [];
  for (const step of order.steps) {
    const { file } = step;
    if (!loaded.has(file)) {
      loaded.add(file);
      try { files.set(file, normalize(readFileSync(join(root, file), 'utf8'))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const content = files.get(file);
    const text = normalize(step.text ?? '');
    const anchor = normalize(step.anchor ?? '');
    const endAnchor = normalize(step.endAnchor ?? '');
    if (step.do === 'create') { files.set(file, text); continue; }
    if (content === undefined) {
      problems.push(`step ${step.n}: ${file} does not exist${step.do === 'append' ? ' (use create)' : ''}`);
      continue;
    }
    if (step.do === 'append') { files.set(file, content + text); continue; }
    let count = 0;
    if (anchor.length) {
      for (let at = content.indexOf(anchor); at !== -1; at = content.indexOf(anchor, at + 1)) count++;
    }
    if (count !== 1) {
      problems.push(`step ${step.n}: anchor occurs ${count} times in ${file} (needs exactly 1)`);
      continue;
    }
    const i = content.indexOf(anchor);
    const before = content.slice(0, i);
    const after = content.slice(i + anchor.length);
    switch (step.do) {
      case 'replace': files.set(file, before + text + after); break;
      case 'insert-after': files.set(file, before + anchor + text + after); break;
      case 'insert-before': files.set(file, before + text + anchor + after); break;
      case 'delete': files.set(file, before + after); break;
      case 'replace-range': {
        const j = content.indexOf(endAnchor, i + anchor.length);
        if (j === -1) problems.push(`step ${step.n}: end anchor not found after the anchor in ${file}`);
        else files.set(file, before + text + content.slice(j));
        break;
      }
    }
  }
  for (const required of order.mustContain) {
    const text = normalize(required);
    if (![...files.values()].some((content) => content.includes(text))) problems.push(`missing required text: ${text.slice(0, 80)}`);
  }
  return { files, problems };
}

export function preflightOrder(order: WorkOrder, root: string): string[] {
  return simulateOrder(order, root).problems;
}

export function compareFiles(expected: Map<string, string>, root: string): string[] {
  const problems: string[] = [];
  for (const [file, want] of expected) {
    let found: string;
    try { found = normalize(readFileSync(join(root, file), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      problems.push(`${file}: expected file is missing`);
      continue;
    }
    if (found === want) continue;
    const wantedLines = want.split('\n');
    const foundLines = found.split('\n');
    let line = 0;
    while (wantedLines[line] === foundLines[line]) line++;
    problems.push(`${file}: differs from the order's expected result at line ${line + 1}: expected "${(wantedLines[line] ?? '<end of file>').slice(0, 80)}" but found "${(foundLines[line] ?? '<end of file>').slice(0, 80)}"`);
  }
  return problems;
}

export function applyCheck(order: WorkOrder, root: string): string[] {
  const problems: string[] = [];
  const contents = new Map<string, string>();
  for (const file of new Set(order.steps.map((step) => step.file))) {
    try { contents.set(file, normalize(readFileSync(join(root, file), 'utf8'))); }
    catch { /* Missing or unreadable files fail the step checks below. */ }
  }
  for (const step of order.steps) {
    const content = contents.get(step.file);
    const text = normalize(step.text ?? '');
    const anchor = normalize(step.anchor ?? '');
    if (step.do !== 'delete' && (content === undefined || (text.trim() && !content.includes(text.trim())))) problems.push(`step ${step.n}: the text is not in ${step.file}`);
    if (['replace', 'replace-range'].includes(step.do) && content?.includes(anchor) && !text.includes(anchor)) problems.push(`step ${step.n}: the old text is still in ${step.file}`);
    if (step.do === 'delete' && content?.includes(anchor)) problems.push(`step ${step.n}: the old text is still in ${step.file}`);
  }
  const all = [...contents.values()].join('\n');
  for (const required of order.mustContain) {
    if (!all.includes(normalize(required))) problems.push(`missing required text: ${required.slice(0, 80)}`);
  }
  return problems;
}

export function verbatimCheck(order: WorkOrder, added: string): string[] {
  const normalized = normalize(added);
  return order.mustContain.filter((text) => !normalized.includes(normalize(text))).map((text) => `missing in diff: ${text.slice(0, 80)}`);
}
