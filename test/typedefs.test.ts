import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTypeDecls } from '../src/agents/typedefs.ts';

test('extracts documented declarations in requested order', () => {
  const a = '/** Section documentation */\nexport interface Section {\n  table?: { headers: string[]; rows: string[][] };\n}';
  const b = '// alias documentation\nexport type Post = { section: Section; title: string };';
  assert.equal(extractTypeDecls(`${a}\n\n${b}`, ['Post', 'missing', 'Section']), `${b}\n\n${a}`);
  assert.equal(extractTypeDecls('', ['Post']), '');
});
