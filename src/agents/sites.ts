// Per-site agent config. Replicating the fleet to another site = one more entry here (plus its repo rules).
export type AgentSite = {
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

export const AGENT_SITES: Record<string, AgentSite> = {
  'studioyume.mx': {
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
