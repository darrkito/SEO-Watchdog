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

test('audience segments: planners and individuals are targets; bulk wins over generic event words', async () => {
  const { segmentOf, TARGET } = await import('../src/agents/audience.ts');
  assert.equal(segmentOf('proveedores para wedding planner guadalajara'), 'planner');
  assert.equal(segmentOf('souvenirs de boda personalizados'), 'event');
  assert.equal(segmentOf('regalo sorpresa para mi mamá'), 'event');
  assert.equal(segmentOf('detalles de posada para empresa'), 'corporate-event');
  assert.equal(segmentOf('etiquetas para producto shampoo por mayoreo'), 'bulk');
  assert.equal(segmentOf('stickers vinil impermeable'), 'labels');
  for (const t of ['event', 'planner', 'corporate-event'] as const) assert.ok(TARGET.has(t));
  assert.ok(!TARGET.has('bulk') && !TARGET.has('labels'));
});

test('Fix now: needs a configured site and at least one open issue; "all" ignores info notes', async () => {
  const { queueFix } = await import('../src/agents/page.ts');
  const db = openDb(join(process.env.WATCHDOG_DATA!, 'fix.db'));
  db.prepare("INSERT INTO sites (id, url) VALUES (7, 'https://other.example/'), (8, 'https://studioyume.mx/')").run();
  assert.throws(() => queueFix(db, 7, 'all'), /not enabled/);
  assert.throws(() => queueFix(db, 8, 'all'), /nothing to fix/);
  assert.throws(() => queueFix(db, 8, []), /Select at least one/);
  db.prepare("INSERT INTO findings (site_id, rule_id, subject, severity, message) VALUES (8, 'r', 'u', 'info', 'm')").run();
  assert.throws(() => queueFix(db, 8, 'all'), /nothing to fix/, 'info notes are not "issues to fix"');
});

test('paths: exact entries and trailing-* prefixes', async () => {
  const { pathAllowed } = await import('../src/agents/sites.ts');
  const paths = ['src/data/blog-posts.ts', 'src/content/blog/*', 'public/og/blog-*'];
  assert.ok(pathAllowed(paths, 'src/data/blog-posts.ts') && pathAllowed(paths, 'src/content/blog/nuevo.mdx') && pathAllowed(paths, 'public/og/blog-nuevo.jpg'));
  assert.ok(!pathAllowed(paths, 'src/data/blog-posts.ts.bak') && !pathAllowed(paths, 'src/pages/index.astro') && !pathAllowed(paths, 'public/og/default.jpg'));
});

test('Write now dates: skips Mon/Wed already used by a draft or a published post', async () => {
  const { nextFreeDate } = await import('../src/agents/agents.ts');
  const db = openDb(join(process.env.WATCHDOG_DATA!, 'slots.db'));
  db.prepare("INSERT INTO sites (id, url) VALUES (9, 'https://z.example/')").run();
  const put = db.prepare("INSERT INTO approvals (site_id, agent, kind, title, payload_json, diff, status) VALUES (9, 'writer', 'post', 't', ?, '', ?)");
  assert.equal(nextFreeDate(db, 9, '2026-10-25'), '2026-10-26');
  put.run(JSON.stringify({ publishAt: '2026-10-26' }), 'pending');
  put.run(JSON.stringify({ publishAt: '2026-10-28' }), 'published');
  put.run(JSON.stringify({ publishAt: '2026-11-02' }), 'rejected'); // a rejected draft frees its day
  assert.equal(nextFreeDate(db, 9, '2026-10-25'), '2026-11-02');
});

test('Write now: refuses sites without a writer, unknown topics and topics already drafted', async () => {
  const { agentsPost } = await import('../src/agents/page.ts');
  const db = openDb(join(process.env.WATCHDOG_DATA!, 'wn.db'));
  db.prepare("INSERT INTO sites (id, url, kind) VALUES (21, 'https://other.example/', 'own'), (22, 'https://luvory.com.mx/', 'own')").run();
  db.prepare("INSERT INTO topics (id, site_id, title, slug, status) VALUES (1, 21, 'a', 'a', 'new'), (2, 22, 'b', 'b', 'drafted')").run();
  const form = (site: number, topic: number) => new URLSearchParams({ site: String(site), topic: String(topic) });
  assert.throws(() => agentsPost(db, 'write-topic', form(21, 1)), /writer is not enabled/); // a site the fleet does not run
  assert.throws(() => agentsPost(db, 'write-topic', form(22, 99)), /not in this site/);
  assert.throws(() => agentsPost(db, 'write-topic', form(22, 2)), /already drafted/);
  assert.throws(() => agentsPost(db, 'write-topic', form(22, 1)), /not in this site/, 'a topic of another site cannot be written here');
});

