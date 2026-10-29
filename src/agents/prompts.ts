import type { WorkOrder } from './orders.ts';

export type PlanInput = {
  brief: string;
  miniAudit: string;
  rules: string;
  writerRules: string;
  facts: { file: string; text: string }[];
  guides: { file: string; text: string }[];
  audience: string;
  example: string;
  current: string;
  ranges: { file: string; anchor?: string; endAnchor?: string; whole: boolean }[];
  insertPoints: { label: string; file: string; do: string; anchor?: string; note?: string }[];
  allowedPaths: string[];
};

const INTRO = `Eres el CEREBRO de un equipo de dos. Tú investigas, decides y escribes. Otro agente (Codex) solo ejecuta tu orden al pie de la letra: no piensa, no corrige, no mejora. Por eso tu orden tiene que ser exacta desde el primer intento.

NO tienes acceso a los archivos del repo: no puedes leerlos ni editarlos. Tienes WebSearch y WebFetch para investigar. Todo lo que necesitas del repo está en este mensaje.`;

const POST_META = `{ "slug": "...", "enSlug": "... (solo si el sitio tiene versión en inglés con otro slug)", "claims": [ { "claim": "afirmación factual del post", "source": "archivo del repo o URL que abriste" } ] }`;
const FIXER_META = `{ "fixed": [ids], "skipped": [ { "id": n, "reason": "..." } ] }`;

const response = (meta: string): string => `CÓMO RESPONDER: solo un objeto JSON, sin texto antes ni después, con esta forma:
{
  "analysis": "2 a 5 frases: qué encontraste, qué decidiste y por qué",
  "title": "título corto de la orden",
  "meta": ${meta},
  "steps": [ { "n": 1, "file": "ruta/relativa", "do": "create | replace | replace-range | insert-after | insert-before | append | delete", "anchor": "...", "endAnchor": "...", "text": "...", "note": "..." } ],
  "mustContain": [ "frases exactas que deben quedar en el resultado: el título, la descripción y cada encabezado nuevo" ],
  "forbiddenPaths": [ ],
  "doneWhen": "una frase"
}`;

const OPERATIONS = `OPERACIONES
- create: escribe el archivo completo (lo reemplaza si existe). Lleva "text" con el archivo entero y no lleva anchor.
- replace: cambia anchor por text.
- replace-range: cambia todo desde anchor hasta endAnchor (sin incluir endAnchor) por text.
- insert-after / insert-before: pone text pegado después o antes de anchor.
- append: agrega text al final del archivo (no lleva anchor; el text trae su propio salto de línea inicial si hace falta).
- delete: borra anchor.`;

const orderRules = (paths: string): string => `REGLAS DE LA ORDEN (si alguna falla, Codex se detiene y se pierde el intento)
1. Cada anchor debe aparecer EXACTAMENTE UNA VEZ en el archivo en ese momento. Cópialo de los puntos verificados, del ejemplo o del texto actual, carácter por carácter, con sus espacios y saltos de línea.
2. "text" va literal y completo: sin "...", sin comentarios, sin resúmenes, sin "igual que antes". Todo el texto final del post va escrito.
3. Solo puedes tocar estas rutas: ${paths}
4. El orden de los pasos importa: cada paso ve el resultado de los anteriores.
5. En JSON, los saltos de línea van como \\n y las comillas dobles como \\". Verifica que el JSON sea válido.
6. mustContain: pon el título, la descripción y cada encabezado nuevo, tal como quedan escritos.
7. Antes de responder, revisa uno por uno cada anchor contra el texto que te di. Si un anchor no está en este mensaje, no lo inventes: usa otro paso que sí tenga anchor verificado.
8. Toda afirmación factual del texto (cifras, fechas, temporadas, normas, comparaciones) va en meta.claims con su fuente: una URL que abriste o un archivo del repo. Si no tienes fuente, quita la afirmación del texto en lugar de escribirla. El ejecutor y el revisor ven esa lista.`;

const sections = (parts: string[]): string => parts.filter((part) => part !== '').flatMap((part, n) => n ? ['', part] : [part]).join('\n');
const siteRules = (rules: string, writerRules = ''): string => rules || writerRules
  ? [`REGLAS DEL SITIO (límites duros)`, ...[rules, writerRules].filter((part) => part !== '')].join('\n')
  : '';

