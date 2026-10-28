import test from 'node:test';
import assert from 'node:assert/strict';
import { planPrompt, reviewPrompt, scoutPrompt, fixerPlanPrompt } from '../src/agents/prompts.ts';
import type { PlanInput } from '../src/agents/prompts.ts';

const plan: PlanInput = {
  brief: 'Escribir un post', miniAudit: 'Mini auditoría', rules: 'Reglas', writerRules: 'Estilo',
  facts: [],
  audience: 'Lectores', example: 'Ejemplo literal', current: 'Texto actual',
  ranges: [
    { file: 'posts/a.ts', whole: false, anchor: 'inicio\n"texto"', endAnchor: 'fin\n' },
    { file: 'posts/b.ts', whole: true },
  ],
  insertPoints: [
    { label: 'Índice', file: 'index.ts', do: 'insert-after', anchor: 'lista\n', note: 'Añadir aquí' },
    { label: 'Nuevo', file: 'new.ts', do: 'create' },
  ],
  allowedPaths: ['posts/a.ts', 'index.ts'],
};
const findings = [
  { id: 1, rule: 'title', severity: 'critical', subject: '/a', message: 'Falta título' },
  { id: 2, rule: 'description', severity: 'warning', subject: '/b', message: 'Falta descripción' },
];
const fixer = {
  siteUrl: 'https://example.com', findings, scout: 'Informe literal', rules: 'Reglas',
  audience: 'Lectores', allowedPathsNote: 'src/**', picked: true,
};
const review = {
  rules: 'Reglas', writerRules: 'Estilo', audience: 'Lectores', diff: '',
  order: {
    title: 'Orden', doneWhen: '', mustContain: [], forbiddenPaths: [],
    steps: [{ n: 1, do: 'create' as const, file: 'a.ts', text: 'a' }, { n: 2, do: 'append' as const, file: 'b.ts', text: 'b' }],
  },
};

test('plan preserves section order, JSON anchors, paths, and literal JSON escape instructions', () => {
  const prompt = planPrompt({ ...plan, facts: [{ file: 'facts.txt', text: 'Medida: 20 cm' }, { file: 'contact.txt', text: 'Dirección autorizada' }] });
  let previous = -1;
  for (const heading of ['Eres el CEREBRO', 'TU TAREA', 'REGLAS DEL SITIO', 'DATOS AUTORIZADOS DEL REPO', 'Lectores', 'EJEMPLO REAL', 'TEXTO ACTUAL DEL POST', 'DÓNDE ESTÁ EL POST', 'DÓNDE METER UN POST NUEVO', 'CÓMO RESPONDER', 'OPERACIONES', 'REGLAS DE LA ORDEN']) {
    const index = prompt.indexOf(heading);
    assert.ok(index > previous, heading);
    previous = index;
  }
  assert.ok(prompt.includes(`- posts/a.ts | whole=false anchor=${JSON.stringify(plan.ranges[0].anchor)} endAnchor=${JSON.stringify(plan.ranges[0].endAnchor)}`));
  assert.ok(prompt.includes('- posts/b.ts | whole=true\n\n'));
  assert.ok(prompt.includes(`- Índice | index.ts | insert-after | anchor=${JSON.stringify('lista\n')} | Añadir aquí`));
  assert.ok(prompt.includes('- Nuevo | new.ts | create\n\n'));
  assert.ok(prompt.includes('3. Solo puedes tocar estas rutas: posts/a.ts, index.ts'));
  assert.ok(prompt.includes(String.raw`5. En JSON, los saltos de línea van como \n y las comillas dobles como \". Verifica que el JSON sea válido.`));
  assert.ok(prompt.includes('REGLAS DEL SITIO (límites duros)\nReglas\nEstilo\n\nDATOS AUTORIZADOS DEL REPO'));
  assert.ok(prompt.includes('=== facts.txt ===\nMedida: 20 cm\n=== contact.txt ===\nDirección autorizada\n\nLectores'));
});

test('plan omits empty optional sections without extra separators', () => {
  const prompt = planPrompt({ ...plan, facts: [], miniAudit: '', rules: '', writerRules: '', audience: '', example: '', current: '', ranges: [], insertPoints: [] });
  for (const heading of ['EJEMPLO REAL', 'TEXTO ACTUAL DEL POST', 'DÓNDE ESTÁ EL POST', 'DÓNDE METER UN POST NUEVO', 'REGLAS DEL SITIO']) {
    assert.ok(!prompt.includes(heading), heading);
  }
  assert.ok(prompt.includes('TU TAREA\nEscribir un post\n\nCÓMO RESPONDER'));
  assert.ok(!prompt.includes('\n\n\n'));
});

