# SEO Watchdog — Build Plan

_Written 2026-10-19. This plan is for internal use first: we run it on our 5 sites for a while, then sell it as a subscription._

**Goal:** one tool that watches any website for SEO, GEO (AI-search) and agent-readiness changes. It reports what changed, whether the change matters, and what to do about it. It also pulls the real search and AI-citation data we currently collect with ~80 one-off scripts.

**First users:** luvory.com.mx, studioyume.mx, Dizayn, blockchains.click, Vexon. Their competitors are watched too.

---

## 1. What heytony's Watchdog actually is (benchmark)

Source: watchdog.heytony.ca, fetched 2026-10-19.

- **Price:** $10/mo, one plan.
- **Scope:** 3 competitor sites, up to 1,000 pages each.
- **Frequency:** weekly crawl and a weekly report.
- **What it diffs:** title, meta description, headings, body text (added, removed, rewritten), pricing and landing pages, internal and external links.
- **Not built yet:** "Actionable Insights" (marked coming soon).
- **Not offered at all:** alerting channels, integrations, own-site monitoring, indexing data, rankings, Core Web Vitals, schema, robots, AI visibility, agent readiness.

**Conclusion:** heytony is competitor change-diffing and nothing more. We match it in Phase 4 and beat it on every other axis. The wider market splits into three tool types, and nobody joins them cheaply:

| Tool type | Examples | What they do | Price |
|---|---|---|---|
| Change monitors | Conductor/ContentKing, SEORadar, Little Warden, SEOcrawl | 24/7 tag, robots and indexability change alerts | $$ |
| AI-visibility trackers | Peec AI, Profound, Otterly, Promptwatch, Rankscale | Prompt tracking: is the brand cited by ChatGPT, Perplexity or Gemini, plus share of voice | $$$ |
| Rank and data dashboards | GSC, Bing Webmaster, Semrush | Positions and clicks | varies |

**Our angle:** watchdog, search data, AI citations and agent readiness in one place, each tied to a fix recommendation from our playbooks.

---

## 2. What we already know and own (consolidation inventory)

Nothing below is theory. Each item was validated on a real site; the source is in brackets.

### 2.1 Code we can reuse

| Asset | Where | Reuse plan |
|---|---|---|
| claude-seo-ai scripts, **MIT**, zero-dep Node, ~10k lines: `crawl`, `snapshot`, `parse-html`, `parse-robots-sitemap`, `validate-jsonld`, `link-graph`, `hreflang-check`, `check-answerblocks`, `factdensity`, `check-freshness`, `ai-eligibility`, `ai-discovery`, `agent-readiness`, `ua-diff`, `psi-client`, `score` + `finding.schema.json` | `~/.claude/plugins/cache/claude-seo-ai/claude-seo-ai/0.2.0/scripts` | **Vendor into `vendor/claude-seo-ai/`, keeping the LICENSE.** MIT allows selling. If our checks output findings in their schema, `score.mjs` gives us both 0-100 scores (Search SEO and AI Visibility) for free. |
| GSC AI-features report scraper | `~/.gsc-indexer/gsc_ai_report.mjs` | Wrap as a "source" |
| Bing AI Performance citations scraper | `~/.gsc-indexer/bing_ai_citations.mjs` | Wrap |
| Bing search performance, URL inspect, warnings, Site Explorer | `~/.gsc-indexer/bing_*.mjs` | Wrap |
| IndexNow and Bing URL submit, sitemap resubmit | `~/.gsc-indexer/submit-urls-*.mjs`, `resubmit-sitemap-multi.mjs` | Use as **actions** (auto-ping on detected new or changed URLs) |
| GSC queries, pages, URL inspection | `~/.gsc-indexer/query-gsc*.mjs`, `inspect-urls.mjs`, `~/Luvory AI Agent/scripts/gsc_query.py` | Port to one Node module (`googleapis` is already used there) |
| GA4 AI referrers, Clarity AI visibility and segments | `~/Luvory AI Agent/scripts/ga4_ai_referrers.py`, `clarity_ai_visibility.mjs`, `clarity_query.py` | Port; Python ones become Node |
| Homegrown crawler (orphans, depth, duplicates, anchors) | `~/Luvory AI Agent/scripts/site_crawl.py` | Logic only. Its 3 known bugs become test fixtures (§2.3). |
| PSI query and sweep | `~/Luvory AI Agent/scripts/psi_query.py`, `psi_sweep.py` | The vendored `psi-client.mjs` already covers this |
| isitagentready.com `/api/scan` JSON endpoint | agent-readiness playbook §1 | Agent-readiness level (1-5) per site, weekly |
| Grammar check (LanguageTool) and readability (textstat) | `grammar_check.py`, SEO playbook §18 | Low priority; noisy, so advisory only |

