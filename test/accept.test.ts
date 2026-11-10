import test from 'node:test';
import assert from 'node:assert/strict';
import { wordCount, checkAnswerBlocks, checkDuplicateSentences, checkInternalLinks, nonProblem } from '../src/agents/accept.ts';

const words = (n: number) => Array(n).fill('palabra').join(' ');
test('word count strips markup and ignores punctuation', () => {
  assert.equal(wordCount('## **Hola** [mundo feliz](/url) `42` > !'), 4);
});
test('markdown answer bounds and ignored headings', () => {
  for (const n of [39, 40, 60, 61]) assert.equal(checkAnswerBlocks(`## Título\n\n${words(n)}\n`, 'markdown').length, n < 40 || n > 60 ? 1 : 0);
  assert.deepEqual(checkAnswerBlocks('## FAQ\nshort\n## Preguntas frecuentes\nshort\n## Frequently asked questions\nshort\n### Subheading\nshort', 'markdown'), []);
});
test('markdown answer stops at a list with no blank line before it', () => {
  assert.deepEqual(checkAnswerBlocks(`## Fuentes\n${words(45)}\n- [a](/x) ${words(30)}\n- b ${words(30)}\n`, 'markdown'), []);
});
test('heading body supports quoted strings and escapes', () => {
  for (const q of ['"', "'", '`']) {
    const text = `heading: ${q}Title${q}, body: [${q}${words(40)}${q}]`;
    assert.deepEqual(checkAnswerBlocks(text, 'heading-body'), []);
    assert.equal(checkAnswerBlocks(`heading: ${q}Ti\\${q}tle${q}, body: [${q}short${q}]`, 'heading-body').length, 1);
  }
});
test('duplicate sentences and links', () => {
  const sentence = 'These eight words form a long enough sentence.';
  assert.equal(checkDuplicateSentences(`${sentence} ${sentence}`).length, 1);
  const seen: string[] = [];
  const problems = checkInternalLinks('[a](/missing?q=1) [b](/missing#top) [c](//external) href: "/ok"', (href) => { seen.push(href); return href === '/ok'; });
  assert.deepEqual(seen, ['/missing', '/ok']);
  assert.equal(problems.length, 1);
});
test('non-problem detection', () => {
  assert.equal(nonProblem('Es válido, aceptable'), true);
  assert.equal(nonProblem('Debe quitar la frase'), false);
  assert.equal(nonProblem('Es válido pero debe quitar la frase'), false);
});
test('diff context breaks blocks: an unchanged blank line does not glue paragraphs', async () => {
  const { addedBlocks } = await import('../src/agents/agents.ts');
  const diff = `diff --git a/p.md b/p.md\n--- a/p.md\n+++ b/p.md\n@@ -1,5 +1,5 @@\n+## Cotiza\n \n+${words(45)}\n \n+${words(200)}\n`;
  assert.deepEqual(checkAnswerBlocks(addedBlocks(diff).join('\n'), 'markdown'), []);
});
test('duplicate check ignores structured fields that mirror prose', () => {
  const a = 'Yes. Luvory serves Guadalajara and Zapopan and Tlaquepaque and Tonala.';
  assert.equal(checkDuplicateSentences(`${a}\n  text: "${a}",\n{"@type":"Answer","text":"${a}"}`).length, 0);
  assert.equal(checkDuplicateSentences(`${a}\n\n${a}`).length, 1);
});

test('lintAcceptance skips generated files that repeat pages by design', async () => {
  const { lintAcceptance } = await import('../src/agents/agents.ts');
  const s = 'Four things owners ask first: websites cost $540 to $1,200 once and monthly plans.';
  const diff = (f: string) => `${f} b/${f}\n+${s}\n+\n+${s}\n+\n+${s}\n`;
  const cfg = { derivedPaths: ['llms-full.txt'], answerMode: undefined } as any;
  assert.equal(lintAcceptance(diff('a/llms-full.txt'), cfg).length, 0);
  assert.equal(lintAcceptance(diff('a/_src/posts_agent.py'), cfg).length, 1);
});