const guideSection = (guides: { file: string; text: string }[]): string => guides.length ? [
  'GUÍAS DEL REPO (las escribió el dueño para este proyecto; síguelas. Codex no las lee: tú sí):',
  ...guides.flatMap((guide) => [`=== ${guide.file} ===`, guide.text]),
].join('\n') : '';

export function planPrompt(i: PlanInput): string {
  return sections([
    INTRO,
    i.brief ? [`TU TAREA`, i.brief].join('\n') : '',
    i.miniAudit,
    siteRules(i.rules, i.writerRules),
    i.facts.length ? [
      'DATOS AUTORIZADOS DEL REPO (única fuente permitida para medidas, especificaciones, cifras, precios, teléfonos y direcciones; si un dato no está aquí ni en una fuente primaria que abriste en la web, NO lo escribas):',
      ...i.facts.flatMap((fact) => [`=== ${fact.file} ===`, fact.text]),
    ].join('\n') : '',
    guideSection(i.guides),
    i.audience,
    i.example ? [`EJEMPLO REAL DE UN POST DE ESTE SITIO (copia su forma exacta, campo por campo, con el mismo orden y las mismas comillas):`, `<<<EJEMPLO`, i.example, `EJEMPLO>>>`].join('\n') : '',
    i.current ? [`TEXTO ACTUAL DEL POST (esto es lo que vas a reescribir o ampliar):`, `<<<ACTUAL`, i.current, `ACTUAL>>>`].join('\n') : '',
    i.ranges.length ? [
      `DÓNDE ESTÁ EL POST (rangos ya verificados; para reescribirlo usa exactamente estos pasos "replace-range" con este anchor y este endAnchor, copiados tal cual, o "create" con el archivo completo cuando whole sea true):`,
      ...i.ranges.map((r) => [`- ${r.file} | whole=${r.whole}`, ...(r.anchor !== undefined ? [`anchor=${JSON.stringify(r.anchor)}`] : []), ...(r.endAnchor !== undefined ? [`endAnchor=${JSON.stringify(r.endAnchor)}`] : [])].join(' ')),
    ].join('\n') : '',
    i.insertPoints.length ? [
      `DÓNDE METER UN POST NUEVO (puntos ya verificados; cada anchor existe exactamente una vez; cópialo tal cual):`,
      ...i.insertPoints.map((p) => [`- ${p.label}`, p.file, p.do, ...(p.anchor !== undefined ? [`anchor=${JSON.stringify(p.anchor)}`] : []), ...(p.note ? [p.note] : [])].join(' | ')),
    ].join('\n') : '',
    response(POST_META), OPERATIONS, orderRules(i.allowedPaths.join(', ')),
  ]);
}

