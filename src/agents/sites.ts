// Per-site agent config. Replicating the fleet to another site = one more entry here (plus its repo rules).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type AgentSite = {
  short: string;         // dashboard page: /agents/<short>
  label: string;         // heading on the dashboard
  capabilities: string[]; // agents this site runs (the rest are shown as waiting, with `pendingNote`)
  pendingNote?: string;
  lang: 'es' | 'en';     // language topics and posts are written in
  research: { context: string; priority: string }; // site-specific lines of the researcher prompt
  segments: boolean;     // classify queries by customer segment (needs an audience brief with segments)
  listPosts: (repo: string) => { slug: string; title: string }[]; // posts that already exist, so nothing is duplicated
  repo: string;          // the owner's checkout; never edited by agents
  worktree: string;      // agents' own checkout (git worktree of `repo`)
  remote: string;        // pushed to as `<remote> HEAD:main`
  liveBase: string;      // deploy is "live" when the published URL answers 200 here
  blogUrl: (slug: string, enSlug?: string) => string[];  // public URLs a post appears at, ES first
  indexnow?: string[];   // command (in the worktree) taking URLs as extra args
  typecheck: string[];   // command that must pass before anything is committed or pushed
  contentPaths: string[]; // path prefixes a post/fix may touch; anything else is refused
  lowRiskPaths: string[]; // fixer changes confined to these may auto-publish (when autonomy = auto)
  rules: string;         // appended to every writer/fixer prompt
  writerRules: string;   // writer only
};

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

export const AGENT_SITES: Record<string, AgentSite> = {
  'studioyume.mx': {
    short: 'yume', label: 'Yume (studioyume.mx)', capabilities: ['crawl', 'collect', 'analyst', 'researcher', 'writer', 'fixer', 'improver'], lang: 'es', segments: true, listPosts: blogTsPosts,
    research: {
      context: 'Puedes leer el repo (src/content/products.ts, blog.ts) y buscar en la web para validar demanda y qué responde la competencia. El tema debe conectar con productos o servicios reales de Yume. Solo temas que Yume pueda cumplir con lo que de verdad produce.',
      priority: 'Prioridad: al menos 6 de los 8 temas deben hablarle al cliente ideal del brief (bodas primero; luego contenido para wedding/event planners, que son los mejores aliados; luego baby shower, cumpleaños, bautizo, primera comunión, XV años, graduación, regalos o sorpresas de cualquier persona para un ser querido, y eventos de empresa como posadas). Incluye al menos 1 tema pensado para planners. Máximo 1 tema de etiquetas/stickers y solo con ángulo de evento o regalo.',
    },
    repo: '/home/darrkito/Yume', worktree: '/home/darrkito/yume-agent-wt', remote: 'origin', liveBase: 'https://studioyume.mx',
    blogUrl: (s, en) => [`https://studioyume.mx/blog/${s}`, ...(en ? [`https://studioyume.mx/en/blog/${en}`] : [])],
    indexnow: ['node', 'scripts/indexnow.mjs'],
    typecheck: ['node_modules/.bin/tsc', '--noEmit', '-p', '.'],
    contentPaths: ['src/content/blog.ts', 'src/content/blog.en.ts', 'src/content/blog-dulceros.ts', 'src/content/blog-dulceros.en.ts', 'src/lib/i18n.ts'],
    lowRiskPaths: ['src/content/blog.ts', 'src/content/blog.en.ts', 'src/content/blog-dulceros.ts', 'src/content/blog-dulceros.en.ts'],
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

// Dizayn SEO is a static site whose page generator (the partner's tools/aeo/build.py) is not on this machine, so agents may not
// create or rewrite its pages yet: writer, fixer and improver stay off until that generator is available.
AGENT_SITES['dizaynseo.com'] = {
  short: 'dizaynseo', label: 'Dizayn SEO (dizaynseo.com)', capabilities: ['crawl', 'collect', 'analyst', 'researcher'], lang: 'en', segments: false, listPosts: staticPosts,
  pendingNote: "Writer, fixer and post improver are off for this site: its pages come from the partner's generator (tools/aeo/build.py), which is not on this machine. Editing generated files by hand would drop the markdown twins, sitemap, llms.txt and headers. Get the generator, then enable them.",
  repo: '/home/darrkito/dizaynseo', worktree: '/home/darrkito/dizaynseo-agent-wt', remote: 'origin', liveBase: 'https://www.dizaynseo.com',
  blogUrl: (s) => [`https://www.dizaynseo.com/blog/${s}`], typecheck: ['true'], contentPaths: [], lowRiskPaths: [], rules: '', writerRules: '',
  research: {
    context: 'Es una agencia de SEO y sitios web (nearshore, desde Guadalajara) para negocios de Estados Unidos. Puedes leer el repo (blog/*.html, llms.txt) y buscar en la web para validar demanda y qué publica la competencia (thriveagency.com, percepture.com, mapranking.com). Redacta los temas en inglés. Solo temas que Dizayn pueda cumplir y respaldar con su oferta real.',
    priority: 'Prioridad: al menos 5 de los 8 temas deben construir el grupo de contenido de Google Maps y SEO local (la competencia mapranking.com tiene 11 páginas y nosotros 2), y al menos 2 deben cubrir visibilidad en IA (ChatGPT, Perplexity, AI Overviews). Cada tema debe poder responder una pregunta concreta de un dueño de negocio en EE.UU.',
  },
};
