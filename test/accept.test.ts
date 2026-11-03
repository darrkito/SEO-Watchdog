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
