import test from 'node:test';
import assert from 'node:assert/strict';
import { researchPrompt, planPrompt, slimPlanPrompt, reviewPrompt, scoutPrompt, fixerPlanPrompt } from '../src/agents/prompts.ts';
import type { PlanInput } from '../src/agents/prompts.ts';

const plan: PlanInput = {
  brief: 'Escribir un post', miniAudit: 'Mini auditoría', rules: 'Reglas', writerRules: 'Estilo',
  facts: [], guides: [],
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
  guides: [], audience: 'Lectores', allowedPathsNote: 'src/**', picked: true,
};
const review = {
  rules: 'Reglas', writerRules: 'Estilo', audience: 'Lectores', diff: '',
  orders: [{
    title: 'Orden', doneWhen: '', mustContain: [], forbiddenPaths: [],
    steps: [{ n: 1, do: 'create' as const, file: 'a.ts', text: 'a' }, { n: 2, do: 'append' as const, file: 'b.ts', text: 'b' }],
  }],
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
  assert.ok(prompt.includes('ÓRDENES EJECUTADAS (en este orden; el DIFF es el resultado ACUMULADO de todas)\nORDEN 1 (original): Orden: todos los pasos aplicados\n1. create en a.ts\n2. append en b.ts'));
  assert.equal(prompt.split('DIFF (con contexto)\n')[1].split('\n\nQUÉ REVISAR')[0], 'x'.repeat(60000) + '\n[diff cut]');
  assert.ok(prompt.includes(`CÓMO RESPONDER: solo un objeto JSON:
Como máximo 8 problemas; cada uno de máximo 60 palabras.
{
  "ok": true | false,
  "problems": [ "archivo + texto exacto + por qué está mal + cómo debe quedar" ],
  "changeOrder": null | { "title": "...", "steps": [ ...mismo formato de pasos que la orden original... ], "mustContain": [ ], "forbiddenPaths": [ ], "doneWhen": "..." }
}`));
  assert.ok(!reviewPrompt({ ...review, diff: 'x'.repeat(60000) }).includes('[diff cut]'));
  assert.ok(reviewPrompt({ ...review, orders: [{ ...review.orders[0], doneWhen: 'Terminado' }] }).includes('Orden: Terminado'));
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

test('both planners require sourced factual claims', () => {
  const rule = '8. Toda afirmación factual del texto (cifras, fechas, temporadas, normas, comparaciones) va en meta.claims con su fuente: una URL que abriste o un archivo del repo. Si no tienes fuente, quita la afirmación del texto en lugar de escribirla. El ejecutor y el revisor ven esa lista.';
  assert.ok(planPrompt(plan).includes(rule));
  assert.ok(fixerPlanPrompt(fixer).includes(rule));
});

 test('guide sections appear before the audience only when supplied', () => {
  const guides = [{ file: 'CLAUDE.md', text: 'Instrucciones' }];
  const post = planPrompt({ ...plan, facts: [{ file: 'facts', text: 'Datos' }], guides });
  assert.ok(post.indexOf('DATOS AUTORIZADOS') < post.indexOf('GUÍAS DEL REPO'));
  for (const prompt of [post, fixerPlanPrompt({ ...fixer, guides })]) {
    assert.ok(prompt.includes('=== CLAUDE.md ===\nInstrucciones'));
    assert.ok(prompt.indexOf('GUÍAS DEL REPO') < prompt.indexOf('Lectores'));
  }
  assert.ok(!planPrompt(plan).includes('GUÍAS DEL REPO'));
  assert.ok(!fixerPlanPrompt(fixer).includes('GUÍAS DEL REPO'));
});

test('review includes all orders and deduplicated, capped claims', () => {
  const claim = { claim: 'c'.repeat(301), source: 's'.repeat(301) };
  const prompt = reviewPrompt({ ...review, orders: [{ ...review.orders[0], claims: [claim] }, { ...review.orders[0], title: 'Corrección', claims: [claim, { claim: 'Otra', source: 'fuente' }] }] });
  assert.ok(prompt.includes('ORDEN 1 (original)'));
  assert.ok(prompt.includes('ORDEN 2 (corrección): Corrección'));
  assert.ok(prompt.includes('el DIFF es el resultado ACUMULADO de todas'));
  assert.ok(prompt.includes('AFIRMACIONES VERIFICADAS POR EL PLANIFICADOR'));
  assert.equal(prompt.split(`- ${'c'.repeat(300)} [fuente: ${'s'.repeat(300)}]`).length, 2);
  assert.ok(prompt.includes('- Otra [fuente: fuente]'));
  assert.ok(!reviewPrompt(review).includes('AFIRMACIONES VERIFICADAS POR EL PLANIFICADOR'));
});


test('planner and reviewer describe generated paths', () => {
  const rule = '9. Los archivos generados (gen/*) los regenera el hook del repo: NUNCA los pongas en pasos, mustContain ni forbiddenPaths.';
  assert.ok(planPrompt({ ...plan, derivedPaths: ['gen/*'] }).includes(rule));
  assert.ok(fixerPlanPrompt({ ...fixer, derivedPaths: ['gen/*'] }).includes(rule));
  assert.ok(planPrompt(plan).includes('Los archivos generados (ninguno)'));
  assert.ok(reviewPrompt({ ...review, derivedNote: 'gen/x' }).includes('ARCHIVOS GENERADOS (los produce el hook del repo, no son parte del trabajo; ignóralos aunque no estén en la orden): gen/x'));
});


test('planner prompts include capped prior failure immediately after the task', () => {
  const heading = 'INTENTO ANTERIOR FALLIDO (corrige la causa, no repitas el mismo error)';
  const instruction = 'Escribe la orden de modo que este fallo no pueda ocurrir otra vez; si el fallo fue del revisor, ajusta el texto; si fue de un archivo generado o una ruta, no lo toques.';
  for (const [plain, withFailure] of [
    [planPrompt(plan), planPrompt({ ...plan, priorFailure: 'x'.repeat(1500) + 'CUT' })],
    [fixerPlanPrompt(fixer), fixerPlanPrompt({ ...fixer, priorFailure: 'x'.repeat(1500) + 'CUT' })],
  ]) {
    assert.ok(!plain.includes(heading));
    assert.ok(withFailure.includes(`${heading}\n${'x'.repeat(1500)}\n${instruction}`));
    assert.ok(!withFailure.includes('CUT'));
    assert.ok(withFailure.indexOf(heading) > withFailure.indexOf('TU TAREA'));
    assert.ok(withFailure.indexOf(heading) < withFailure.indexOf('REGLAS DEL SITIO'));
  }
});


test('research prompt requests sourced findings without site instructions', () => {
  const prompt = researchPrompt({ siteUrl: 'https://example.test', brief: 'brief context', title: 'Topic', query: 'query', audience: 'audience context' });
  for (const part of ['WebSearch', 'WebFetch', '900 palabras', '12 hallazgos', '"findings"', '"point"', '"source"', '"angle"', '"avoid"', 'brief context', 'audience context']) assert.ok(prompt.includes(part), part);
  for (const part of ['REGLAS DEL SITIO', 'GUÍAS DEL REPO', 'EJEMPLO REAL', 'playbook']) assert.ok(!prompt.includes(part), part);
});

test('research changes the planner tools and is limited to 6000 characters', () => {
  const prompt = planPrompt({ ...plan, research: 'R'.repeat(6000) + 'CUT_RESEARCH' });
  assert.ok(prompt.includes('INVESTIGACIÓN YA HECHA'));
  assert.ok(prompt.includes('R'.repeat(6000)));
  assert.ok(!prompt.includes('CUT_RESEARCH'));
  assert.ok(prompt.includes('No tienes herramientas en este paso: usa solo lo que está en este mensaje.'));
  assert.ok(!prompt.includes('Tienes WebSearch y WebFetch para investigar.'));
  assert.ok(planPrompt(plan).includes('Tienes WebSearch y WebFetch para investigar.'));
  assert.ok(!planPrompt(plan).includes('INVESTIGACIÓN YA HECHA'));
});


test('slim plan keeps correction context and omits heavy sections', () => {
  const prompt = slimPlanPrompt({ ...plan, priorFailure: 'FAILURE_MARKER', research: 'RESEARCH_MARKER', facts: [{ file: 'facts', text: 'FACT_MARKER' }], guides: [{ file: 'guide', text: 'GUIDE_MARKER' }] });
  for (const marker of ['Eres el CEREBRO', 'TU TAREA', 'FAILURE_MARKER', 'RESEARCH_MARKER', 'REGLAS DEL SITIO', 'FACT_MARKER', 'DÓNDE ESTÁ EL POST', 'DÓNDE METER UN POST NUEVO', 'CÓMO RESPONDER', 'OPERACIONES', 'REGLAS DE LA ORDEN']) assert.ok(prompt.includes(marker), marker);
  for (const marker of ['Mini auditoría', 'Lectores', 'GUIDE_MARKER', 'Ejemplo literal', 'Texto actual']) assert.ok(!prompt.includes(marker), marker);
});

test('review compacts long step text across orders and retains short text and fields', () => {
  const order = { ...review.orders[0], mustContain: ['required'], steps: [{ n: 1, do: 'replace' as const, file: 'a.ts', anchor: 'anchor', note: 'note', text: 'x'.repeat(401) }, { n: 2, do: 'append' as const, file: 'b.ts', text: 'y'.repeat(400) }] };
  const prompt = reviewPrompt({ ...review, orders: [order, order] });
  assert.equal(prompt.split('text: [401 characters, see the DIFF]').length - 1, 2);
  assert.ok(prompt.includes('text: ' + 'y'.repeat(400)));
  for (const marker of ['anchor: anchor', 'note: note', 'mustContain: ["required"]']) assert.ok(prompt.includes(marker));
  assert.ok(!prompt.includes('x'.repeat(401)));
});
