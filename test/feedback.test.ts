import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, rejectionMessage } from '../src/agents/feedback.ts';

test('executor takes precedence', () => assert.equal(diagnose(['check: bad', 'executor failed'], []).kind, 'executor'));
test('check and plan text take precedence', () => {
  for (const p of ['check: bad', 'plan text: bad']) assert.equal(diagnose([p], []).kind, 'check');
});
test('missing context takes precedence over repeat', () => {
  const p = `reviewer: El diff del post ES muestra el slug 'x', no un gemelo con "en": "y" visible en el contexto`;
  assert.equal(diagnose([p], [p]).kind, 'missing-context');
});
test('repeated content objection is normalized', () => assert.equal(diagnose(['reviewer: Cambiar cifra 123'], ['Cambiar cifra 456']).kind, 'repeat'));
test('other objections are content', () => assert.equal(diagnose(['reviewer: Cambiar el título'], []).kind, 'content'));
test('message truncates problems and preserves the action', () => {
  for (const p of ['executor: failed', 'check: failed', 'reviewer: contexto', 'reviewer: cambiar', 'other']) {
    const dx = diagnose([p], p.includes('cambiar') ? ['cambiar'] : []);
    const message = rejectionMessage('not approved after 3 rounds', ['x'.repeat(1000), 'y'.repeat(1000)], dx);
    assert.ok(message.length <= 480);
    assert.ok(message.endsWith(dx.action));
  }
});
