import * as fs from 'node:fs';
import { join } from 'node:path';

export type InsertPoint = { label: string; file: string; do: 'insert-after' | 'append' | 'create'; anchor?: string; note?: string };

const unique = (content: string, anchor: string): boolean =>
  anchor.length > 0 && content.split(anchor).length - 1 === 1;

export function uniqueTailAnchor(content: string, endIdx: number, maxLines = 40): string | null {
  if (!Number.isInteger(endIdx) || endIdx <= 0 || endIdx > content.length || content[endIdx - 1] !== '\n') return null;
  let start = endIdx;
  for (let lines = 0; lines < maxLines && start > 0; lines++) {
    start = start < 2 ? 0 : content.lastIndexOf('\n', start - 2) + 1;
    const anchor = content.slice(start, endIdx);
    if (unique(content, anchor)) return anchor;
  }
  return null;
}

export function lastLineMatching(content: string, re: RegExp): string | null {
  const matcher = new RegExp(re.source, re.flags.replace(/[gy]/g, '') + 'g');
  let last: string | null = null;
  for (const match of content.matchAll(matcher)) {
    const end = match.index + match[0].length;
    const line = match[0].replace(/^(?:[ \t]*\n)+/, '');
    last = line.endsWith('\n') ? line : content[end] === '\n' ? line + '\n' : null;
  }
  return last !== null && unique(content, last) ? last : null;
}

export function insertPointsFor(host: string, wt: string, slug: string): InsertPoint[] {
  const points: InsertPoint[] = [];
  const read = (file: string): string | null => {
    try { return fs.readFileSync(join(wt, file), 'utf8').replace(/\r\n/g, '\n'); }
    catch { return null; }
  };
  const add = (file: string, label: string, anchorFor: (content: string) => string | null, note?: string) => {
    const content = read(file);
    if (content === null) return;
    const anchor = anchorFor(content);
    if (anchor !== null) points.push({ label, file, do: 'insert-after', anchor, ...(note === undefined ? {} : { note }) });
  };
  const tail = (content: string) => uniqueTailAnchor(content, content.lastIndexOf('\n];\n') + 1);
  const objectNote = 'text = ONE complete post object that starts with "  {" and ends with "  },\n" (2-space indent like the others)';

  if (host === 'luvory.com.mx') {
    add('src/data/blog-posts.ts', 'blogPosts array: add the new post object after the last existing post', tail,
      'text = ONE complete post object that starts with "  {" and ends with "  },\n" (2-space indent like the others, including its `en: { ... }` block)');
    add('src/lib/i18n.ts', 'EN_SLUG_MAP: add the English slug',
      content => lastLineMatching(content, /^\s*"\/blog\/[^"\n]+":\s*"\/blog\/[^"\n]+",[ \t]*\n/m),
      `text = ONE line: "  \\"/blog/${slug}\\": \\"/blog/<english-slug-in-kebab-case>\\",\\n"`);
    add('public/sitemap.xml', 'sitemap: add the ES and EN entries after the last blog entry', content => {
      let last: string | null = null;
      for (const match of content.matchAll(/^  <url>\n[\s\S]*?^  <\/url>\n/gm)) {
        if (/<loc>[^<]*\/blog\/[^<]*<\/loc>/.test(match[0])) last = match[0];
      }
      return last !== null && unique(content, last) ? last : null;
    }, 'text = TWO <url> blocks (Spanish, then English) copying that block\'s exact format (loc, lastmod, changefreq, priority, the three xhtml:link lines); omit <image:image> when the post has no own image');
  } else if (host === 'vexonmexico.com.mx') {
    points.push({ label: 'new post file', file: `src/content/blog/${slug}.mdx`, do: 'create', note: 'text = the COMPLETE .mdx file (frontmatter + body)' });
  } else if (host === 'dizaynseo.com') {
    if (read('_src/posts_agent.py') !== null) points.push({ label: 'new post: append to the end of the file', file: '_src/posts_agent.py', do: 'append', note: 'text starts with a newline; first any S["key"] = L(...) and TABLES["key"] = T(...) lines the body needs, then POSTS.append({...}) with the post dict' });
  } else if (host === 'studioyume.mx') {
    add('src/content/blog.ts', 'blog.ts: add the Spanish post object after the last one', tail, objectNote);
    add('src/content/blog.en.ts', 'blog.en.ts: add the English post object after the last one', tail, objectNote);
    add('src/lib/i18n.ts', 'BLOG_SLUG_EN: add the slug pair', content => {
      const name = content.indexOf('BLOG_SLUG_EN');
      if (name < 0) return null;
      const start = content.indexOf('{', name);
      if (start < 0) return null;
      const end = content.indexOf('\n}', start);
      if (end < 0) return null;
      const anchor = lastLineMatching(content.slice(start + 1, end + 1), /^\s*"[a-z0-9-]+":\s*"[a-z0-9-]+",[ \t]*\n/m);
      return anchor !== null && unique(content, anchor) ? anchor : null;
    });
  }
  return points;
}
