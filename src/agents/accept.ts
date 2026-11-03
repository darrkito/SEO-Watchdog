export type AnswerMode = 'markdown' | 'heading-body';

export function wordCount(s: string): number {
  return s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#>]/g, '').split(/\s+/u).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

export function checkAnswerBlocks(text: string, mode: AnswerMode): string[] {
  const blocks: { heading: string; body: string }[] = [];
  if (mode === 'markdown') {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^## (.+?)\s*$/);
      if (!match || /^(?:FAQ|Preguntas frecuentes|Frequently asked questions)$/i.test(match[1].trim())) continue;
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || /^\s*#{1,6}\s/.test(lines[j]))) {
        if (/^## /.test(lines[j])) break;
        j++;
      }
      const paragraph: string[] = [];
      while (j < lines.length && lines[j].trim() && !/^\s*#{1,6}\s/.test(lines[j])) paragraph.push(lines[j++]);
      blocks.push({ heading: match[1], body: paragraph.join(' ') });
    }
  } else {
    const pattern = /\bheading\s*:\s*(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1\s*,\s*body\s*:\s*\[\s*(["'`])((?:\\[\s\S]|(?!\3)[^\\])*)\3/g;
    for (const m of text.matchAll(pattern)) blocks.push({ heading: m[2].replace(/\\(["'`\\])/g, '$1'), body: m[4].replace(/\\(["'`\\])/g, '$1') });
  }
  return blocks.flatMap(({ heading, body }) => {
    const n = wordCount(body);
    return n < 40 || n > 60 ? [`H2 "${heading}" opens with ${n} words; the direct answer must be 40 to 60 words. Rewrite ONLY that first paragraph.`] : [];
  });
}

export function checkDuplicateSentences(text: string): string[] {
  const found = new Map<string, { sentence: string; count: number }>();
  for (const sentence of text.split(/(?<=[.!?])\s+/u)) {
    const normalized = sentence.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim().replace(/\s+/g, ' ');
    if (wordCount(normalized) < 8) continue;
    const prior = found.get(normalized);
    if (prior) prior.count++; else found.set(normalized, { sentence: sentence.trim(), count: 1 });
  }
  return [...found.values()].filter((item) => item.count > 1).slice(0, 5).map((item) => `sentence repeated ${item.count} times: "${item.sentence.slice(0, 80)}". Keep one.`);
}

export function checkInternalLinks(text: string, exists: (href: string) => boolean): string[] {
  const hrefs = new Set<string>();
  const pattern = /\]\((\/[^\s)]*)\)|\bhref\s*:\s*(["'])(\/[^"']*)\2/g;
  for (const m of text.matchAll(pattern)) {
    const href = (m[1] ?? m[3]).split(/[?#]/, 1)[0];
    if (href && !href.startsWith('//') && !href.startsWith('http')) hrefs.add(href);
  }
  const problems: string[] = [];
  for (const href of hrefs) {
    if (!exists(href)) problems.push(`internal link ${href} does not exist in the repo. Remove the link or use one from the verified list.`);
    if (problems.length === 8) break;
  }
  return problems;
}

export function nonProblem(p: string): boolean {
  const text = p.toLowerCase();
  return /\b(aceptable|sin cambio requerido|no requiere cambio|es válid[oa]|es correct[oa]|no hay problema|acceptable|no change (needed|required)|is valid|looks (good|fine))\b/.test(text) && !/\b(debe|deben|quitar|quita|elimina|reescribe|falta|should|must|remove|missing)\b/.test(text);
}