test('review lists steps, caps diff, and preserves the JSON answer contract', () => {
  const prompt = reviewPrompt({ ...review, diff: 'x'.repeat(70000) });
  assert.ok(prompt.includes('ORDEN EJECUTADA\nOrden: todos los pasos aplicados\n1. create en a.ts\n2. append en b.ts'));
  assert.equal(prompt.split('DIFF (con contexto)\n')[1].split('\n\nQUÉ REVISAR')[0], 'x'.repeat(60000) + '\n[diff cut]');
  assert.ok(prompt.includes(`CÓMO RESPONDER: solo un objeto JSON:
{
  "ok": true | false,
  "problems": [ "archivo + texto exacto + por qué está mal + cómo debe quedar" ],
  "changeOrder": null | { "title": "...", "steps": [ ...mismo formato de pasos que la orden original... ], "mustContain": [ ], "forbiddenPaths": [ ], "doneWhen": "..." }
}`));
  assert.ok(!reviewPrompt({ ...review, diff: 'x'.repeat(60000) }).includes('[diff cut]'));
  assert.ok(reviewPrompt({ ...review, order: { ...review.order, doneWhen: 'Terminado' } }).includes('Orden: Terminado'));
});

test('scout lists each finding and includes rules only when supplied', () => {
  const prompt = scoutPrompt(findings, 'private/**');
  assert.ok(prompt.includes('Read-only'));
  assert.ok(prompt.includes('1 [title] /a: Falta título\n2 [description] /b: Falta descripción'));
  assert.ok(prompt.includes('Files that must never be reported or opened beyond a first look: private/**\n\nFINDINGS'));
  assert.ok(!scoutPrompt(findings, '').includes('Files that must never be reported'));
  assert.ok(prompt.includes('If you cannot find it, write `FINDING <id>` then `NOT FOUND: <reason>`.'));
});

test('fixer preserves findings, caps scout, selects task wording, and uses fixer meta', () => {
  const prompt = fixerPlanPrompt({ ...fixer, scout: 's'.repeat(40000) + 'CUT_ME' });
  assert.ok(prompt.includes(JSON.stringify(findings)));
  assert.equal(prompt.split('<<<INFORME\n')[1].split('\nINFORME>>>')[0], 's'.repeat(40000));
  assert.ok(!prompt.includes('CUT_ME'));
  assert.ok(prompt.includes('El dueño eligió'));
  assert.ok(!prompt.includes('Corrige hasta 5'));
  const unpicked = fixerPlanPrompt({ ...fixer, picked: false });
  assert.ok(!unpicked.includes('El dueño eligió'));
  assert.ok(unpicked.includes('Corrige hasta 5 de ellos, empezando por los críticos.'));
  assert.ok(prompt.includes('"meta": { "fixed": [ids], "skipped": [ { "id": n, "reason": "..." } ] }'));
  assert.ok(!prompt.includes('"slug"'));
  assert.ok(prompt.includes('3. Solo puedes tocar estas rutas: src/**'));
});

test('planners share identical operations, introduction, and order rules', () => {
  const post = planPrompt(plan);
  const fix = fixerPlanPrompt({ ...fixer, allowedPathsNote: plan.allowedPaths.join(', ') });
  const operations = (prompt: string) => prompt.split('\n\nOPERACIONES\n')[1].split('\n\nREGLAS DE LA ORDEN')[0];
  assert.ok(operations(post));
  assert.equal(operations(post), operations(fix));
  assert.equal(post.split('\n\nTU TAREA')[0], fix.split('\n\nTU TAREA')[0]);
  assert.equal(post.split('\n\nREGLAS DE LA ORDEN')[1], fix.split('\n\nREGLAS DE LA ORDEN')[1]);
});

test('plan omits authorized facts section when facts is empty', () => {
  const prompt = planPrompt({ ...plan, facts: [] });
  assert.ok(!prompt.includes('DATOS AUTORIZADOS DEL REPO'));
  assert.ok(prompt.includes('REGLAS DEL SITIO (límites duros)\nReglas\nEstilo\n\nLectores'));
});
