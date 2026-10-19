// Change events between two snapshots of the same page. Pure.
import type { Extract } from './extract.ts';

export type Change = { field: string; before: string | null; after: string | null };

const FIELDS: [string, (e: Extract) => unknown][] = [
  ['status', (e) => e.status],
  ['final_url', (e) => e.final_url],
  ['title', (e) => e.title],
  ['meta_description', (e) => e.meta_description],
  ['h1', (e) => e.h1.join(' | ')],
  ['canonical', (e) => e.canonical],
  ['noindex', (e) => e.noindex],
  ['robots', (e) => e.robots],
  ['lang', (e) => e.lang],
  ['hreflang', (e) => e.hreflang.map((h) => `${h.lang}=${h.href}`).sort().join(' ')],
  ['jsonld_types', (e) => e.jsonld_types.join(',')],
  ['faq_questions', (e) => e.faq_questions.length],
  ['content', (e) => e.text_hash],
];

const str = (v: unknown) => (v == null || v === '' ? null : String(v));

export function diffPage(prev: Extract, cur: Extract): Change[] {
  // A failed fetch says nothing about the page's tags; only report the status/error itself.
  const comparable = prev.is_html && cur.is_html;
  const out: Change[] = [];
  for (const [field, get] of FIELDS) {
    if (!comparable && field !== 'status' && field !== 'final_url') continue;
    const before = str(get(prev)), after = str(get(cur));
    if (before === after) continue;
    if (field === 'content') {
      out.push({ field, before: `${prev.word_count} words`, after: `${cur.word_count} words` });
      continue;
    }
    out.push({ field, before, after });
  }
  return out;
}
