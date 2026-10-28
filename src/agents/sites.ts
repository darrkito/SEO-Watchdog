// Per-site agent config. Replicating the fleet to another site = one more entry here (plus its repo rules).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dizaynPostEdit, dizaynValidate, luvoryPostEdit, luvoryValidate, vexonPostEdit, vexonValidate, type PostOpts } from './hooks.ts';

/** What a post brief is asked to do. `merge` is the existing slug being extended or improved. */
export type BriefOpts = { kind: 'new' | 'merge' | 'improve'; title: string; slug: string; query: string; why: string; merge: string | null; publishAt: string };

export type AgentSite = {
  short: string;         // dashboard page: /agents/<short>
  label: string;         // heading on the dashboard
  capabilities: string[]; // agents this site runs (the rest are shown as waiting, with `pendingNote`)
  pendingNote?: string;
  lang: 'es' | 'en';     // language topics and posts are written in
  research: { context: string; priority: string }; // site-specific lines of the researcher prompt
  segments: boolean;     // classify queries by customer segment (needs an audience brief with segments)
  listPosts: (repo: string) => { slug: string; title: string }[]; // posts that already exist, so nothing is duplicated
  postFiles?: (slug: string) => string[]; // repo-relative files that can hold this post's Spanish/primary text, in search order
  factFiles?: string[]; // repo files whose content is the ONLY authorized source for specs, figures, prices and contact data; handed to the planner
  wholeFile?: boolean; // the post is a whole file (Vexon .mdx), not an object inside a big file
  repo: string;          // the owner's checkout; never edited by agents
  worktree: string;      // agents' own checkout (git worktree of `repo`)
  remote: string;        // pushed to as `<remote> HEAD:main`
  remoteUrl?: string;    // when the owner's remote is HTTPS (no credentials here): fetch and push over this URL instead, set per command, never saved
  liveBase: string;      // deploy is "live" when the published URL answers 200 here
  blogUrl: (slug: string, enSlug?: string) => string[];  // public URLs a post appears at, ES first
  indexnow?: string[];   // command (in the worktree) taking URLs as extra args
  indexnowKey?: string;  // alternative: path (in the worktree) of the IndexNow key file; the watchdog submits the URLs itself
  typecheck: string[];   // command that must pass before anything is committed or pushed
  orderPaths?: string[]; // paths a hybrid work order may touch (the files the model-less steps generate are not listed here)
  contentPaths: string[]; // paths a post/fix may touch; a trailing * means "starts with"; anything else is refused
  lowRiskPaths: string[]; // fixer changes confined to these may auto-publish (when autonomy = auto); same * rule
  regenerateFrom?: string[]; // generated-site repos: on a rebase conflict, re-apply the draft's changes under these paths on the latest main and regenerate
  lintPaths?: string[];   // when set, the copy lint (em-dashes, unverifiable claims) judges only these files: the rest is generated output
  rules: string;         // appended to every writer/fixer prompt
  writerRules: string;   // writer only
  postBrief?: (o: BriefOpts) => string; // the task given to the writer for a new post, a merge or an improvement
  postEdit?: (wt: string, o: PostOpts) => void; // deterministic step after the model edits (regenerate derived files)
  validate?: (wt: string, o: PostOpts) => string[]; // deterministic checks that the post is wired in everywhere; messages go back to the writer
  deployHint?: string;   // shown when the push is not enough to go live (the owner must publish somewhere)
  liveTimeoutMin?: number; // how long to wait for the live check (default 15)
};

/** True when `file` is allowed by `paths` (exact, or prefix when the entry ends with *). */
export const pathAllowed = (paths: string[], file: string): boolean => paths.some((p) => (p.endsWith('*') ? file.startsWith(p.slice(0, -1)) : file === p));

