import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintDetails, draftTopicHybrid, researchFor, researchPlanOptions, factsOf, guidesOf, startDraft, git, LimitError, type Ctx } from '../src/agents/agents.ts';
import { simulateOrder, type WorkOrder } from '../src/agents/orders.ts';
import { openDb } from '../src/db.ts';

const factText = 'Authorized price: 1200 MXN.\nContact: ventas@example.test.';
const publishAt = '2026-11-02';
const lastPost = '  {\n    slug: "second",\n    title: "Second post",\n  },\n';
const newPost = '  {\n    slug: "new-post",\n    title: "New hybrid post",\n  },\n';

function fixture(t: TestContext) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = '';
  t.after(() => {
    if (token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = token;
  });
  const root = mkdtempSync(join(tmpdir(), 'wd-hybrid-draft-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
  git(root, 'clone', '-q', 'remote.git', 'owner');
  const owner = join(root, 'owner');
  git(owner, 'config', 'user.email', 't@t');
  git(owner, 'config', 'user.name', 't');
  writeFileSync(join(owner, 'blog.ts'), 'export const posts = [\n  {\n    slug: "first",\n    title: "First post",\n  },\n' + lastPost + '];\n');
  writeFileSync(join(owner, 'facts.txt'), factText);
  mkdirSync(join(owner, 'src/lib'), { recursive: true });
  writeFileSync(join(owner, 'src/lib/i18n.ts'), 'export const EN_SLUG_MAP = {};\n');
  git(owner, 'add', '.');
  git(owner, 'commit', '-qm', 'init');
  git(owner, 'push', '-q', 'origin', 'main');
  const cfg: any = {
    repo: owner, worktree: join(root, 'wt'), remote: 'origin', typecheck: ['true'],
    factFiles: ['facts.txt'],
    contentPaths: ['blog.ts'], orderPaths: ['blog.ts'], rules: '', writerRules: '',
    postBrief: () => 'Write a short new post.',
    listPosts: (wt: string) => [...readFileSync(join(wt, 'blog.ts'), 'utf8').matchAll(/slug: "([^"]+)"/g)].map((m) => ({ slug: m[1] })),
    postFiles: () => ['blog.ts'], blogUrl: (s: string) => [`https://x.test/blog/${s}`],
  };
  const db = openDb(join(root, 'test.db'));
  t.after(() => db.close());
  db.prepare("INSERT INTO sites (id, url) VALUES (1, 'https://x.test')").run();
  db.prepare("INSERT INTO topics (id, site_id, title, slug, query, action, why, score) VALUES (1, 1, 'New hybrid post', 'new-post', 'new post', 'new', 'test', 5)").run();
  const site = db.prepare('SELECT * FROM sites WHERE id = 1').get() as Ctx['site'];
  const c: Ctx = { db, site, cfg, usage: [], log: () => {} };
  const topic = { id: 1, title: 'New hybrid post', slug: 'new-post', query: 'new post', action: 'new', why: 'test' };
  const s = startDraft(c, topic, publishAt);
  const order: WorkOrder & { meta: { slug: string } } = {
    title: 'Insert post', analysis: 'Add the requested post.', meta: { slug: topic.slug },
    steps: [{ n: 1, file: 'blog.ts', do: 'insert-after', anchor: lastPost, text: newPost }],
    mustContain: ['New hybrid post'], forbiddenPaths: [], doneWhen: 'The post is inserted.',
  };
  const apply = (o: WorkOrder) => {
    const result = simulateOrder(o, s.wt);
    assert.deepEqual(result.problems, []);
    for (const [file, text] of result.files) writeFileSync(join(s.wt, file), text);
    return { ok: true, limited: false, blocked: false, text: 'DONE' };
  };
  const planPrompts: string[] = [];
  const override = {
    plan: async (prompt: string) => { planPrompts.push(prompt); return JSON.stringify(order); },
    revise: async () => { throw new Error('unexpected revision'); },
    execute: async () => apply(order),
    review: async () => ({ ok: true, problems: [] }),
    verify: () => null,
  };
  return { c, topic, s, order, apply, override, planPrompts };
}

test('hybrid draft commits the post and creates a pending approval', async (t) => {
  const { c, topic, s, override, planPrompts } = fixture(t);
  const out = await draftTopicHybrid(c, topic, publishAt, s, override);
  assert.match(out, /hybrid:/);
  assert.equal(planPrompts.length, 1);
  assert.ok(planPrompts[0].includes('DATOS AUTORIZADOS DEL REPO'));
  assert.ok(planPrompts[0].includes('=== facts.txt ==='));
  assert.ok(planPrompts[0].includes(factText));
  const rows = c.db.prepare('SELECT kind, status, payload_json FROM approvals').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'post');
  assert.equal(rows[0].status, 'pending');
  const payload = JSON.parse(rows[0].payload_json as string);
  assert.equal(payload.hybrid.plans, 1);
  assert.deepEqual(payload.files, ['blog.ts']);
  assert.equal(c.db.prepare('SELECT status FROM topics WHERE id = 1').get()!.status, 'drafted');
  assert.ok(git(s.wt, 'show', `${s.branch}:blog.ts`).includes(newPost));
  assert.equal(git(s.wt, 'rev-list', '--count', `origin/main..${s.branch}`).trim(), '1');
});

test('hybrid usage limit becomes LimitError and cleans the worktree', async (t) => {
  const { c, topic, s, order, apply, override } = fixture(t);
  await assert.rejects(draftTopicHybrid(c, topic, publishAt, s, {
    ...override,
    execute: async () => {
      apply(order);
      writeFileSync(join(s.wt, 'unfinished.txt'), 'partial output');
      return { ok: false, limited: true, blocked: false, text: '', error: 'usage limit' };
    },
  }), LimitError);
  assert.equal(git(s.wt, 'status', '--porcelain'), '');
});

test('hybrid repeated review rejection stops after three rounds without approval', async (t) => {
  const { c, topic, s, order, apply, override } = fixture(t);
  let current = order;
  let reviews = 0;
  let revisions = 0;
  await assert.rejects(draftTopicHybrid(c, topic, publishAt, s, {
    ...override,
    execute: async () => apply(current),
    review: async () => { reviews++; return { ok: false, problems: ['Needs more detail'] }; },
    revise: async () => {
      revisions++;
      current = { ...order, steps: [{ n: 1, file: 'blog.ts', do: 'insert-before', anchor: '];', text: `  // Revision ${revisions}\n` }] };
      return JSON.stringify(current);
    },
  }), /not approved after 3 rounds/);
  assert.equal(reviews, 3);
  assert.equal(revisions, 2);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM approvals').get()!.n, 0);
  assert.equal(git(s.wt, 'status', '--porcelain'), '');
});

test('factsOf normalizes newlines, caps text and skips missing files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wd-facts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'facts.txt'), 'uno\r\ndos');
  const cfg = { factFiles: ['missing.txt', 'facts.txt'] } as import('../src/agents/sites.ts').AgentSite;
  assert.deepEqual(factsOf(cfg, root, 5), [{ file: 'facts.txt', text: 'uno\nd\n[cut]' }]);
  assert.deepEqual(factsOf(cfg, root, 7), [{ file: 'facts.txt', text: 'uno\ndos' }]);
  assert.deepEqual(factsOf(cfg, root), [{ file: 'facts.txt', text: 'uno\ndos' }]);
  assert.deepEqual(factsOf({ ...cfg, factFiles: undefined }, root), []);
});


