# Continue here (written 2026-10-20)

This is the pickup point for the next session. The long-term roadmap is in [PLAN.md](PLAN.md); this file is what's left to finish **Phase 4a (competitor discovery)** and what comes after.

## Where things stand

| Phase | Status |
|---|---|
| 0-1 Watchdog core (crawl, snapshot, diff, findings, alerts) | ✅ done, pushed (`95e63cf`) |
| 2 Dashboard (`npm run dashboard` → http://127.0.0.1:4321) | ✅ done, pushed (`2954229`) |
| 4a Competitor discovery | 🟡 **engine, Competitors tab and tests done (2026-10-20)**; pending: `.env` key (+ Serper), discovery on the other 4 sites + owner review |

Separate fix on the blockchains.click site: the NFT pages' noindex fallback is fixed and live (BetweenChain `7788478`, `lib/nft/metadataFallback.ts`). It was verified with 0 noindex pages in 2 parallel crawls.

## What 4a already does (working)

- **Engine:** `src/competitors.ts` runs `discover(db, site)`:
  1. Builds a site profile from the latest crawl: JSON-LD business data, page titles, homepage text, market.
  2. Picks keywords. With Search Console connected, the LLM may only **select** from the real queries, and that is verified in code; it generates queries only when fewer than 6 qualify.
  3. Runs a localized search per keyword.
  4. Scores visibility with a CTR curve × keyword demand.
  5. Filters out platforms and directories, then has the LLM verify the top 12 against each candidate's real homepage text. A verdict whose quote isn't actually on the page is rejected (anti-hallucination guard).
  6. On the first discovery, the top 3 are activated automatically as competitor sites (`kind='competitor'`, `parent_site_id`, 300-page limit).
- **Search Console** (`src/gsc.ts`): service-account JWT with zero dependencies. The property (URL-prefix or `sc-domain:`) is auto-detected from the key. Connected for luvory, studioyume, dizayn and blockchains via `npm run wd -- gsc <site> <key.json>`. Vexon has no key.
- **LLM** (`src/llm.ts`): official `@anthropic-ai/sdk` (the only npm dependency), model `claude-sonnet-5-5` by default since 2026-10-20, overridable with `WATCHDOG_MODEL`. Test on 4 sites: Sonnet $0.06/site vs Haiku $0.0035; Sonnet rejected wrong-customer rivals Haiku accepted (basic vs luxury toilets, industrial vs retail labels), so the owner chose Sonnet. Haiku needs SERPER_API_KEY (no `web_search_20260209`) and gets no server-side fallback; Opus 5.5 / Sonnet 5.5 / Fable 5.1 send `fallbacks: "default"`. It produces structured JSON via `output_config.format`, and runs web search via `web_search_20260209` with `user_location`.
- **CLI:** `discover <site>`, `competitors <site>`, `gsc <site> <key>`.
- **Live result on Luvory (discovery #1, cost $1.02):**
  - Watching saniglobal.com.mx, berentoilet.com and blueplanetgdl.com.mx.
  - Alternatives: sanitarios-portatiles.com.mx, sanitariosportatileseventos.com.
  - Directory: bodas.net.
  - All 12 keywords came from real Search Console queries.
- **Dashboard:** the overview shows own sites only, plus "watching N competitors". Own sites have a **Competitors** tab, currently a read-only stub: watching / alternatives / directories. Competitor pages link back to their parent. There's a job queue (`enqueue`, `startRun` and `startDiscovery` in `src/dashboard.ts`), so crawls and discoveries run one at a time.

## Pending, in order

### 1. ✅ DONE 2026-10-20: Competitors tab (`competitorsTab` + `competitorPost` in `src/dashboard.ts`)

All routes below are live and were exercised against a scratch DB copy (pin/unpin, swap, exclude, profile save keeps GSC badges only for real queries, GSC path errors, bad ids → 400, cross-site → 403). Not built: an "undo Never suggest" list. The original spec is kept for reference:

**Already imported in `dashboard.ts`, waiting to be used:** `activate`, `deactivate`, `addOwnCompetitor`, `findProperty`, `MODEL`, `startDiscovery`.

**Content:**
- **Empty state:** a "Find my top 3 competitors" button (POST `/site/:id/discover`) that says what it will use (Search Console connected or not, ~12 searches, rough cost). If `ANTHROPIC_API_KEY` is missing, show the setup message instead. If a discovery is running, show "Finding competitors…" (the page already auto-refreshes while `discovering` has the site).
- **Show `discoveryError`:** errors are stored per site but not displayed yet.
- **Watching cards:**
  - Domain, badges (Search / Local / Added by you / Pinned), the evidence sentence, and the quote.
  - A summary of the competitor's latest check: N changes, how long ago, with a link.
  - Buttons: **Pin/Unpin**, **Stop watching** (`deactivate(..., false)`), **Never suggest** (`deactivate(..., true)`).
- **Swap proposals:** a banner when a `suggested` candidate's score is above the lowest-scoring active one that isn't pinned or user-added: "X now shows up more than Y, swap?". The swap is `deactivate(old)` + `activate(new)`, then `startRun(new)`.
- **Alternatives (top 7):** a "Watch" button, plus a "Watch instead of [select]" form.
- **Directories:** keep the list ("worth checking you're listed").
- **Add your own competitor:** a form that calls `addOwnCompetitor()` and then `startRun`.
- **Profile card:** "What the watchdog thinks your business is": industry, services, city/region/country, scope, keywords with [Search Console]/[generated] badges.
  - An **Edit** form saves `site_profiles.source='user'`. Discovery then reuses it instead of regenerating it (already handled in `discover`).
  - Also show Search Console status, with a form to connect a key path (`findProperty` → UPDATE `sites.gsc_key` / `gsc_property`).
- **Footer:** the last discovery (when it ran, provider, model, cost from `discoveries.stats_json`), plus a **"Find competitors again"** button. Later runs only *propose* swaps; they never swap silently.

**Routes** (the POST handler's regex is `/^\/site\/(\d+)(\/[a-z]+)?$/`; widen it to `[a-z-]+`):

| Route | Action |
|---|---|
| `/site/:id/discover` | `startDiscovery` |
| `/site/:id/competitor` | form: `action` = watch / pin / unpin / stop / exclude / swap, plus `cid` and `replace` |
| `/site/:id/competitor-add` | form: `url` |
| `/site/:id/profile` | form: industry, services (one per line), city, region, country, scope, keywords (one per line) |
| `/site/:id/gsc` | form: `key` path |

**Validate every form field at the boundary:** the candidate id must belong to this site; the country must be 2 letters; keywords are capped at 15 and 120 characters each.

### 2. Make discovery work without the terminal key trick

- Create `SEO-Watchdog/.env` by hand with `ANTHROPIC_API_KEY=...`. Claude can't write `.env` files, because the claude-seo-ai plugin blocks it. The CLI loads `.env` automatically.
- **Optional but recommended:** sign up at serper.dev (free, 2,500 searches, no card) and add `SERPER_API_KEY=...`. That gives:
  - **Real Google positions plus Maps / local pack.** Local competitors get the "Local" badge; the Claude web-search fallback has no Maps data.
  - **Far lower cost:** about $0.01 (Haiku) instead of about $1 per discovery (estimate; confirm on the first run), because web-search pages are about 12k input tokens each.
- 2026-10-20: Serper key obtained and field names verified live by curl (organic[].link/position, places[].title/website/rating/ratingCount all match). A full discovery through Serper hasn't run yet.
- The Serper code path (`serper()` in `competitors.ts`) was written before that check. Test it on the first run with a key, and check the `organic[].link/position` and `places[].website/rating/ratingCount` field names.

### 3. 🟡 Discovery run on all 5 sites (2026-10-20, Haiku 5.5 + Serper); waiting on the owner's review

Total cost for all 5 sites was about $0.017 (each $0.003-0.004, 30 s), versus $1.02 for one Opus run. Results to review:

| Site | Top 3 now watched | Notes |
|---|---|---|
| luvory (re-run, proposals only) | saniglobal, berentoilet, blueplanetgdl (kept from run 1) | Haiku rejected tronorent/saniprime (CDMX, not GDL). Maps found luxusc4, moviban, rentarsanitariosportatiles, sanijal. Swap banner proposes luxusc4 for blueplanetgdl (score 0 this run). |
| studioyume | agavestudio.com.mx, personalizadosgdl.com, garinetiquetas.com | alts: etiquetasyformasgdl, creatify.mx |
| dizayn | diseñodepaginas-web.com (punycode xn--…), autenticoseo.com, paginaswebenguadalajara.com.mx | alts: kerneldigital, alphapro, solucionse |
| blockchains.click | changenow.io, simpleswap.io, 1inch.com | scope online, only 3 of 10 keywords from GSC; alts okx, tradeport.xyz, changelly |
| vexon | cvsolucionesmoviles.com, atcoespaciomovil.com, remobras.mx | no GSC; inmuebles24/habitissimo/oficinasvirtuales correctly in directories |

The new competitor sites were **not crawled yet** (the CLI `discover` doesn't start checks). Crawling 15 sites × 300 pages is heavy on the Pi, so ask before running `npm run wd -- run all`. Possible fix: punycode domains should be shown decoded in the UI.

Original step text:

- Run `npm run wd -- discover <site>` for studioyume.mx, dizayn.com.mx (market MX,US), blockchains.click (scope probably "online") and vexonmexico.com.mx (no Search Console, so generated keywords).
- **The owner reviews the top 3 per site.** It passes if at least 2 of 3 are real rivals on at least 4 of 5 sites, with no directories among them. Each correction becomes a blocklist or prompt fix in `competitors.ts` (`PLATFORMS`, `DIRECTORIES`, or the verify prompt), not a one-off override.
- Then crawl the competitors: `npm run wd -- run all`, or "Check now" on each competitor page.

### 4. ✅ DONE 2026-10-20: tests for 4a (`test/watchdog.test.ts`, last test; `discover(db, site, log, deps)` takes fakes)

Note: the rank counts own-site and platform hits as occupied SERP slots (correct: they really are above the rival).

- Scoring and aggregation with a fake `search()`: inject results, and check that the distinct-domain rank, own-domain exclusion and the platform/directory split behave.
- The quote guard: a verdict whose quote isn't on the page must not become `suggested`.
- The keyword guard: a `from_gsc=true` keyword that isn't in the real list gets flipped to false.
- `activate` / `deactivate`: the competitor site is created or linked, `excluded` is never re-suggested, and re-discovery keeps `pinned`, `user_added` and `excluded`.
- This needs a small refactor so `discover()` accepts injected `search`, `askJson` and `fetch` functions. Keep it minimal: one optional `deps` param.

### 5. Commit, push, update memory

- Commit with the attribution line and push to `origin main` (github.com/darrkito/SEO-Watchdog).
- Update `PLAN.md` status and README: the "Competitors" section, `.env` keys, and the `gsc` / `discover` commands.

## 4d (part): "How to win" tab, done 2026-10-20

- `discover` now keeps the full search results per keyword (`discoveries.serp_json`): own position and URL, every result's URL, Maps places (own included), and Search Console figures.
- `src/gaps.ts` → `battle(db, site)` builds the tab from that, plus the latest own/competitor crawls. Everything is deterministic, with no LLM.
- Choices made after looking at real output:
  - Maps reviews compare only against candidates (Maps also lists wedding venues).
  - Topics are page counts per set of search words, theirs vs ours ("they have 71, you have 7"), never "you have none".
  - Identical advice is merged across searches.
- It needs a discovery that ran after the change; all 4 sites (not blockchains) were re-run on 2026-10-20.
- Possible next steps:
  - An LLM pass that drafts the actual new title/description text for each action (Sonnet, a few cents).
  - Track position changes between discoveries ("you moved #5 → #3").
  - Robots-blocked URLs shouldn't count toward the crawl page cap.

## After 4a (from PLAN.md)

- **pm2 + schedule:**
  - The dashboard isn't under pm2, so it won't survive a reboot.
  - There are no scheduled checks yet. Suggested: daily own-site checks, weekly competitor checks, monthly re-discovery (proposals only).
  - Use `nice` / low concurrency, since `dca-mstr-bull` is live on this Pi.
- **Telegram alerts:** create a bot, then add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to `.env`. The code already exists.
- **Phase 3:** daily Search Console data, position/CTR drop alerts, a cannibalization detector, URL Inspection rotation, Bing API, deploy annotations, and IndexNow auto-ping on new or changed URLs.
- **Phase 4d:** competitor change digest (new pages, price changes, schema they added that we lack) plus a gap view.
- **Phases 5-7:** GEO (AI-crawler panel, answer-fit scores, citation sources, prompt probes with a budget cap), Core Web Vitals (CrUX/PSI), weekly digest email.

## Known issues / notes

- **blockchains.click:** NFT pages still lose their H1/body content when the upstream lookup fails. The metadata is fixed; the page body isn't (`app/nft/[vendor]/[slug]/page.tsx` + `CollectionPageClient`).
- **blockchains.click:** its sitemap is dynamic (141-358 URLs between runs), so "page no longer found" events are expected noise there.
- **Fetching as Googlebot:** own sites are fetched with the Googlebot UA by default, because Next.js streams `<title>` to unknown UAs. Use `--ua` on `add` if a CDN blocks it.
- **Stopping the dashboard:** stop it by port (`ss -ltnp | grep :4321`). `pkill -f "cli.ts serve"` kills the calling shell.
- **Untouched files:** `blockchains.click-Coverage-2026-08-10.xlsx` is untracked in the BetweenChain repo; it isn't ours.