const staticPosts = (repo: string) => {
  const dir = join(repo, 'blog');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => ({ slug: f.replace(/\.html$/, ''), title: readFileSync(join(dir, f), 'utf8').match(/<title>([^<]*)/)?.[1]?.trim() ?? '' })) : [];
};
const blogTsPosts = (repo: string) => {
  const out: { slug: string; title: string }[] = [];
  for (const f of ['blog.ts', 'blog-dulceros.ts']) {
    const p = join(repo, 'src/content', f); if (!existsSync(p)) continue;
    const src = readFileSync(p, 'utf8');
    const slugs = [...src.matchAll(/^\s{4}slug:\s*"([^"]+)"/gm)].map((m) => m[1]), titles = [...src.matchAll(/^\s{4}title:\s*\n?\s*"([^"]+)"/gm)].map((m) => m[1]);
    slugs.forEach((slug, i) => out.push({ slug, title: titles[i] ?? '' }));
  }
  return out;
};
/** Luvory: every post is `slug: "..." , title: "..."` at the top level of src/data/blog-posts.ts (the `en` block's keys are indented deeper). */
export const luvoryPosts = (repo: string) => {
  const p = join(repo, 'src/data/blog-posts.ts');
  if (!existsSync(p)) return [];
  return [...readFileSync(p, 'utf8').matchAll(/^ {4}slug:\s*"([^"]+)",\s*\n {4}title:\s*(["'`])((?:\\.|(?!\2)[^\\])*)\2/gm)].map((m) => ({ slug: m[1], title: m[3].replace(/\\(["'`])/g, '$1') }));
};
/** Vexon: src/content/blog/<slug>.mdx with a single-quoted `title:` in the frontmatter. */
export const mdxPosts = (repo: string) => {
  const dir = join(repo, 'src/content/blog');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.mdx')).map((f) => ({ slug: f.replace(/\.mdx$/, ''), title: (readFileSync(join(dir, f), 'utf8').match(/^title:\s*'(.+)'\s*$/m)?.[1] ?? '').replace(/''/g, "'") })) : [];
};

const header = (o: BriefOpts) => `Tema: "${o.title}" (búsqueda principal: "${o.query}"). Por qué: ${o.why}`;
/** The brief the owner's improver click uses: fix exactly the measured reasons for the low score. */
const improveBrief = (o: BriefOpts, modified: string, langs: string) =>
  `Mejora el post EXISTENTE "${o.merge}" (no cambies su slug, URL ni fecha de publicación; pon ${modified} a ${o.publishAt}). Su puntaje de calidad es bajo por estas razones medidas: ${o.why}. Corrige exactamente eso: amplía con contenido útil y verificable, agrega respuestas directas de 40-60 palabras al inicio de cada H2, FAQ visible con hechos reales, enlaces internos a posts y productos reales, y mejora title/description si están fuera de rango. Conserva lo que ya funciona${langs}.`;

export const AGENT_SITES: Record<string, AgentSite> = {
  'studioyume.mx': {
    factFiles: ['src/content/products.ts'],
    short: 'yume', label: 'Yume (studioyume.mx)', capabilities: ['crawl', 'collect', 'analyst', 'researcher', 'writer', 'fixer', 'improver'], lang: 'es', segments: true, listPosts: blogTsPosts, postFiles: () => ['src/content/blog.ts', 'src/content/blog-dulceros.ts'],
    research: {
      context: 'Puedes leer el repo (src/content/products.ts, blog.ts) y buscar en la web para validar demanda y qué responde la competencia. El tema debe conectar con productos o servicios reales de Yume. Solo temas que Yume pueda cumplir con lo que de verdad produce.',
      priority: 'Prioridad: al menos 6 de los 8 temas deben hablarle al cliente ideal del brief (bodas primero; luego contenido para wedding/event planners, que son los mejores aliados; luego baby shower, cumpleaños, bautizo, primera comunión, XV años, graduación, regalos o sorpresas de cualquier persona para un ser querido, y eventos de empresa como posadas). Incluye al menos 1 tema pensado para planners. Máximo 1 tema de etiquetas/stickers y solo con ángulo de evento o regalo.',
    },
    repo: '/home/darrkito/Yume', worktree: '/home/darrkito/yume-agent-wt', remote: 'origin', liveBase: 'https://studioyume.mx',
    blogUrl: (s, en) => [`https://studioyume.mx/blog/${s}`, ...(en ? [`https://studioyume.mx/en/blog/${en}`] : [])],
    indexnow: ['node', 'scripts/indexnow.mjs'],
    typecheck: ['node_modules/.bin/tsc', '--noEmit', '-p', '.'],
    orderPaths: ['src/content/blog.ts', 'src/content/blog.en.ts', 'src/content/blog-dulceros.ts', 'src/content/blog-dulceros.en.ts', 'src/lib/i18n.ts'],
    contentPaths: ['src/content/blog.ts', 'src/content/blog.en.ts', 'src/content/blog-dulceros.ts', 'src/content/blog-dulceros.en.ts', 'src/lib/i18n.ts'],
    lowRiskPaths: ['src/content/blog.ts', 'src/content/blog.en.ts', 'src/content/blog-dulceros.ts', 'src/content/blog-dulceros.en.ts'],
    postBrief: (o) => o.kind === 'improve' ? improveBrief(o, 'modifiedAt', ' y aplica los cambios en ES y en EN')
      : o.kind === 'merge' ? `${header(o)}\nEste tema se FUSIONA: amplía el post existente "${o.merge}" (secciones/FAQ nuevas, actualiza modifiedAt a ${o.publishAt}), no crees un post nuevo.`
      : `${header(o)}\nCrea un post NUEVO con slug "${o.slug}", publishedAt "${o.publishAt}", en ES (blog.ts) y EN (blog.en.ts) + entrada en BLOG_SLUG_EN. Si el tema es de dulceros, usa los archivos blog-dulceros*.`,
    rules: `Yume rules (hard limits, from the owner):
- Read CLAUDE.md and AGENTS.md in this repo first and follow them.
- Spanish (Mexico), "tú", clear and concrete.
- NEVER use em-dashes (—) in new copy. Use commas, periods or colons.
- Never type a price, shipping time, branch or production day by hand: use priceOf()/tierPriceRows and the constants already used in src/content/blog.ts. When you mention a price, lead with "Primeras 100 piezas"; above 100 pieces it is "precio mayoreo".
- Do NOT state any physical spec, material, certification, customer result or statistic unless it is in this repo or in a primary source you actually opened. If you cannot verify a fact, leave it out.
- Do not touch checkout, payments (Mercado Pago), transactional emails, redirects, routes, vercel.json or env vars.`,
    writerRules: `Writer rules:
- ES is canonical (src/content/blog.ts); the EN version goes in src/content/blog.en.ts with its slug added to BLOG_SLUG_EN in src/lib/i18n.ts. Copy the structure of an existing post exactly.
- Cite in \`sources\` only primary sources you opened. If the topic overlaps an existing post, extend that post instead of creating a competing one.
- description goes through fitDescription (<=160 chars); set metaTitle when title would exceed ~60 chars. relatedProductSlugs must exist in src/content/products.ts; relatedBlogSlugs must be existing posts of the same language.
- GEO structure: each H2 section opens with a direct 40-60 word answer; add a visible FAQ (real facts only) and Fuentes when you cite anything.
- Edit only src/content/blog*.ts files and BLOG_SLUG_EN in src/lib/i18n.ts.`,
  },
};