test('lintDetails reports added copy with locations, context, and a limit', () => {
  const line = 'a'.repeat(60) + '—' + 'b'.repeat(60);
  const chunk = (file: string, lines: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${lines}\n`;
  const diff = chunk('copy.txt', `+${line}\n+El mejor del mundo`) + chunk('other.txt', '+certificado ISO');
  assert.deepEqual(lintDetails(diff, ['copy.txt']), [
    `copy.txt: em-dash in new copy: "…${'a'.repeat(45)}—${'b'.repeat(44)}…"`,
    'copy.txt: unverifiable superlative or certification claim: "El mejor del mundo"',
  ]);
  assert.deepEqual(lintDetails(diff, ['other.txt']), ['other.txt: unverifiable superlative or certification claim: "certificado ISO"']);
  assert.deepEqual(lintDetails(chunk('copy.txt', '+clean copy')), []);
  assert.equal(lintDetails(chunk('copy.txt', Array(10).fill('+bad — copy').join('\n'))).length, 8);
});

 test('guidesOf reads the owner repo, normalizes and caps guides, and skips missing files', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'guides-repo-'));
  const worktree = mkdtempSync(join(tmpdir(), 'guides-wt-'));
  t.after(() => { rmSync(repo, { recursive: true, force: true }); rmSync(worktree, { recursive: true, force: true }); });
  writeFileSync(join(repo, 'CLAUDE.md'), 'uno\r\ndos');
  writeFileSync(join(worktree, 'CLAUDE.md'), 'wrong');
  const cfg = { repo, worktree, guideFiles: ['CLAUDE.md', 'missing'] } as Parameters<typeof guidesOf>[0];
  assert.deepEqual(guidesOf(cfg, 5), [{ file: 'CLAUDE.md', text: 'uno\nd\n[cut]' }]);
  assert.deepEqual(guidesOf(cfg, 7), [{ file: 'CLAUDE.md', text: 'uno\ndos' }]);
  assert.deepEqual(guidesOf({ ...cfg, guideFiles: undefined }), []);
});


test('research is cached by site, slug and date; failures restore planner web tools', async (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const logs: string[] = [];
  const c = { db, site: { id: 7, url: 'https://example.test' }, log: (s: string) => logs.push(s), usage: [] } as unknown as Ctx;
  const topic = { id: 1, title: 'Topic', slug: 'topic', query: 'query', why: '', action: 'new' };
  let calls = 0;
  const stub: typeof import('../src/agents/agents.ts').ask = async (_c, o) => {
    calls++;
    assert.equal(o.role, 'research');
    assert.deepEqual(o.tools, ['WebSearch', 'WebFetch']);
    assert.equal(o.maxTurns, 6);
    return 'research result';
  };
  assert.equal(await researchFor(c, topic, 'brief', stub), 'research result');
  assert.equal(await researchFor(c, topic, 'brief', stub), 'research result');
  assert.equal(calls, 1);
  assert.deepEqual(researchPlanOptions('research result'), { tools: [], maxTurns: 3 });
  const failed = await researchFor(c, { ...topic, slug: 'other' }, 'brief', async () => { throw new Error('offline'); });
  assert.equal(failed, '');
  assert.match(logs[0], /offline/);
  assert.deepEqual(researchPlanOptions(failed), { tools: ['WebSearch', 'WebFetch'], maxTurns: 20 });
  await assert.rejects(researchFor(c, { ...topic, slug: 'limit' }, 'brief', async () => { throw new LimitError('limit'); }), LimitError);
});
