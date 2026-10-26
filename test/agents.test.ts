// The agent fleet's guard rails: subscription-only env, schedule math, publish-day math, content lint, drop alert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WATCHDOG_DATA = mkdtempSync(join(tmpdir(), 'wd-agents-'));
const { cleanEnv, extractJson } = await import('../src/agents/runner.ts');
const { isDue, SCHEDULE } = await import('../src/agents/scheduler.ts');
const { nextPublishDate, lintAdded, dropAlert, FORBIDDEN, weeklySummary } = await import('../src/agents/agents.ts');
const { openDb } = await import('../src/db.ts');

test('agent env never carries API credentials, even when the parent has them', () => {
  const env = cleanEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_AUTH_TOKEN: 't', SERPER_API_KEY: 's', CLAUDE_CODE_OAUTH_TOKEN: 'o', TELEGRAM_BOT_TOKEN: 'b' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
});

test('extractJson reads fenced and bare replies', () => {
  assert.deepEqual(extractJson('Aquí:\n```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(extractJson('{"slug":"x"} fin'), { slug: 'x' });
  assert.throws(() => extractJson('sin json'));
});

test('slots: not before the time, once when done, retried after 30 min, abandoned after 2 failures, expired after 10 h', () => {
  const e = { days: [1], at: '06:30' }, none = { ok: false, failed: 0, lastAtMs: null }, t = 1_000_000_000_000;
  assert.equal(isDue(e, { hm: '06:29', dow: 1 }, none, t), false);
  assert.equal(isDue(e, { hm: '06:30', dow: 1 }, none, t), true);
  assert.equal(isDue(e, { hm: '07:00', dow: 2 }, none, t), false);
  assert.equal(isDue(e, { hm: '07:00', dow: 1 }, { ...none, ok: true }, t), false);
  assert.equal(isDue(e, { hm: '07:00', dow: 1 }, { ok: false, failed: 1, lastAtMs: t - 10 * 60_000 }, t), false);
  assert.equal(isDue(e, { hm: '07:00', dow: 1 }, { ok: false, failed: 1, lastAtMs: t - 31 * 60_000 }, t), true);
  assert.equal(isDue(e, { hm: '07:00', dow: 1 }, { ok: false, failed: 2, lastAtMs: t - 99 * 60_000 }, t), false);
  assert.equal(isDue(e, { hm: '16:31', dow: 1 }, none, t), false);
});

test('writer drafts Sunday and Tuesday night for Monday and Wednesday', () => {
  const w = SCHEDULE.find((s) => s.agent === 'writer')!;
  assert.deepEqual(w.days, [0, 2]);
  assert.equal(nextPublishDate('2026-10-25'), '2026-10-26'); // Sunday -> Monday
  assert.equal(nextPublishDate('2026-10-27'), '2026-10-28'); // Tuesday -> Wednesday
  assert.equal(nextPublishDate('2026-10-28'), '2026-11-02'); // Wednesday -> next Monday
});

test('content lint only judges ADDED lines', () => {
  const diff = ['--- a/x', '+++ b/x', '-viejo — con guion', ' contexto — viejo', '+nuevo limpio'].join('\n');
  assert.deepEqual(lintAdded(diff), []);
  assert.deepEqual(lintAdded('+++ b/x\n+texto — con guion largo'), ['em-dash in new copy']);
  assert.equal(lintAdded('+producto certificado ISO').length, 1);
});

test('payments, checkout, email, env and deploy config are never agent-editable', () => {
  for (const f of ['src/app/(es)/checkout/page.tsx', 'src/lib/mercadopago.ts', 'src/app/api/webhook/route.ts', 'vercel.json', '.env.local', 'src/emails/order.tsx', 'package.json', 'next.config.ts'])
    assert.ok(FORBIDDEN.test(f), f);
  for (const f of ['src/content/blog.ts', 'src/content/blog.en.ts']) assert.ok(!FORBIDDEN.test(f), f);
});

test('drop alert needs real volume and a real drop', () => {
  const s = (c1: number, i1: number, c0: number, i0: number) => ({ totals: { now: { c: c1, i: i1, p: 0 }, before: { c: c0, i: i0, p: 0 } } }) as any;
  assert.equal(dropAlert(s(2, 100, 3, 150)), null);          // tiny numbers: noise
  assert.match(dropAlert(s(5, 400, 20, 500))!, /clicks 20 -> 5/);
  assert.match(dropAlert(s(30, 100, 30, 400))!, /impressions 400 -> 100/);
  assert.equal(dropAlert(s(30, 390, 30, 400)), null);
});

test('weeklySummary works on an empty database and reads metrics when present', () => {
  const db = openDb(join(process.env.WATCHDOG_DATA!, 'a.db'));
  db.prepare("INSERT INTO sites (id, url) VALUES (1, 'https://x.mx/')").run();
  assert.equal(weeklySummary(db, 1).totals.now.i, 0);
  const d = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const put = db.prepare("INSERT INTO metrics VALUES (1, 'gsc', ?, ?, ?, ?, ?, ?)");
  put.run(d(3), 'etiquetas', 'https://x.mx/a', 2, 50, 12); put.run(d(10), 'etiquetas', 'https://x.mx/a', 1, 20, 14);
  const s = weeklySummary(db, 1);
  assert.equal(s.totals.now.i, 50); assert.equal(s.totals.before.i, 20);
  assert.equal(s.strikingDistance[0].query, 'etiquetas');
  assert.equal(s.queries.up[0].impressions, '20 -> 50');
});

test('worktree + publish plumbing on a throwaway repo: draft stays off main until push; conflicts abort cleanly; owner checkout untouched', async () => {
  const { execFileSync: x } = await import('node:child_process');
  const { writeFileSync, readFileSync } = await import('node:fs');
  const { prepareWorktree, pushAndVerify } = await import('../src/agents/agents.ts');
  const root = mkdtempSync(join(tmpdir(), 'wd-git-')), g = (cwd: string, ...a: string[]) => x('git', a, { cwd, encoding: 'utf8' });
  g(root, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
  g(root, 'clone', '-q', 'remote.git', 'owner'); const owner = join(root, 'owner');
  g(owner, 'config', 'user.email', 't@t'); g(owner, 'config', 'user.name', 't'); g(owner, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(owner, 'blog.ts'), 'one\n'); g(owner, 'add', '.'); g(owner, 'commit', '-qm', 'init'); g(owner, 'push', '-q', 'origin', 'main');
  const cfg: any = { repo: owner, worktree: join(root, 'wt'), remote: 'origin', typecheck: ['true'] };
  const wt = prepareWorktree(cfg, 'agent/post-x');
  g(wt, 'config', 'user.email', 't@t'); g(wt, 'config', 'user.name', 't');
  writeFileSync(join(wt, 'blog.ts'), 'one\ntwo\n'); g(wt, 'add', '-A'); g(wt, 'commit', '-qm', 'draft');
  assert.equal(g(owner, 'ls-remote', 'origin', 'main').split('\t')[0], g(owner, 'rev-parse', 'HEAD').trim(), 'draft is not on main yet');
  pushAndVerify(cfg, []);
  assert.equal(g(root, '--git-dir=remote.git', 'show', 'main:blog.ts'), 'one\ntwo\n');
  assert.equal(readFileSync(join(owner, 'blog.ts'), 'utf8'), 'one\n', "owner's checkout is never edited");
  // conflict: owner changes the same line on main, agent branch edits it too
  const wt2 = prepareWorktree(cfg, 'agent/post-y'); g(wt2, 'config', 'user.email', 't@t'); g(wt2, 'config', 'user.name', 't');
  writeFileSync(join(wt2, 'blog.ts'), 'one\nAGENT\n'); g(wt2, 'add', '-A'); g(wt2, 'commit', '-qm', 'agent');
  g(owner, 'pull', '-q', 'origin', 'main'); writeFileSync(join(owner, 'blog.ts'), 'one\nOWNER\n'); g(owner, 'commit', '-qam', 'owner'); g(owner, 'push', '-q', 'origin', 'main');
  assert.throws(() => pushAndVerify(cfg, []), /rebase conflict/);
  assert.equal(g(root, '--git-dir=remote.git', 'show', 'main:blog.ts'), 'one\nOWNER\n', 'main untouched by the failed publish');
  assert.equal(g(wt2, 'status', '--porcelain'), '', 'rebase aborted, worktree clean');
});

test('blog score: thin post with no FAQ scores low with plain reasons; a complete post scores high', async () => {
  const { scorePost } = await import('../src/agents/blogscore.ts');
  const link = (n: number) => Array.from({ length: n }, (_, i) => `https://x.mx/blog/p${i}`);
  const thin = scorePost({ title: 'Corto', meta_description: 'x', h1: ['a'], word_count: 380, faq_questions: [], jsonld_types: ['BlogPosting'], links: link(2) }, { impressions: 0, clicks: 0, position: 0 }, 'x.mx');
  assert.ok(thin.score < 35, String(thin.score));
  assert.ok(thin.reasons.some((r) => /380 palabras/.test(r)) && thin.reasons.includes('sin FAQ visible') && thin.reasons.includes('sin clics en 90 días'));
  const good = scorePost({ title: 'Un título de longitud adecuada para buscadores', meta_description: 'd'.repeat(140), h1: ['a'], word_count: 1600, faq_questions: ['q'], jsonld_types: ['BlogPosting'], links: link(10) }, { impressions: 80, clicks: 4, position: 6 }, 'x.mx');
  assert.equal(good.score, 100); assert.deepEqual(good.reasons, []);
  assert.equal(scorePost({ title: 'Un título de longitud adecuada para buscadores', meta_description: 'd'.repeat(140), h1: ['a'], word_count: 1600, faq_questions: ['q'], jsonld_types: ['BlogPosting'], links: link(10) }, null, 'x.mx').score, 100, 'without Search Console the structure score is scaled to 100');
});