// Luvory deploys from Lovable: a push to main is NOT enough to go live (2026-10-02: production stayed on the old build two days after a push, until the
// owner pressed Publish). So the live check waits long, and the alert says what the owner has to do.
AGENT_SITES['luvory.com.mx'] = {
  factFiles: ['src/data/pricing.ts', 'src/data/business.ts'],
  short: 'luvory', label: 'Luvory (luvory.com.mx)', capabilities: ['crawl', 'collect', 'analyst', 'researcher', 'writer', 'fixer', 'improver'], lang: 'es', segments: false, listPosts: luvoryPosts, postFiles: () => ['src/data/blog-posts.ts'],
  research: {
    context: 'Luvory es una empresa real de renta de baños portátiles de lujo, remolques sanitarios y baños VIP para bodas, conciertos, festivales, eventos deportivos y corporativos en Guadalajara, Zapopan, Tlaquepaque, Tlajomulco y Tequila. Puedes leer el repo (src/data/blog-posts.ts, src/data/pricing.ts, PLAN-trafico-ventas.md, SEO.md) y buscar en la web para validar demanda y qué publica la competencia. Solo temas que Luvory pueda cumplir y respaldar con su oferta real.',
    priority: 'Prioridad (plan de tráfico del 2026-10-19): la búsqueda total del nicho en Guadalajara es chica, así que prefiere temas que ayuden a quienes DECIDEN el evento: wedding planners, haciendas y venues, productoras de conciertos y festivales, organizadores de eventos corporativos y de obra (cuántos baños, normas y permisos, logística, costos, temporada: posadas y fin de año). Al menos 5 de los 8 temas con modificador local (Guadalajara, Zapopan, Tequila, Tlajomulco, Tlaquepaque). No propongas crónicas de eventos que ya pasaron salvo guías útiles de logística, y no dupliques los posts de eventos ya publicados.',
  },
  repo: '/home/darrkito/luvory-genius-generator', worktree: '/home/darrkito/luvory-agent-wt', remote: 'origin', liveBase: 'https://luvory.com.mx',
  blogUrl: (s, en) => [`https://luvory.com.mx/blog/${s}`, ...(en ? [`https://luvory.com.mx/en/blog/${en}`] : [])],
  indexnowKey: 'public/e0edb2f799db4fb3967c9fa8023a5558.txt',
  typecheck: ['sh', '-c', 'node_modules/.bin/tsc --noEmit -p . && node_modules/.bin/vitest run src/data'],
  orderPaths: ['src/data/blog-posts.ts', 'src/lib/i18n.ts', 'public/sitemap.xml'],
  contentPaths: ['src/data/blog-posts.ts', 'src/data/blog-index.json', 'src/lib/i18n.ts', 'public/sitemap.xml'],
  lowRiskPaths: ['src/data/blog-posts.ts', 'src/data/blog-index.json'],
  deployHint: 'Luvory se publica desde Lovable: el cambio ya está en main, pero hay que pulsar Publish en Lovable para que salga en vivo.',
  liveTimeoutMin: 720,
  postEdit: luvoryPostEdit, validate: luvoryValidate,
  postBrief: (o) => o.kind === 'improve' ? improveBrief(o, 'dateModified', ', y aplica los cambios en ES y en su bloque `en`; actualiza también el <lastmod> de sus dos entradas en public/sitemap.xml')
    : o.kind === 'merge' ? `${header(o)}\nEste tema se FUSIONA: amplía el post existente "${o.merge}" en src/data/blog-posts.ts (secciones/FAQ nuevas en ES y en su bloque \`en\`), pon dateModified a ${o.publishAt} y actualiza el <lastmod> de sus dos entradas en public/sitemap.xml. No crees un post nuevo.`
    : `${header(o)}\nCrea un post NUEVO con slug "${o.slug}". Haz TODOS estos cambios:
1) src/data/blog-posts.ts: agrega al FINAL del arreglo blogPosts un objeto con la forma del último post (slug, title, metaTitle solo si title pasa de 60 caracteres, excerpt, date "${o.publishAt}", dateModified "${o.publishAt}", category de las existentes, image "", content en markdown) y su bloque \`en\` completo (title, excerpt, category, content: la traducción íntegra al inglés, no un resumen).
2) src/lib/i18n.ts: agrega "/blog/${o.slug}": "/blog/<slug-en-inglés-en-kebab-case>" a EN_SLUG_MAP.
3) public/sitemap.xml: agrega dos bloques <url> (ES y EN) copiando exactamente el formato de un post existente (lastmod ${o.publishAt}, hreflang es/en/x-default); omite <image:image> si el post no tiene imagen propia.`,
  rules: `Reglas de Luvory (límites duros del dueño):
- Lee primero CLAUDE.md y SEO.md de este repo y síguelos.
- Español de México, trato de "tú", claro y concreto. Es un negocio real de renta de baños portátiles de lujo para eventos, no una demo.
- NUNCA uses rayas largas (—) en texto nuevo. Usa comas, puntos o dos puntos.
- No inventes reseñas, eventos atendidos, resultados, cifras, premios ni certificaciones. "Más de 100 eventos atendidos" es un dato aprobado por el dueño: no lo infles ni lo amplíes. No cites a nadie que no esté en src/data/google-reviews.ts.
- No afirmes que Luvory estuvo en un evento que no tenga ya su post publicado en src/data/blog-posts.ts.
- No escribas precios, horarios ni teléfonos a mano: los precios salen de src/data/pricing.ts y el WhatsApp de src/data/business.ts (copia el enlace de WhatsApp de un post existente tal cual). Si no puedes verificar un dato en este repo o en una fuente primaria que abriste, déjalo fuera.
- No toques src/routes, src/components, estilos, google-reviews.ts, business.ts ni pricing.ts.`,
  writerRules: `Reglas del redactor:
- Los posts viven en src/data/blog-posts.ts. ES es el canónico y el bloque \`en\` lleva la traducción completa con su propio slug en EN_SLUG_MAP de src/lib/i18n.ts. Copia la estructura de un post existente (si tiene faqJsonLd, copia cómo lo arma).
- excerpt de 110 a 156 caracteres. Markdown con ## para los H2: cada H2 abre con una respuesta directa de 40 a 60 palabras. Agrega preguntas frecuentes con hechos reales y, si citas algo, una sección "Fuentes" con enlaces a páginas que abriste.
- Los enlaces internos del contenido usan rutas canónicas en español (/blog/..., /banos-moviles-para-eventos, /remolques); NUNCA escribas hrefs que empiecen con /en/ (langPath los traduce).
- Cierra con el enlace de cotización por WhatsApp copiado de un post existente y 2 o 3 enlaces a las páginas que venden (/remolques, /banos-moviles-para-eventos, /calculadora-banos-portatiles o la que corresponda).
- Si el tema se parece a un post existente, amplíalo en lugar de crear uno que compita. No cambies títulos de portada, VIP, lujo ni móviles (ventana de canibalización hasta 2026-11-05).
- Solo edita src/data/blog-posts.ts, src/lib/i18n.ts (EN_SLUG_MAP) y public/sitemap.xml. src/data/blog-index.json se regenera solo.`,
};

