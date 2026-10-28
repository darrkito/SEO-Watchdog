import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentSite } from './sites.ts';

export type PostRange = { file: string; whole: boolean; anchor?: string; endAnchor?: string; lang: 'primary' | 'en' };

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function findRange(wt: string, files: string[], slug: string, lang: PostRange['lang']): PostRange | undefined {
  const pattern = new RegExp(`^(\\s*)"?slug"?\\s*[:=]\\s*"${escapeRegex(slug)}"\\s*,?\\s*$`, 'm');
  for (const file of files) {
    if (!existsSync(join(wt, file))) continue;
    const source = readFileSync(join(wt, file), 'utf8');
    // Match one line at a time so whitespace cannot absorb adjacent lines.
    let start = 0;
    for (const line of source.split('\n')) {
      const match = pattern.exec(line);
      if (match) {
        const anchor = `${line}\n`;
        const indent = match[1];
        const endAnchor = `\n${indent.slice(0, Math.max(0, indent.length - 2))}},\n`;
        return { file, whole: false, anchor, endAnchor: source.indexOf(endAnchor, start + line.length) < 0 ? undefined : endAnchor, lang };
      }
      start += line.length + 1;
    }
  }
}

export function locatePost(cfg: Pick<AgentSite, 'postFiles' | 'wholeFile'>, wt: string, slug: string): PostRange[] {
  const files = cfg.postFiles?.(slug) ?? [];
  if (cfg.wholeFile) {
    const file = files.find((file) => existsSync(join(wt, file)));
    return file ? [{ file, whole: true, lang: 'primary' }] : [];
  }
  const primary = findRange(wt, files, slug, 'primary');
  const ranges = primary ? [primary] : [];
  const i18n = join(wt, 'src/lib/i18n.ts');
  if (primary?.file !== 'src/data/blog-posts.ts' && existsSync(i18n)) {
    const enSlug = readFileSync(i18n, 'utf8').match(new RegExp(`"(?:/blog/)?${escapeRegex(slug)}"\\s*:\\s*"(?:/blog/)?([^"]+)"`))?.[1];
    if (enSlug) {
      const english = findRange(wt, files.filter((file) => file.endsWith('.ts')).map((file) => file.replace(/\.ts$/, '.en.ts')), enSlug, 'en');
      if (english) ranges.push(english);
    }
  }
  return ranges;
}

export function postText(wt: string, r: PostRange): string {
  const source = readFileSync(join(wt, r.file), 'utf8');
  if (r.whole) return source;
  const start = source.indexOf(r.anchor!);
  const end = r.endAnchor ? source.indexOf(r.endAnchor, start + r.anchor!.length - 1) : -1;
  return source.slice(start, end < 0 ? undefined : end);
}

export function currentOf(cfg: Pick<AgentSite, 'postFiles' | 'wholeFile'>, wt: string, slug: string, cap = 24000): string {
  return locatePost(cfg, wt, slug).map((r) => `=== ${r.file} ===\n${postText(wt, r)}`).join('\n').slice(0, cap);
}

export function exampleOf(cfg: Pick<AgentSite, 'postFiles' | 'wholeFile' | 'listPosts'> & { repo?: string }, wt: string): string {
  const last = cfg.listPosts(wt).at(-1);
  return last ? currentOf(cfg, wt, last.slug, 7000) : '';
}