### 2.2 Knowledge to encode as checks

Each line becomes a rule with a severity and a playbook link.

**Indexing and technical**
- `noindex`, canonical, or robots changes on a previously indexable URL.
- Status flips: 200 → 3xx, 4xx or 5xx. Redirect chains and loops; the self-mapping slug map loop from SEO §25.
- Soft-404s (SEO §28).
- A sitemap URL disappears, or an indexable page is missing from the sitemap.
- Route hangs: fetch with a 30 s timeout. The Luvory loader-redirect hung every ES blog post.
- Metadata that depends on a live fetch falling through to `noindex` (SEO §18).

**Multilingual**
- `<html lang>` per route.
- hreflang reciprocity and x-default.
- `/en/en/` doubled prefixes.
- Wrong hreflang region: `en-US` on a Mexico-only shop broke Merchant Center (SEO §29).
- Hardcoded-chrome language leaks (SEO §19 and §21).

**Structured data**
- JSON-LD must be read from **raw HTML**; WebFetch is blind to it (SEO §22).
- JSON-LD removed, invalid, or with a type change.
- **FAQ schema text ≠ visible FAQ text** (GEO §6; Luvory's orphaned `faq` vs `faqExtra` arrays).
- One language block missing its schema.
- Fragmented entity: several Organization nodes without `@id` linking (SEO §22).

**On-page**
- Title or meta length; the decoupled `metaTitle` rule (SEO §24).
- Duplicate titles or H1s across pages. This is the cannibalization risk, which hurts AI citation too (GEO §9).

**GEO and content-answer-fit (GEO §6)**
- Question-formatted H2 followed by a 40-60 word answer.
- FAQ question that exactly echoes an H2.
- Tables for 3+ numeric variants.
- `dateModified` freshness: about 3.2× citation lift within 30 days.
- Descriptive internal anchors.

**AI crawler access**
- Per-bot effective robots access: GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, PerplexityBot, Google-Extended, Bingbot.
- Content-Signal header.
- `nosnippet` and `max-snippet` (these gate AI Overviews).
- UA-diff: Googlebot vs GPTBot vs a browser served different HTML.
- Raw-vs-rendered diff: content that only exists after JavaScript runs.

**Agent readiness (agent playbook §2, §12, §13)**
- These files must exist **and actually work**: `llms.txt`, MCP server card plus an MCP `initialize` call that succeeds, A2A agent card, ARD `ai-catalog.json`, `/.well-known/ucp`, Link headers, and markdown negotiation.
- **Parity check:** a new blog post or product appears in `llms.txt`, MCP and the sitemap within N days (agent §12).

**Performance**
- CWV from the CrUX API (field data, free) is the alert source.
- PSI lab data uses the median of 3 runs before alerting; single runs are noisy (PSI §5).
- Mobile and desktop are tracked separately.

**Commerce (Yume)**
- Product schema price must match the visible price.
- Merchant feed reachable.
- Organization shipping and return markup present (SEO §32).

**Domain hygiene (the Little Warden-style basics heytony lacks)**
- SSL expiry.
- Domain expiry (RDAP, free).
- DNS record changes.
- Analytics and Clarity tag still present.
- `www` / non-`www` and http→https redirects.

### 2.3 Lessons that are also guardrails (false-positive killers)

1. **If the crawl says "everything is broken" (mass orphans or mass unreachable), suspect the crawler first.** If more than 30% of pages flip to bad at once, suppress the alerts, mark the run "suspect", and re-run (SEO §18).
2. Collect links **before** stripping nav and footer. Normalize trailing slashes on the BFS root and on every graph key.
3. **"Pushed is not live."** Verify against the live URL. Record deploys (git SHA, Vercel or Cloudflare deploy hooks) as chart annotations. Never read analytics as a reaction to a change that has not deployed (memory: `verify_deploy_state_before_analytics`).
4. GSC data lags 2-3 days, so never alert on the last 2 days. Position alerts need a minimum impressions floor.
5. AI citation volume is winner-take-most (GEO §5). A single dominant page is the expected shape, not an anomaly.
6. AI citation ≠ clicks (SEO §20). Show both and never blend them into one number. Likewise the two scores are never blended (claude-seo-ai rule).
7. HTML entity encoding (`'` vs `&#x27;`) makes text matching undercount. Normalize text before any "appears N times" check.
8. Dashboards with background polling (GSC, Bing) time out on `networkidle`. Use `domcontentloaded` and poll for the expected text.

---

## 3. Product shape

```
                ┌──────────── Sources (pull) ────────────┐
 Site registry →│ Crawler/snapshot · robots/sitemap · DNS/SSL │
 (own + comps)  │ GSC API · Bing API · CrUX/PSI · isitagentready│
                │ [internal-only] GSC-AI · Bing-AI · Clarity-AI │
                │ GEO prompt probes (LLM APIs w/ web search)    │
                └───────────────┬────────────────────────┘
                                ▼
                 Snapshots (SQLite, content-hashed)
                                ▼
                 Differ → Events (what changed, before/after)
                                ▼
                 Rules → Findings (severity, playbook link, fix hint)
                                ▼
       ┌────────────┬───────────┴──────────┬───────────────┐
   Alerts (instant  Weekly digest     Dashboard        Actions
   critical only)   (email)           (localhost)      (IndexNow ping,
                                                       sitemap resubmit)
```

**Core concept:** everything is a **snapshot → diff → event → finding**. A title change, a robots change, a position drop and a lost AI citation all flow through the same pipeline, which is what makes the product one tool instead of 80 scripts.

### 3.1 Stack (decided)

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node 25 + TypeScript (tsx)** | All existing scrapers and claude-seo-ai are Node. One runtime; port the Python scripts. |
| DB | **`node:sqlite` (built in)** | Zero native deps on the Pi. Plain SQL kept portable, so moving to Postgres at SaaS time is a driver swap. |
| HTTP fetch | `fetch` (undici) | Raw HTML first, since most checks need no browser. |
| Browser | Playwright (already installed) | Only for rendered-vs-raw diff, UA-diff, and UI-only sources. Expensive on the Pi, so used sparingly. |
| Server | **Hono** | Tiny, serves the API and the SPA, and the same code deploys anywhere. |
| UI | Vite + React + shadcn (our usual stack) | Timeline, diff viewer, charts. |
| Scheduler | In-process cron loop, with a jobs table in SQLite as the queue | No Redis. A separate worker process can come later. |
| Alerts | Email (whichever provider Yume's transactional email uses) + Telegram bot (free, instant) | Two channels, no more. |
| Process | pm2 `seo-watchdog` | Same as everything else on the Pi |

**Pi constraint:** `dca-mstr-bull` is live. Crawls run `nice -n 19` with concurrency 2, and Playwright jobs run serially and off-peak (memory: `no_competing_cpu_work`).

### 3.2 Data model (multi-tenant from day 1, no auth yet)

```
orgs(id, name)                                   -- just "us" for now
sites(id, org_id, url, kind[own|competitor], parent_site_id, langs, vertical, crawl_limit, schedule)
pages(id, site_id, url, first_seen, last_seen, in_sitemap)
snapshots(id, page_id, run_id, fetched_at, status, final_url, redirect_chain, headers_json,
          html_hash, text_hash, extract_json)    -- title, meta, h1-h6, canonical, robots, hreflang,
                                                 -- jsonld[], links[], word_count, faq_visible[], dates
site_snapshots(id, site_id, run_id, kind[robots|sitemap|llms|mcp|a2a|ard|dns|ssl|whois|agentready], body_hash, data_json)
runs(id, site_id, started_at, finished_at, status[ok|suspect|failed], stats_json)
events(id, site_id, page_id?, run_id, type, field, before, after, created_at)
findings(id, site_id, page_id?, rule_id, severity[critical|warn|info], status[open|resolved|muted],
         first_seen, last_seen, evidence_json, playbook_ref)          -- claude-seo-ai finding schema compatible
metrics(site_id, page_id?, source, metric, dim_json, date, value)    -- GSC/Bing/CrUX/AI citations/GEO probes
deploys(site_id, at, sha, note)                  -- annotations
site_profiles(site_id, industry, services[], location_json, langs[], market, source[auto|user], evidence_json)
keywords(id, site_id, query, lang, location, source[gsc|llm|user], weight, brand bool)
serp_results(keyword_id, date, type[organic|maps], rank, domain, url, extra_json)   -- rating, reviews
competitor_candidates(site_id, domain, url, types[search|local|ai], score, overlap, evidence_json,
          llm_verdict, status[suggested|active|pinned|excluded|user_added|directory], decided_by[auto|user])
geo_prompts(id, site_id, prompt, lang, engines[]) / geo_results(prompt_id, engine, date, cited_urls[], our_rank, competitors_cited[], answer_excerpt)
```

The raw HTML is stored gzipped on disk under `data/html/<hash>.gz` and deduplicated by hash. Only the extracted fields live in SQLite.

---

## 4. Phased build

Each phase ends with something we use on our 5 sites that day. **Dogfood before adding more.**

### Status, 2026-10-19: Phase 0 and Phase 1 done

**Built:**
- CLI driven entirely by input (`add`, `run`, `findings`, `changes`, `mute`, `remove`).
- 14 passing fixture tests: 11 of the 12 §6 bugs are covered, and #12 has a test of its own.
- Dogfooded 4 runs on our 5 sites.

**Bugs the dogfood runs found and fixed in the tool:**
- `x-default` misread as a region.
- Content hash broken by streamed-SSR section order and live numbers.
- Next.js streaming `<title>` to unknown UAs. Own sites are now fetched as Googlebot.
- Suspect guardrail missing "site down takes the sitemap with it".

**Real issue found on our sites:** blockchains.click `app/nft/[vendor]/[slug]/page.tsx:83` still serves `noindex` plus a generic title when the collection fetch fails on a cold cache. 7 Magic Eden sitemap URLs flipped to noindex during a run, and those pages take 5-8 s to render.

**Deviations from the plan as written:**
- Node runs `.ts` natively, so there's no tsx and no build step.
- Fixtures live inline in `test/watchdog.test.ts`.
- Bug #5 (SSR content missing) is detected without Playwright, using an empty-app-shell heuristic.

### Status, 2026-10-19: Phase 2 done

**Built:** a server-rendered dashboard (`npm run dashboard`) on zero-dependency `node:http`, so there's no React or build step.

**Dogfooding found and fixed two tool bugs:**
- Findings on pages that dropped out of a dynamic sitemap never resolved. They now resolve on a complete crawl, but never during an outage.
- The changes list was a 12k-pixel wall. It's now grouped by kind of change.

**Chart:** colors were validated with the dataviz palette checker. The first amber/red pair failed colorblind separation and was re-stepped.

### Phase 0: Skeleton (½ day)
- `git init`, TypeScript, the `node:sqlite` schema, and `watchdog.config.json` with our 5 sites and 2-3 competitors each.
- Vendor claude-seo-ai scripts with their LICENSE.
- CLI: `npx tsx src/cli.ts run <site>`, `diff <site>`, `findings <site>`.

### Phase 1: Own-site watchdog core (the real value, 3-4 days)
- Sitemap and robots fetch, then a raw-HTML fetch of every URL (30 s timeout, polite UA `SEOWatchdog/0.1 (+contact)`).
- Extraction uses vendored `parse-html` and `validate-jsonld`.
- Snapshot, then diff, then events, then **rules for the critical set**:
  - noindex added, canonical changed, status flip, removed from sitemap.
  - robots.txt changed (with a per-bot effective-access diff).
  - JSON-LD removed or invalid.
  - FAQ schema text ≠ visible FAQ text.
  - title, meta or H1 changed.
  - hreflang broken.
  - SSL or domain expiring in under 21 days.
  - route hang.
- The "suspect run" guardrail (§2.3 #1).
- Telegram alert for critical findings; everything else waits for the digest.
- **Acceptance test: replay of past real bugs (§6).** Phase 1 is not done until the watchdog catches them.

### Phase 2: Localhost dashboard (2-3 days)
- **Sites overview:** health, open findings by severity, last run, and the two scores.
- **Change timeline:** events grouped per run, filterable by type.
- **Page view:** a side-by-side diff of before and after for title, meta, headings, text and JSON-LD, plus a snapshot history.
- **Findings inbox:** open, muted and resolved, each with a playbook link and a fix hint.
- **Mute rules:** to stop noisy findings, such as brand-name grammar flags.

### Phase 3: Search data (3 days)
- GSC Search Analytics API, daily: queries × pages, 16 months of backfill.
- Alerts:
  - A page loses more than X positions on a query with more than N impressions, ignoring the last 2 days of lag.
  - CTR anomaly.
  - New query appears.
- **Cannibalization detector:** 2 or more of our URLs getting impressions for the same query (GEO §9, SEO §5).
- URL Inspection API, rotating within the 2,000/day quota: index status and Google-selected canonical ≠ declared canonical.
- Bing Webmaster API: we already have a key for blockchains.click. Get keys for the other sites.
- Deploy annotations: a git post-push hook and Vercel/Cloudflare webhooks write to `deploys`.
- **Action:** a detected new or changed URL triggers IndexNow and Bing submit automatically (scripts already exist).

### Phase 4: Competitor discovery + monitoring, heytony parity and more (4 days)

#### 4a. Auto-discovery of the top 3 competitors (by industry + location)

The tool finds competitors itself. The user can then replace, pin or exclude any of them. Pipeline:

1. **Site profile (auto, user-editable).**
   - **What it holds:** industry, the services offered, location, language(s) and market.
   - **Location sources:**
     - LocalBusiness/Organization JSON-LD: `address`, `geo`, `areaServed`.
     - Visible name, address and phone (NAP).
     - Place names that appear in Search Console queries.
     - The country-code domain, such as `.mx`.
   - **Industry and services:** a cheap LLM call (Claude Haiku) reads the homepage, the about page and the top pages, and returns structured JSON. **No guessing:** a field it can't support with page evidence comes back empty, and the user fills it in.
2. **Seed keywords, from real demand first:**
   - **Default:** the top 15-25 **non-brand** Search Console queries by impressions. Brand terms are filtered out using the brand-name tokens from the profile.
   - **Fallback** (no Search Console, a new site, or a future SaaS customer without it): the LLM generates "service + location" queries from the profile.
   - **Languages:** one set per site language (ES and EN).
3. **Localized search results** via Serper (`gl`/`hl`/`location`). Each keyword pulls the **organic top 10 plus the Maps/local results**, for example `location=Guadalajara, Jalisco, Mexico`. One provider covers both.
4. **Score candidates (visibility share):**
   - **Organic:** Σ over keywords of `keyword_weight × ctr_curve(position)`, where `keyword_weight` is the keyword's Search Console impressions share.
   - **Maps:** a separate Maps-presence score that counts appearances, rating and review count.
   - **Overlap:** the number of keywords where the candidate and we both rank.
5. **Filter out non-competitors:**
   - **Blocklist:**
     - Marketplaces: mercadolibre, amazon.
     - Social: facebook, instagram, youtube, pinterest.
     - Directories: yelp, tripadvisor, bodas.com.mx.
     - Wikipedia and gov sites.
     - Our own sites.
   - **LLM check** on each remaining candidate's homepage: *"Does this business offer the same service in the same market? yes/no + one-line reason quoted from the page."*
   - **Same-market check:** the candidate's address, Maps result or `areaServed` falls in the same area. A national player that ranks locally still counts, and is labelled "national".
   - **Directories get their own list.** They aren't crawled as competitors; they appear as **"channels where your competitors are listed and you aren't"**, such as bodas.com.mx for Luvory. That list is useful on its own.
6. **Output: the top 3, each with evidence.** For example: *"ranks for 14/22 of your keywords, avg position 3.2, overlaps you on 9, Maps 4.8★ (120 reviews), confirmed: 'renta de sanitarios para eventos en Guadalajara'."* Candidates 4-10 show as alternatives.
7. **Three competitor types, kept visible:**
   - **Search:** they rank for your keywords.
   - **Local:** they appear in Maps.
   - **AI:** they are cited by AI engines for your prompts. This comes from the Phase 5 probes, which feed back into this list.
   - The default top 3 is a blend, and each competitor carries type badges.

#### 4b. User control
- **Accept, replace, pin, exclude:**
  - **Replace** takes any URL. It must be fetchable, must not be the same domain as ours, and runs through a normal profile check.
  - **Exclude** is remembered, so the tool never re-suggests that domain.
  - **Pin** locks a competitor in.
  - **Add more:** up to the plan limit; for us internally, no limit.
- **First run is zero-touch:** the top 3 become active automatically.
- **Monthly re-discovery only proposes changes**, for example *"X overtook Y on your keywords, swap?"* It never silently swaps, because swapping would break that competitor's change history. Pinned and user-entered competitors are never touched.

#### 4c. Cost
- **One full discovery for our 5 sites:**
  - About 25 keywords × 2 result types × 5 sites ≈ 250 Serper queries.
  - About 50 Haiku classifications, a few cents.
  - The free 2,500 Serper queries cover roughly 10 monthly runs.
- **At SaaS scale:** switch to DataForSEO's standard queue (about $0.0006 per results page; $50 minimum deposit) and keep the provider behind one `serp()` function.
- **Ruled out:** Google's Custom Search API (closed to new customers, shuts down 2027-01-01) and scraping Google ourselves.

#### 4d. Monitoring the active competitors
- Same crawler with `kind=competitor`, weekly, 1,000-page cap.
- Diffs:
  - New and removed pages via the sitemap diff.
  - Title, meta and heading rewrites.
  - Text-diff percentage.
  - Price changes (Product or Offer JSON-LD plus price-regex fallback).
  - New outbound links: who they link to and partner with.
  - Schema they added that we lack.
- **Gap view:** topics or pages competitors have that we don't, based on title and H1 clustering. This is our version of heytony's "Actionable Insights".

### Phase 5: GEO and AI visibility (4-5 days)

The sellable differentiator.

- **AI-crawler access panel:** per-bot effective robots, Content-Signal, snippet controls, UA-diff, and raw-vs-rendered word-count diff, all from vendored `ai-eligibility` and `ua-diff`.
- **Content-answer-fit score per page** from vendored `check-answerblocks`, `factdensity` and `check-freshness`. The score ranks which pages to fix first, weighted by real impressions from Phase 3.
- **Citation sources (internal only):** wrap the existing GSC-AI, Bing-AI and Clarity-AI scrapers into `metrics`, run weekly. These replace the current cron jobs (`run-daily-clarity.sh`, `run-yume-ai-snapshot.sh`).
- **GEO prompt probes** (what Peec and Profound charge for):
  - Per site, 10-30 real target prompts taken from GSC queries, not guesses, in ES and EN.
  - Each prompt runs weekly through APIs with web search: OpenAI (web search tool), Perplexity Sonar, Gemini with Google Search grounding, and Claude with web search.
  - Stored per run: cited URLs, whether we're cited, our position, competitors cited, and an answer excerpt.
  - The output is **share-of-voice vs competitors** over time.
  - **This costs real money per call**, so a hard monthly budget cap is set in config, with cheap models and weekly frequency only.
  - API answers ≠ consumer ChatGPT answers. The UI labels these "API probe", never "what users see".
- **Agent readiness:**
  - The isitagentready `/api/scan` weekly level.
  - Our functional checks: MCP `initialize` + `tools/list` succeed, A2A card validates, `llms.txt` links resolve.
  - The **parity check** (agent §12).

### Phase 6: Performance (1 day)
- **CrUX API:** free field data, p75 LCP, INP and CLS per origin and top URLs, weekly. This is the alert source.
- **PSI lab:** median of 3 runs, mobile and desktop, on the top 10 pages by impressions. Trend only; never an alert from a single run.

### Phase 7: Weekly digest and insights (2 days)
- **Email digest per site:**
  - What changed on our site and on competitors' sites.
  - New findings and resolved findings.
  - Position, AI-citation and GEO share-of-voice deltas.
  - The top 3 recommended fixes.
- **Optional Claude API summary** of the digest. The LLM writes prose only from stored events and never invents numbers; the numbers are templated in.
- **"Resolved" verification:** when a finding stops reproducing on the live site, it is auto-closed and shown in the digest as a win.

**Total to a dogfoodable v1:** about 3-4 weeks of sessions.

### Dogfood period (4-8 weeks, before any SaaS work)

**What we measure:**
- Real regressions caught.
- False-positive rate: target under 10% of alerts.
- Alerts we muted.
- Fixes shipped because of it.

Rules that cry wolf get tuned or deleted. Each new real bug found manually is added as a rule plus a fixture.

---

## 5. Path to SaaS (only after dogfooding)

Known hard parts, flagged now so the design doesn't block them:

| Topic | Reality | Plan |
|---|---|---|
| **UI-scraped sources** (GSC AI report, Bing AI Performance, Clarity AI tab) | Need the user's logged-in browser cookies. Not offerable to customers: credential-custody and ToS risk. | Stay **internal-only**. For customers, offer CSV import (claude-seo-ai has `gsc-ai-import.mjs`) or wait for official APIs. |
| GSC API for customers | Needs Google OAuth with the `webmasters.readonly` scope, which means Google's OAuth app verification (weeks) | Start verification early in the go-live phase |
| Bing | Customer pastes their own Webmaster API key | Easy |
| GEO probe costs | Per-call LLM spend | Prompt count is the pricing lever; per-org budget caps |
| Crawling other people's sites | robots.txt respect, identifiable UA, rate limits, abuse | Respect robots for competitor crawls, 1 req/s per host, a block list |
| Hosting | The Pi can't serve customers | Container on a VPS, Fly or Railway, with Postgres; separate web and worker processes. **Not Vercel for the worker** (long-running Playwright). |
| Auth and billing | Not needed yet | Better-Auth or Supabase Auth, plus Stripe. The `org_id` column is already everywhere. |
| Custody | No signing or fund-moving here | N/A |

**Pricing sketch** (decide after dogfooding):
- **Starter:** around $19, 1 own site, 3 competitors, weekly.
- **Pro:** around $49, 5 sites, daily, plus GEO probes.
- **Agency:** around $149, 25 sites, white-label digest.

heytony at $10 is the floor reference. We're a different product, but the competitor-diff tier must not look overpriced next to it.

---

## 6. Acceptance fixtures: "would it have caught it?"

Real bugs from our history become fixture HTML or URLs under `tests/fixtures/`. One runnable `node --test` suite proves each rule fires. Phase 1 is done when the core ones pass.

| # | Real bug | Site | Rule |
|---|---|---|---|
| 1 | Route loader-redirect hung all ES blog posts on the CF Worker | Luvory | route hang (timeout) |
| 2 | FAQPage JSON-LD sourced from orphaned `faq` array, not the visible `faqExtra` | Luvory | FAQ schema ≠ visible |
| 3 | EN language swap dropped `faqJsonLd` | Luvory | schema missing in one language |
| 4 | `generateMetadata` fetch failure → `robots noindex` | Blockchains.click | noindex flip |
| 5 | /swap SSR content missing | Blockchains.click | raw-vs-rendered diff |
| 6 | 17/28 posts had FAQ schema never rendered visibly | Blockchains.click | FAQ schema ≠ visible |
| 7 | Self-mapping `EN_SLUG_MAP` entry → redirect loop | Dizayn | redirect loop |
| 8 | 12-way duplicated SITE_URL | Dizayn | canonical/og:url host mismatch |
| 9 | `hreflang="en-US"` on a Mexico-only shop | Yume | hreflang region vs site market |
| 10 | `/en/en/` double prefix | Luvory | doubled language prefix |
| 11 | ~40% of pages only reachable via a link missing from the sitemap | Blockchains.click | indexable-not-in-sitemap |
| 12 | Crawler nav-strip bug → fake mass orphans | (crawler) | suspect-run guardrail |

**Competitor discovery acceptance test:**
- You review the auto top 3 for each of our 5 sites.
- **Pass:** at least 2 of 3 are real rivals you recognize on at least 4 of the 5 sites, and no directory or marketplace shows up as a competitor.
- Every wrong pick you correct becomes a blocklist entry or a prompt fix, not a one-off override.

---

## 7. Open decisions (defaults chosen, change if you disagree)

1. **Alert channel:** Telegram + email digest. WhatsApp is possible later but costs money.
2. **Competitors per site:** **auto-discovered top 3** by industry and location (Phase 4a). The user can replace, pin or exclude any of them. `watchdog.config.json` only holds optional manual overrides.
3. **GEO probe budget:** default cap of $10/month across all sites, raised once we see value.
4. **Product name:** "SEO Watchdog" collides with heytony's product name. Pick a different one before going public.
5. **Own repo:** SEO-Watchdog is gitignored by luvory-genius-generator, so it gets its own git repo and GitHub remote.

## 8. Skipped on purpose (YAGNI until dogfood says otherwise)
- **Backlink and Domain Rating data:** no legit free source (SEO §18). Don't fake it.
- **AI-content or plagiarism detection:** no reliable free signal (SEO §18).
- **Keyword volume research:** use GSC's real impressions instead. pytrends is a later add-on (Yume 10-17 work).
- **Daily rank tracking:** GSC position is the real number for our own sites. The SERP API is used only for monthly competitor discovery. Daily rank tracking is a paid add-on later if customers ask, and we never scrape Google ourselves.
- **Redis, queues, microservices, Kubernetes.**