// Vexon (Astro): the owner's checkout has an HTTPS remote and this machine has no HTTPS credentials, so agents use the SSH URL (set per command).
AGENT_SITES['vexonmexico.com.mx'] = {
  factFiles: ['src/data/modelos.ts', 'src/lib/site.ts', 'src/data/faqs.ts'],
  short: 'vexon', label: 'Vexon (vexonmexico.com.mx)', capabilities: ['crawl', 'collect', 'analyst', 'researcher', 'writer', 'fixer', 'improver'], lang: 'es', segments: false, listPosts: mdxPosts, postFiles: (slug) => [`src/content/blog/${slug}.mdx`], wholeFile: true,
  pendingNote: 'Search Console is not connected for this site yet (no service account has access to vexonmexico.com.mx), so the analyst and the blog score have no Google data until you add one.',
  research: {
    context: 'Vexon by Capelton renta oficinas móviles (línea VX, de 3 a 10 m) para obra en Guadalajara, Zapopan y la ZMG. Puedes leer el repo (src/data/modelos.ts, src/data/faqs.ts, src/data/soluciones.ts, src/content/blog) y buscar en la web para validar demanda y qué publica la competencia (cvsolucionesmoviles.com, atcoespaciomovil.com, remobras.mx). Solo temas que Vexon pueda cumplir con sus modelos reales.',
    priority: 'Prioridad: temas que responden una duda concreta de un residente de obra, de compras de una constructora, de un negocio en remodelación o de una planta (qué oficina necesito, requisitos, costos y qué incluye una renta, instalación, comparativas con caseta o contenedor, checklist de obra). Al menos 5 de los 8 temas con modificador local (Guadalajara, Zapopan, ZMG, El Salto, Tlajomulco). No propongas temas de precios, plazos o cobertura que el dueño aún no ha confirmado.',
  },
  repo: '/home/darrkito/VexonWeb', worktree: '/home/darrkito/vexon-agent-wt', remote: 'agent', remoteUrl: 'git@github.com:darrkito/VexonWeb.git', liveBase: 'https://vexonmexico.com.mx',
  blogUrl: (s) => [`https://vexonmexico.com.mx/blog/${s}`],
  indexnow: ['node', 'scripts/indexnow.mjs'],
  // `astro check` has 2 old errors in astro.config.mjs (siteLastmod); only errors anywhere else count.
  typecheck: ['sh', '-c', `out=$(node_modules/.bin/astro check 2>&1 | sed 's/\\x1b\\[[0-9;]*m//g'); echo "$out" | grep -q '^Result (' || { echo "$out" | tail -5; exit 1; }; bad=$(echo "$out" | grep -E ' - error ' | grep -v '^astro.config.mjs'); [ -z "$bad" ] || { echo "$bad"; exit 1; }`],
  orderPaths: ['src/content/blog/*'],
  contentPaths: ['src/content/blog/*', 'public/og/blog-*'],
  lowRiskPaths: ['src/content/blog/*', 'public/og/blog-*'],
  postEdit: vexonPostEdit, validate: vexonValidate,
  postBrief: (o) => o.kind === 'improve' ? improveBrief(o, 'updated', ' (los cambios son solo en español)')
    : o.kind === 'merge' ? `${header(o)}\nEste tema se FUSIONA: amplía el post existente "${o.merge}" en src/content/blog/${o.merge}.mdx (secciones/FAQ nuevas), pon updated a ${o.publishAt}, no crees un post nuevo.`
    : `${header(o)}\nCrea un post NUEVO en src/content/blog/${o.slug}.mdx con date ${o.publishAt}.`,
  rules: `Reglas de Vexon (límites duros del dueño):
- Lee primero README.md de este repo y síguelo.
- Español de México, trato de "tú", claro y concreto, para residentes de obra, compras de constructoras y negocios en remodelación. Es renta de oficinas móviles (línea VX) en Guadalajara, Zapopan y la ZMG.
- NUNCA uses rayas largas (—) en texto nuevo; en una tabla escribe "No aplica" o "-".
- Las especificaciones de cada modelo (medidas, personas, mesas, lámparas, clima) salen SOLO de src/data/modelos.ts; teléfono, dirección y horario de src/lib/site.ts. No escribas a mano ninguno que no esté ahí.
- No inventes precios, plazo mínimo de renta, tiempos de entrega, cobertura, qué incluye el traslado, la instalación o el mantenimiento, ni normas o permisos: esos puntos están "POR CONFIRMAR" con el dueño (src/data/faqs.ts). Si hace falta mencionarlos, di que se confirman en la cotización por WhatsApp. Para normatividad cita solo fuentes primarias que abriste.
- No toques src/pages, src/components, src/data, src/lib, vercel.json ni astro.config.mjs.`,
  writerRules: `Reglas del redactor:
- Cada post es src/content/blog/<slug>.mdx con el frontmatter de los demás: title entre 25 y 62 caracteres (entre comillas simples), description entre 80 y 156, date AAAA-MM-DD, category exactamente una de Guías, Obra, Remodelación, Normatividad, Casos; model con un slug que exista en src/data/modelos.ts (p. ej. 'vx-6m'); persona opcional (residente, compras, remodelacion, planta); faqs con 3 o más q/a reales.
- Después del frontmatter va \`import CtaInline from '../../components/CtaInline.astro';\` y el cuerpo con ## para los H2; usa <CtaInline /> una vez a mitad del texto. Cada H2 abre con una respuesta directa de 40 a 60 palabras. Enlaza al menos 3 veces: al modelo relevante (/oficinas-moviles/<modelo>), a /soluciones/<persona> y a otro post existente.
- Al ampliar un post existente pon updated con la fecha de hoy y no cambies su slug ni su date.
- Solo español (no hay versión en inglés). Solo edita archivos dentro de src/content/blog/; la imagen social se genera sola.`,
};