test('Luvory / Vexon post lists are read from their own post formats', async () => {
  const { luvoryPosts, mdxPosts } = await import('../src/agents/sites.ts');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const lv = mkdtempSync(join(tmpdir(), 'wd-lv-')); mkdirSync(join(lv, 'src/data'), { recursive: true });
  writeFileSync(join(lv, 'src/data/blog-posts.ts'), `export const blogPosts = [\n  {\n    slug: "a-b",\n    title: "Titulo A: con dos puntos",\n    metaTitle: "Corto",\n    en: {\n      title: "English title",\n    },\n  },\n  {\n    slug: "c-d",\n    title: 'Otro "titulo"',\n  },\n];\n`);
  assert.deepEqual(luvoryPosts(lv), [{ slug: 'a-b', title: 'Titulo A: con dos puntos' }, { slug: 'c-d', title: 'Otro "titulo"' }]);
  const vx = mkdtempSync(join(tmpdir(), 'wd-vx-')); mkdirSync(join(vx, 'src/content/blog'), { recursive: true });
  writeFileSync(join(vx, 'src/content/blog/mi-post.mdx'), `---\ntitle: 'Cómo elegir (3 a 10 m)'\ndescription: 'x'\n---\ncuerpo\n`);
  assert.deepEqual(mdxPosts(vx), [{ slug: 'mi-post', title: 'Cómo elegir (3 a 10 m)' }]);
  assert.deepEqual(mdxPosts('/nonexistent'), []);
});

test('Luvory hooks: blog-index.json is regenerated from blog-posts.ts, and a new post must be wired into the map and the sitemap', async () => {
  const { luvoryPostEdit, luvoryValidate } = await import('../src/agents/hooks.ts');
  const { writeFileSync, mkdirSync, readFileSync } = await import('node:fs');
  const wt = mkdtempSync(join(tmpdir(), 'wd-lh-'));
  for (const d of ['src/data', 'src/lib', 'public']) mkdirSync(join(wt, d), { recursive: true });
  writeFileSync(join(wt, 'src/data/blog-posts.ts'), `export interface P { slug: string }\nexport const blogPosts = [\n  {\n    slug: "nuevo",\n    title: "T",\n    excerpt: "e",\n    date: "2026-11-02",\n    dateModified: "2026-11-02",\n    category: "Eventos",\n    content: \`## Hola\`,\n    en: {\n      title: "T en",\n      excerpt: "e en",\n      category: "Events",\n      content: \`## Hi\`,\n    },\n  },\n];\n`);
  luvoryPostEdit(wt);
  assert.deepEqual(JSON.parse(readFileSync(join(wt, 'src/data/blog-index.json'), 'utf8')), [{ slug: 'nuevo', title: 'T', excerpt: 'e', date: '2026-11-02', dateModified: '2026-11-02', category: 'Eventos', en: { title: 'T en', excerpt: 'e en', category: 'Events' } }]);
  const o = { slug: 'nuevo', improve: false, merge: null };
  assert.equal(luvoryValidate(wt, o).length, 2, 'no EN_SLUG_MAP entry and no sitemap entry yet (the sitemap file is missing)');
  writeFileSync(join(wt, 'src/lib/i18n.ts'), `const EN_SLUG_MAP = {\n  "/blog/nuevo": "/blog/new-post",\n};\n`);
  writeFileSync(join(wt, 'public/sitemap.xml'), `<loc>https://luvory.com.mx/blog/nuevo</loc><loc>https://luvory.com.mx/en/blog/new-post</loc>`);
  assert.deepEqual(luvoryValidate(wt, o), []);
  assert.deepEqual(luvoryValidate(wt, { slug: 'falta', improve: false, merge: null }), ['post falta is not in src/data/blog-posts.ts']);
});

