import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fixerHybridText, git, LimitError, type Ctx } from '../src/agents/agents.ts';
import { resetCodexAuthCache } from '../src/agents/runner.ts';
import { simulateOrder, type WorkOrder } from '../src/agents/orders.ts';
import { approvalCard, agentsPage } from '../src/agents/page.ts';
import { openDb } from '../src/db.ts';

const scout = 'FINDING 1\nFILE: a.txt\nLINES: 1-1\nEXCERPT:\n1: x\nWHY: test';
function fixture(t: TestContext, scoutFailure = '') {
  const root = mkdtempSync(join(tmpdir(), 'wd-hybrid-fixer-'));
  const path = process.env.PATH, mode = process.env.AGENT_EXECUTOR;
  t.after(() => {
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
    if (mode === undefined) delete process.env.AGENT_EXECUTOR; else process.env.AGENT_EXECUTOR = mode;
    resetCodexAuthCache();
    rmSync(root, { recursive: true, force: true });
  });
  const bin = join(root, 'bin'), wt = join(root, 'wt');
  mkdirSync(bin); mkdirSync(wt);
  writeFileSync(join(bin, 'codex'), `#!/bin/sh
if [ "$1" = login ] && [ "$2" = status ]; then
  echo 'Logged in using ChatGPT'
  exit 0
fi
[ "$1" = exec ] || exit 1
cat >/dev/null
${scoutFailure ? `echo '${scoutFailure}' >&2\nexit 1` : `while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then shift; printf '%s\\n' '${scout}' > "$1"; exit 0; fi
  shift
done
exit 1`}
`, { mode: 0o755 });
  process.env.PATH = `${bin}:${path}`;
  delete process.env.AGENT_EXECUTOR;
  resetCodexAuthCache();
  git(wt, 'init', '-q');
  git(wt, 'config', 'user.email', 't@t'); git(wt, 'config', 'user.name', 't');
  writeFileSync(join(wt, 'a.txt'), 'x\n');
  git(wt, 'add', '.'); git(wt, 'commit', '-qm', 'init');
  const cfg: any = { repo: wt, worktree: wt, rules: '', typecheck: ['true'] };
  const db = openDb(':memory:');
  t.after(() => db.close());
  const c: Ctx = { db, site: { url: 'https://x.test' } as Ctx['site'], cfg, usage: [], log: () => {} };
  const o = { cfg, wt, list: [{ id: 1, rule_id: 'title', severity: 'warn', subject: '/a', message: 'test' }], picked: true };
  const order: WorkOrder & { meta?: { fixed: number[] } } = { title: 'Fix finding', meta: { fixed: [1] }, steps: [{ n: 1, file: 'a.txt', do: 'replace', anchor: 'x', text: 'y' }], mustContain: [], forbiddenPaths: [], doneWhen: 'fixed' };
  const apply = (order: WorkOrder) => {
    const result = simulateOrder(order, wt);
    assert.deepEqual(result.problems, []);
    for (const [file, text] of result.files) { mkdirSync(dirname(join(wt, file)), { recursive: true }); writeFileSync(join(wt, file), text); }
    return { ok: true, limited: false, blocked: false, text: 'DONE' };
  };
  const override = { plan: async (_p: string) => JSON.stringify(order), execute: async () => apply(order), revise: async (_p: string): Promise<string> => { throw new Error('unexpected revision'); }, review: async () => ({ ok: true, problems: [] }) };
  return { c, o, order, apply, override };
}

test('hybrid fixer returns fixed metadata, changes the file, and gives the scout to the planner', async (t) => {
  const { c, o, order, override } = fixture(t);
  let prompt = '';
  const text = await fixerHybridText(c, o, { ...override, plan: async (p) => { prompt = p; return JSON.stringify(order); } });
  assert.deepEqual(JSON.parse(text), { fixed: [1], skipped: [] });
  assert.equal(readFileSync(join(o.wt, 'a.txt'), 'utf8'), 'y\n');
  assert.ok(prompt.includes(scout));
});

test('forbidden API edit reaches verify, exhausts rounds, and resets the worktree', async (t) => {
  const { c, o, order, apply, override } = fixture(t);
  order.steps = [{ n: 1, file: 'src/app/api/x.ts', do: 'create', text: 'export const x = 1;\n' }];
  let executions = 0, revisions = 0;
  await assert.rejects(fixerHybridText(c, o, { ...override,
    execute: async () => { executions++; return apply(order); },
    revise: async (p) => { revisions++; assert.match(p, /forbidden files were changed, revert them: src\/app\/api\/x.ts/); return JSON.stringify(order); },
    review: async () => { assert.fail('forbidden edits must never reach review'); },
  }), /not approved after 3 rounds: check: forbidden files were changed/);
  assert.equal(executions, 3); assert.equal(revisions, 2);
  assert.equal(git(o.wt, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(o.wt, 'a.txt'), 'utf8'), 'x\n');
});

test('scout usage limit becomes LimitError before planning', async (t) => {
  const { c, o, override } = fixture(t, 'codex usage limit');
  await assert.rejects(fixerHybridText(c, o, { ...override, plan: async () => { assert.fail('planner must not run'); } }), LimitError);
});

test('failed scout supplies the fallback and missing metadata yields empty arrays', async (t) => {
  const { c, o, order, override } = fixture(t, 'scout failed');
  delete order.meta;
  const text = await fixerHybridText(c, o, { ...override, plan: async (p) => {
    assert.match(p, /the scout found nothing; skip findings you cannot place with certainty/);
    return JSON.stringify(order);
  } });
  assert.deepEqual(JSON.parse(text), { fixed: [], skipped: [] });
});

test('approval card renders escaped hybrid analysis and notes only for hybrid payloads', () => {
  const card = (payload: unknown) => approvalCard({ id: 1, kind: 'fix', title: 'Fix', created_at: null, diff: '', payload_json: JSON.stringify(payload) }).__html;
  const html = card({ files: ['a.txt'], hybrid: { plans: 1, executions: 1, reviews: 1, rounds: 0, analysis: 'Analysis <script>', reviewNotes: ['Review <b>'] } });
  assert.match(html, /Built in hybrid mode: 1 plan, 1 Codex run\(s\), 1 review\(s\), 0 extra round\(s\)\./);
  assert.match(html, /<p>Analysis &lt;script&gt;<\/p>/);
  assert.match(html, /<li>Review &lt;b&gt;<\/li>/);
  assert.ok(html.indexOf('Files:') < html.indexOf('Built in hybrid mode'));
  assert.doesNotMatch(card({ files: [] }), /Built in hybrid mode|Claude's analysis and review/);
  assert.doesNotMatch(card({ hybrid: { analysis: '', reviewNotes: [] } }), /<p><\/p>|<ul>/);
});

test('dashboard displays both executor modes', (t) => {
  const { c } = fixture(t);
  assert.match(agentsPage(c.db), /Executor: hybrid \(Claude plans and reviews, Codex builds\)/);
  process.env.AGENT_EXECUTOR = 'claude';
  assert.match(agentsPage(c.db), /Executor: Claude only \(Codex is not available, or AGENT_EXECUTOR=claude\)/);
});
