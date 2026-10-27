// Deterministic per-site steps that run after the model edits a post (no LLM): regenerate derived files and check the post is wired in
// everywhere the site needs it. A failure here is reported back to the writer like a typecheck error, or rejects the draft.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type PostOpts = { slug: string; improve: boolean; merge: string | null };

const run = (cwd: string, cmd: string, args: string[], timeout = 300_000) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
const read = (wt: string, f: string) => (existsSync(join(wt, f)) ? readFileSync(join(wt, f), 'utf8') : '');

// ---------- Luvory ----------
// src/data/blog-index.json is generated from blog-posts.ts (the repo normally uses `bun scripts/build-blog-index.ts`; bun is not on this
// machine) and a vitest test fails when it is stale. Same projection as scripts/build-blog-index.ts.
const LUVORY_INDEX = `
import { blogPosts } from './src/data/blog-posts.ts';
import { writeFileSync } from 'node:fs';
writeFileSync('src/data/blog-index.json', JSON.stringify(blogPosts.map(({ slug, title, excerpt, date, dateModified, category, en }) => ({
  slug, title, excerpt, date, dateModified, category, ...(en ? { en: { title: en.title, excerpt: en.excerpt, category: en.category } } : {}),
}))));`;
export function luvoryPostEdit(wt: string): void {
  // a child process, so a post the model just edited is never served from this long-running process's module cache
  run(wt, 'node', ['--input-type=module', '-e', LUVORY_INDEX]);
}

/** A new Luvory post must exist in the 4 places the site reads: blog-posts.ts (with its `en` block), EN_SLUG_MAP, and both sitemap entries. */
export function luvoryValidate(wt: string, o: PostOpts): string[] {
  const posts = read(wt, 'src/data/blog-posts.ts'), bad: string[] = [];
  const start = posts.indexOf(`slug: "${o.slug}"`);
  if (start < 0) return [`post ${o.slug} is not in src/data/blog-posts.ts`];
  const next = posts.indexOf('\n  {\n    slug:', start);
  const block = posts.slice(start, next < 0 ? undefined : next);
  if (!/\n\s{4}en:\s*\{/.test(block)) bad.push('the post has no `en` block (the English version is required)');
  if (o.improve || o.merge) return bad;
  const map = read(wt, 'src/lib/i18n.ts').match(new RegExp(`"/blog/${o.slug}":\\s*"/blog/([^"]+)"`));
  if (!map) bad.push(`src/lib/i18n.ts EN_SLUG_MAP has no "/blog/${o.slug}" entry`);
  const sm = read(wt, 'public/sitemap.xml');
  if (!sm.includes(`https://luvory.com.mx/blog/${o.slug}</loc>`)) bad.push('public/sitemap.xml has no ES entry for the post');
  if (map && !sm.includes(`https://luvory.com.mx/en/blog/${map[1]}</loc>`)) bad.push('public/sitemap.xml has no EN entry for the post');
  return bad;
}

// ---------- Vexon ----------
/** The OG image of a post is generated (scripts/og.mjs, Playwright) from its title. Regenerating all of them can change other images' bytes:
 * keep only this post's, and not even that when an existing post kept its title. */
export function vexonPostEdit(wt: string, o: PostOpts): void {
  let keep: string | null = `public/og/blog-${o.slug}.jpg`;
  if (o.merge) {
    const file = `src/content/blog/${o.merge}.mdx`, title = (s: string) => s.match(/^title:\s*'(.+)'\s*$/m)?.[1];
    let before: string | undefined;
    try { before = title(run(wt, 'git', ['show', `HEAD:${file}`])); } catch { /* new in this branch */ }
    if (before && before === title(read(wt, file))) keep = null;
  }
  try { run(wt, 'node', ['scripts/og.mjs'], 600_000); }
  catch (e) { console.warn(`[vexon] og.mjs failed, post goes without its own OG image: ${String((e as Error).message).slice(0, 200)}`); }
  for (const line of run(wt, 'git', ['status', '--porcelain', '--', 'public/og']).split('\n').filter(Boolean)) {
    const f = line.slice(3).trim();
    if (f === keep) continue;
    if (line.startsWith('??')) run(wt, 'rm', ['-f', f]); else run(wt, 'git', ['checkout', '--', f]);
  }
}

/** Frontmatter limits that the SEO playbook sets tighter than the Zod schema, plus the file must exist. */
export function vexonValidate(wt: string, o: PostOpts): string[] {
  const f = `src/content/blog/${o.merge ?? o.slug}.mdx`, src = read(wt, f);
  if (!src) return [`${f} does not exist`];
  const fm = src.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '', bad: string[] = [];
  const title = fm.match(/^title:\s*'(.+)'\s*$/m)?.[1]?.replace(/''/g, "'") ?? '', desc = fm.match(/^description:\s*'(.+)'\s*$/m)?.[1]?.replace(/''/g, "'") ?? '';
  if (title.length < 25 || title.length > 62) bad.push(`title is ${title.length} characters (use 25 to 62)`);
  if (desc.length < 80 || desc.length > 156) bad.push(`description is ${desc.length} characters (use 80 to 156)`);
  if (!/^faqs:\s*\n\s+- q:/m.test(fm)) bad.push('frontmatter has no faqs');
  if (!/^## /m.test(src)) bad.push('the post has no ## headings');
  return bad;
}

// ---------- Dizayn SEO ----------
// Static site built from _src/*.py plus the partner's generator, which is not on this machine. dizayn/prep.py stands in for it (replayed
// against the committed output by dizayn/selftest.py): it rebuilds, keeps committed pages byte-identical where they did not change, and
// updates the markdown twins, sitemap, llms*.txt, api/_index.js, agent-tools.js and vercel.json for a new post.
const DIZAYN = join(import.meta.dirname, 'dizayn');
export function dizaynPostEdit(wt: string): void {
  run(wt, 'python3', [join(DIZAYN, 'prep.py'), wt], 600_000);
}
export function dizaynValidate(wt: string, o: PostOpts): string[] {
  try { run(wt, 'python3', [join(DIZAYN, 'check_post.py'), wt, o.merge ?? o.slug, o.improve || o.merge ? 'existing' : 'new']); return []; }
  catch (e) { return String((e as any).stdout ?? (e as Error).message).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12); }
}