export function reviewPrompt(i: { rules: string; writerRules: string; audience: string; orders: WorkOrder[]; diff: string }): string {
  return sections([
    `Eres el REVISOR. Otro agente (Codex) ejecutó una orden que tú o un colega escribieron. Decide si el trabajo quedó bien. No tienes acceso al repo: solo ves la orden y el diff con contexto.`,
    siteRules(i.rules, i.writerRules),
    i.audience,
    ['ÓRDENES EJECUTADAS (en este orden; el DIFF es el resultado ACUMULADO de todas)', ...i.orders.flatMap((order, index) => [`ORDEN ${index + 1} (${index === 0 ? 'original' : 'corrección'}): ${order.title}: ${order.doneWhen || 'todos los pasos aplicados'}`, ...order.steps.map((s) => `${s.n}. ${s.do} en ${s.file}`)])].join('\n'),
    (() => {
      const claims = new Map<string, { claim: string; source: string }>();
      for (const order of i.orders) for (const item of order.claims ?? []) claims.set(JSON.stringify([item.claim, item.source]), item);
      return claims.size ? ['AFIRMACIONES VERIFICADAS POR EL PLANIFICADOR (cada una con la fuente que abrió; no las des por falsas sin una razón concreta):', ...[...claims.values()].map((item) => `- ${item.claim.slice(0, 300)} [fuente: ${item.source.slice(0, 300)}]`)].join('\n') : '';
    })(),
    [`DIFF (con contexto)`, i.diff.slice(0, 60000) + (i.diff.length > 60000 ? '\n[diff cut]' : '')].join('\n'),
    `QUÉ REVISAR, en este orden
1. ¿Cumple CADA regla del sitio? (rayas largas nuevas, datos o cifras inventados, precios, ubicaciones, promesas que el dueño no aprobó, enlaces rotos o con formato incorrecto).
2. ¿Quedó exactamente lo que decía la orden, sin cambios de más ni de menos? ¿La sintaxis del archivo es válida (comillas, comas, llaves, escapes)?
3. ¿El contenido es correcto, útil y claro para el lector, y cumple la estructura pedida (respuestas directas de 40 a 75 palabras bajo cada encabezado, FAQ real, enlaces internos)?
Sé específico: cada problema dice QUÉ archivo y QUÉ texto, POR QUÉ está mal y CÓMO debe quedar. No apruebes con dudas.`,
    `CÓMO RESPONDER: solo un objeto JSON:
{
  "ok": true | false,
  "problems": [ "archivo + texto exacto + por qué está mal + cómo debe quedar" ],
  "changeOrder": null | { "title": "...", "steps": [ ...mismo formato de pasos que la orden original... ], "mustContain": [ ], "forbiddenPaths": [ ], "doneWhen": "..." }
}
Si ok es true, problems va vacío y changeOrder es null. Si ok es false, escribe en changeOrder los pasos exactos que corrigen TODOS los problemas sobre el estado ACTUAL de los archivos (cada anchor debe aparecer exactamente una vez; cópialo del diff). Si no puedes escribir los pasos con certeza, deja changeOrder en null y describe cada corrección con todo detalle en problems.`,
  ]);
}

export function scoutPrompt(findings: { id: number; rule: string; subject: string; message: string }[], rules: string): string {
  return [
    `You are a scout, not a fixer. Read-only. Do not edit anything, do not run installs or network commands, do not propose fixes.
For EACH finding below, locate the code or content responsible in this repository and report it.
Output format, one block per finding, nothing else:
FINDING <id>
FILE: <repo-relative path>
LINES: <first>-<last>
EXCERPT:
<the exact 12 to 25 lines around the problem, each prefixed by its line number and a colon>
WHY: <one sentence: what in these lines causes the finding>
If you cannot find it, write \`FINDING <id>\` then \`NOT FOUND: <reason>\`.`,
    ...(rules ? [`Files that must never be reported or opened beyond a first look: ${rules}`] : []),
    '', `FINDINGS`,
    ...findings.map((f) => `${f.id} [${f.rule}] ${f.subject}: ${f.message}`),
  ].join('\n');
}

export function fixerPlanPrompt(i: { siteUrl: string; findings: { id: number; rule: string; severity: string; subject: string; message: string }[]; scout: string; rules: string; guides: { file: string; text: string }[]; audience: string; allowedPathsNote: string; picked: boolean }): string {
  return sections([
    INTRO,
    [`TU TAREA`,
      `Eres el agente corrector SEO de ${i.siteUrl}. Estos son los hallazgos abiertos del Watchdog (datos reales):`,
      JSON.stringify(i.findings),
      i.picked ? `El dueño eligió estos hallazgos: corrige TODOS los que se puedan arreglar con seguridad, empezando por los críticos.` : `Corrige hasta 5 de ellos, empezando por los críticos.`,
      `Un explorador (solo lectura) ya localizó el código de cada hallazgo. Este es su informe, con los números de línea y el texto exacto:`,
      `<<<INFORME`, i.scout.slice(0, 40000), `INFORME>>>`,
      `Cambios mínimos, uno por hallazgo, sin refactors. Si un hallazgo no se puede arreglar con seguridad (falta un dato que no tienes, o toca pagos, checkout, emails o rutas), sáltalo y dilo en "analysis". Respeta el posicionamiento de la marca: solo se corrige lo técnico o SEO.`,
    ].join('\n'),
    siteRules(i.rules), guideSection(i.guides), i.audience, response(FIXER_META), OPERATIONS, orderRules(i.allowedPathsNote),
  ]);
}