test('Vexon hook: frontmatter limits from the playbook', async () => {
  const { vexonValidate } = await import('../src/agents/hooks.ts');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const wt = mkdtempSync(join(tmpdir(), 'wd-vh-')); mkdirSync(join(wt, 'src/content/blog'), { recursive: true });
  const post = (title: string, desc: string, faqs = true) => `---\ntitle: '${title}'\ndescription: '${desc}'\ndate: 2026-11-02\ncategory: 'Guías'\n${faqs ? "faqs:\n  - q: 'a'\n    a: 'b'\n" : ''}---\n\n## Hola\n`;
  writeFileSync(join(wt, 'src/content/blog/ok.mdx'), post('Cómo elegir el tamaño de tu oficina móvil', 'd'.repeat(120)));
  assert.deepEqual(vexonValidate(wt, { slug: 'ok', improve: false, merge: null }), []);
  writeFileSync(join(wt, 'src/content/blog/mal.mdx'), post('Corto', 'd'.repeat(30), false));
  assert.equal(vexonValidate(wt, { slug: 'mal', improve: false, merge: null }).length, 3);
  assert.match(vexonValidate(wt, { slug: 'no-existe', improve: false, merge: null })[0], /does not exist/);
});

test('markers and EN slugs work for markdown posts and for both slug-map styles', async () => {
  const { pickMarker, enSlugFor } = await import('../src/agents/agents.ts');
  const diff = ['diff --git a/src/data/blog-posts.ts b/src/data/blog-posts.ts', '+++ b/src/data/blog-posts.ts', "+## Qué es el cuál's", '+## Cuántos baños por invitado', '+## Hola'].join('\n');
  assert.equal(pickMarker(diff), 'Cuántos baños por invitado', "skips headings with apostrophes (HTML-escaped) and too-short ones");
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const wt = mkdtempSync(join(tmpdir(), 'wd-en-')); mkdirSync(join(wt, 'src/lib'), { recursive: true });
  writeFileSync(join(wt, 'src/lib/i18n.ts'), `"/blog/luvory-a": "/blog/luvory-a-en",\n"yume-b": "yume-b-en",`);
  assert.equal(enSlugFor({ worktree: wt } as any, 'luvory-a'), 'luvory-a-en');
  assert.equal(enSlugFor({ worktree: wt } as any, 'yume-b'), 'yume-b-en');
  assert.equal(enSlugFor({ worktree: wt } as any, 'otro', 'x'), 'x');
});

test('post effects: impressions per day 28 days before vs since a published post', async () => {
  const { postEffects } = await import('../src/agents/agents.ts');
  const db = openDb(join(process.env.WATCHDOG_DATA!, 'fx.db'));
  db.prepare("INSERT INTO sites (id, url) VALUES (31, 'https://fx.example/')").run();
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  db.prepare("INSERT INTO approvals (site_id, agent, kind, title, payload_json, diff, status, decided_at) VALUES (31, 'writer', 'post', 'Improve: Mi post', ?, '', 'published', ?)").run(JSON.stringify({ urls: ['https://fx.example/blog/mi-post'] }), day(30) + ' 12:00:00');
  const put = db.prepare("INSERT INTO metrics VALUES (31, 'gsc', ?, 'q', 'https://fx.example/blog/mi-post', 0, ?, 10)");
  put.run(day(40), 56); // before: 56 impressions in the 28 days before => 2/day
  put.run(day(10), 56); // after: 56 impressions over the ~28 days since => 2/day
  const fx = postEffects(db, 31);
  assert.equal(fx.length, 1); assert.equal(fx[0].kind, 'Improve'); assert.equal(fx[0].impressionsPerDay, '2 -> 2');
});

test('customer questions are injected only when the owner supplied a file', async () => {
  const { customerQuestions } = await import('../src/agents/audience.ts');
  assert.equal(customerQuestions('nope.example'), '');
});

test('copy lint can be limited to the files the writer authors (generated output is not judged)', async () => {
  const { lintAdded } = await import('../src/agents/agents.ts');
  const diff = ['diff --git a/_src/posts_agent.py b/_src/posts_agent.py', '--- a/_src/posts_agent.py', '+++ b/_src/posts_agent.py', '+limpio',
    'diff --git a/llms.txt b/llms.txt', '--- a/llms.txt', '+++ b/llms.txt', '+- [t](u): d — markdown: `x`'].join('\n');
  assert.deepEqual(lintAdded(diff), ['em-dash in new copy'], 'without a limit the generated line is flagged');
  assert.deepEqual(lintAdded(diff, ['_src/posts_agent.py']), []);
  assert.deepEqual(lintAdded(diff.replace('+limpio', '+con — raya'), ['_src/posts_agent.py']), ['em-dash in new copy'], 'still catches the writer\'s own copy');
});