// Dizayn SEO is a static site built from _src/*.py by the partner's two-step build. The second step (tools/aeo/build.py) is not on this machine,
// so src/agents/dizayn/prep.py stands in for it. It is proven by replay (selftest.py regenerates a committed post byte for byte), which is why the
// writer and improver are on here. The fixer stays off: it edits arbitrary files, and nothing replays those.
AGENT_SITES['dizaynseo.com'] = {
  factFiles: ['_src/config.py'],
  short: 'dizaynseo', label: 'Dizayn SEO (dizaynseo.com)', capabilities: ['crawl', 'collect', 'analyst', 'researcher', 'writer', 'improver'], lang: 'en', segments: false, listPosts: staticPosts, postFiles: () => ['_src/posts.py', '_src/posts_funnel.py', '_src/posts_agent.py'],
  pendingNote: "Posts are written into _src/posts_agent.py (or the post's own file when improving) and the generated files are rebuilt by dizayn/prep.py, a stand-in for the partner's missing generator that is checked against the committed output. The fixer is off for this site.",
  repo: '/home/darrkito/dizaynseo', worktree: '/home/darrkito/dizaynseo-agent-wt', remote: 'origin', liveBase: 'https://www.dizaynseo.com',
  blogUrl: (s) => [`https://www.dizaynseo.com/blog/${s}`], typecheck: ['true'],
  indexnowKey: 'ffea521f6f9644fc9a526c6c23c1cdb4.txt',
  orderPaths: ['_src/posts_agent.py', '_src/posts.py', '_src/posts_funnel.py'],
  contentPaths: ['_src/posts_agent.py', '_src/posts.py', '_src/posts_funnel.py', 'blog.html', 'blog/*', 'md/*', 'sitemap.xml', 'llms.txt', 'llms-full.txt', 'api/_index.js', 'agent-tools.js', 'vercel.json'],
  lowRiskPaths: [],
  regenerateFrom: ['_src'],
  lintPaths: ['_src/posts_agent.py', '_src/posts.py', '_src/posts_funnel.py'],
  postEdit: dizaynPostEdit, validate: dizaynValidate,
  postBrief: (o) => o.kind === 'improve' ? `Mejora el post EXISTENTE "${o.merge}" (no cambies su slug ni su URL; la fecha de actualización del sitio es global). Su puntaje de calidad es bajo por estas razones medidas: ${o.why}. Corrige exactamente eso, en inglés: amplía con contenido útil y verificable, agrega respuestas directas de 40 a 75 palabras al inicio de cada H2, enlaces internos reales y mejora title/desc si están fuera de rango. El post vive en _src/posts.py o _src/posts_funnel.py (busca su slug): edita solo su title, desc, lede y body. Conserva lo que ya funciona.`
    : o.kind === 'merge' ? `${header(o)}\nEste tema se FUSIONA: amplía el post existente "${o.merge}" (busca su slug en _src/posts.py o _src/posts_funnel.py): secciones nuevas con su respuesta directa, sin crear un post nuevo. Escribe en inglés.`
    : `${header(o)}\nCrea un post NUEVO en inglés: agrega UN dict al final de POSTS en _src/posts_agent.py con slug "${o.slug}", stage (unaware|problem|solution|product), cat (una categoría que ya use otro post), title de 25 a 62 caracteres con la palabra clave al inicio, h1, desc de 80 a 156 caracteres, lede (2 frases), mins (entero: minutos de lectura) y body en HTML. Las fuentes van como L("Nombre (fecha)", "https://...") en S, las tablas como T([...], [[...]]) en TABLES, y en el body se usan como %(clave)s. Copia la forma de un post existente de _src/posts_funnel.py. No edites nada más: la página, el gemelo markdown, el sitemap, llms.txt y demás archivos generados los reconstruye prep.py solo.`,
  rules: `Reglas de Dizayn SEO (límites duros del dueño, 2026-10-27):
- Lee primero _src/posts_agent.py y un post parecido de _src/posts_funnel.py y copia su estructura.
- Escribe en inglés claro y directo, para el dueño de un negocio pequeño o mediano de EE.UU. Mercado: solo Estados Unidos.
- NUNCA uses rayas largas (—) en texto nuevo. Usa comas, puntos o dos puntos.
- Dizayn tiene su sede en San Antonio, Texas. NO menciones México, "nearshore" ni "cuesta menos por la ubicación del equipo". No hables de pagos en cripto.
- Precios y condiciones: usa SOLO estos y solo cuando el tema lo pida: Starter Site $540 y Complete Site $1,200 (pago único); plan mensual Basic $99 y Complete $450 (incluye SEO y búsqueda con IA), mes a mes, sin mínimo; garantía de 90 días solo en el plan Complete (si las solicitudes no suben, el mes 4 es gratis). El dueño los marcó como hipótesis: no inventes otros precios, descuentos, plazos ni resultados de clientes que no estén ya publicados en el sitio.
- Cifras de terceros solo con una fuente primaria que abriste, citada con L(...) y enlazada. Si no puedes verificarlo, déjalo fuera.
- No toques config.py, lib.py, p_*.py ni ningún archivo generado (blog/, md/, sitemap.xml, llms*.txt, vercel.json, api/): prep.py los reconstruye.`,
  writerRules: `Reglas del redactor:
- Cada H2 es <h2 id="clave-corta"> y abre con una respuesta directa de 40 a 75 palabras; las comparaciones van en tablas T(...); cada dato con cifra lleva su fuente.
- Al menos 3 enlaces internos con ancla descriptiva (1 a 5 palabras) en el body: uno a /services/seo, /services/ai-search o /pricing, otro a /ai-visibility-checker y otro a un post existente (/blog/<slug>). Termina con <div class="callout"><p>...</p></div> que lleve al lector al paso siguiente.
- El tema ya fue validado como pregunta real de un dueño de negocio: respóndela completa y concreta, sin relleno ni promesas de posición.
- Si el tema se parece a un post existente, amplíalo en lugar de crear uno que compita.
- Solo edita _src/posts_agent.py (post nuevo) o el archivo donde vive el post (mejora).`,
  research: {
    context: 'Es una agencia de sitios web y SEO con sede en San Antonio, Texas, que vende SOLO a negocios de Estados Unidos (nada de México ni de "nearshore"). Oferta pública: Starter Site $540, Complete Site $1,200, planes mensuales $99 (Basic) y $450 (Complete, incluye SEO y búsqueda con IA), mes a mes. Puedes leer el repo (blog/*.html, llms.txt) y buscar en la web para validar demanda y qué publica la competencia (thriveagency.com, percepture.com, mapranking.com). Redacta los temas en inglés. Solo temas que Dizayn pueda cumplir y respaldar con su oferta real.',
    priority: 'Prioridad: al menos 5 de los 8 temas deben construir el grupo de contenido de Google Maps y SEO local (la competencia mapranking.com tiene 11 páginas y nosotros 2), y al menos 2 deben cubrir visibilidad en IA (ChatGPT, Perplexity, AI Overviews). Cada tema debe poder responder una pregunta concreta de un dueño de negocio en EE.UU. No propongas temas de contratar una agencia en México ni de ahorrar por la ubicación del equipo.',
  },
};