test('staging never includes node_modules, whether the repo ignores it or not', async () => {
  const { execFileSync: x } = await import('node:child_process');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { prepareWorktree, changedFiles } = await import('../src/agents/agents.ts');
  const root = mkdtempSync(join(tmpdir(), 'wd-nm-')), g = (cwd: string, ...a: string[]) => x('git', a, { cwd, encoding: 'utf8' });
  for (const [i, ignore] of ['node_modules', 'node_modules/', ''].entries()) {
    const owner = join(root, 'o' + i); mkdirSync(owner);
    g(owner, 'init', '-q', '-b', 'main'); g(owner, 'config', 'user.email', 't@t'); g(owner, 'config', 'user.name', 't');
    writeFileSync(join(owner, '.gitignore'), ignore + '\n'); writeFileSync(join(owner, 'a.txt'), '1\n'); g(owner, 'add', '.'); g(owner, 'commit', '-qm', 'i');
    mkdirSync(join(owner, 'node_modules')); writeFileSync(join(owner, 'node_modules/x.js'), '');
    g(owner, 'remote', 'add', 'origin', owner);
    const wt = prepareWorktree({ repo: owner, worktree: join(root, 'w' + i), remote: 'origin' } as any, 'agent/t');
    writeFileSync(join(wt, 'a.txt'), '2\n');
    assert.deepEqual(changedFiles(wt), ['a.txt'], `ignore rule ${JSON.stringify(ignore)}`);
  }
});

test('a clicked job that hits the usage limit stays queued and runs again later; a scheduled one is left to the schedule', async () => {
  const { runAgent, inFlight, setLimitRetry } = await import('../src/agents/scheduler.ts');
  const { AGENTS, LimitError } = await import('../src/agents/agents.ts');
  const db = openDb(join(process.env.WATCHDOG_DATA!, 'lim.db'));
  db.prepare("INSERT INTO sites (id, url, kind) VALUES (41, 'https://studioyume.mx/', 'own')").run();
  const site = db.prepare('SELECT * FROM sites WHERE id = 41').get() as any;
  let calls = 0;
  (AGENTS as any).collect = async () => { calls++; if (calls === 1) throw new LimitError('limit'); return 'ok now'; };
  setLimitRetry(150);
  await runAgent(db, 'collect', site, null, { slug: 'x' });
  const queuedRows = () => (db.prepare("SELECT COUNT(*) n FROM agent_queue WHERE agent = 'collect' AND site_id = 41").get() as { n: number }).n;
  assert.equal(queuedRows(), 1, 'the row stays so a restart also resumes it');
  assert.ok(inFlight().includes('collect:41:x'), 'and it cannot be queued twice');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(calls, 2, 'it ran again');
  assert.equal(queuedRows(), 0, 'and is cleared once it succeeds');
  // scheduled run (slot given): no retry timer, the 30-minute schedule handles it
  calls = 0; (AGENTS as any).collect = async () => { calls++; throw new LimitError('limit'); };
  await runAgent(db, 'collect', site, 'collect:2026-10-27:06:15');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(calls, 1);
  setLimitRetry(30 * 60_000);
});

test('pause: clicked jobs are parked in the queue, nothing is cancelled, and Resume runs them', async () => {
  const { runAgent, inFlight, isPaused, resumeQueued } = await import('../src/agents/scheduler.ts');
  const { AGENTS } = await import('../src/agents/agents.ts');
  const db = openDb(join(process.env.WATCHDOG_DATA!, 'pause.db'));
  db.prepare("INSERT INTO sites (id, url, kind) VALUES (51, 'https://studioyume.mx/', 'own')").run();
  const site = db.prepare('SELECT * FROM sites WHERE id = 51').get() as any;
  let calls = 0; (AGENTS as any).collect = async () => { calls++; return 'ran'; };
  db.prepare("INSERT INTO agent_settings (agent, site_id, enabled) VALUES ('*', 0, 0) ON CONFLICT(agent, site_id) DO UPDATE SET enabled = 0").run();
  assert.equal(isPaused(db), true);
  await runAgent(db, 'collect', site, null, { slug: 'a' });
  await runAgent(db, 'collect', site, null, { slug: 'b' });
  assert.equal(calls, 0, 'nothing runs while paused');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM agent_queue WHERE site_id = 51').get() as { n: number }).n, 2, 'both clicks are kept');
  assert.deepEqual(inFlight().filter((k) => k.startsWith('collect:51')), [], 'and they are not in flight');
  db.prepare("UPDATE agent_settings SET enabled = 1 WHERE agent = '*' AND site_id = 0").run();
  assert.equal(resumeQueued(db), 2);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(calls, 2, 'resume ran both, in order');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM agent_queue WHERE site_id = 51').get() as { n: number }).n, 0);
});
