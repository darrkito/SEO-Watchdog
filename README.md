# SEO Watchdog

Watches any website for SEO, GEO and agent-readiness regressions. Each run fetches the site, saves a snapshot, compares it with the previous one, and turns what matters into findings and alerts. Every site is user input; nothing is hardcoded. The full roadmap is in [PLAN.md](PLAN.md).

Requires Node ≥ 24 (it runs TypeScript natively and uses the built-in `node:sqlite`). The only npm dependency is `@anthropic-ai/sdk` (used for competitor discovery).

```bash
npm run dashboard                                   # http://127.0.0.1:4321 (localhost only)
npm run wd -- add example.com --market MX          # own site; --competitor-of <site> for a rival
npm run wd -- run all                               # crawl + diff + findings + alert on new criticals
npm run wd -- findings example.com --severity critical
npm run wd -- changes example.com                   # what changed in the latest run
npm run wd -- mute <finding-id>
npm run wd -- gsc example.com /path/key.json      # connect Search Console (service-account key)
npm run wd -- discover example.com                 # find the top 3 competitors and start watching them
npm run wd -- competitors example.com
npm test                                            # replays real past bugs as fixtures
```

**Optional `.env` settings:**
- `ANTHROPIC_API_KEY`: enables competitor discovery. `WATCHDOG_MODEL` overrides the model (default `claude-sonnet-5-5`; `claude-haiku-5-5` is ~17x cheaper but picks looser rivals and needs Serper).
- `SERPER_API_KEY`: real Google positions plus Maps for discovery, required with the default Haiku model. About $0.01 per run with Haiku, versus about $1 for Opus doing its own web search.
- `WATCHDOG_CONTACT`: added to the crawler User-Agent.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`: instant alerts.
- `WATCHDOG_DATA`: database and HTML location (default `./data`).
- `WATCHDOG_TIMEOUT_MS`: per-request timeout (default 20000).

## Dashboard

The dashboard is written for people who aren't SEO specialists.

- **Overview:** one plain sentence per site ("Pages hidden from Google: 7 pages"), plus a form to add a site.
- **What to fix:** issues grouped by type and ranked by urgency, then by number of pages. Each group says what it means, why it matters and how to fix it, and can be muted. Below that are a trend chart of open issues and a "recently fixed" list.
- **What changed:** each check summarized as one line per kind of change, with bad news first. Click a line to see every page's before → after. Noisy text edits are hidden by default.
- **Site checks:** robots.txt, sitemap, certificate, domain, and which search and AI crawlers may read the site.
- **How to win:** what to change to rank above competitors, built only from collected data: Google results kept from the last discovery, the latest crawls of your site and theirs, and Search Console. It shows a ranked "Do these first" list, a searches scoreboard (your position and who is ahead), page-vs-page gaps (search words missing from title/H1/description, thinner content, schema or FAQ they have), Google Maps reviews against verified rivals, topics where they have more pages, and structured data they use that you don't. Logic lives in `src/gaps.ts`.
- **Competitors:** who you're watching and why (evidence and a quote from their homepage), when each was last checked, and pin / stop / never-suggest buttons. It also shows alternatives you can watch or swap in, directories worth being listed on, a form to add your own competitor, the editable business profile discovery uses, the Search Console connection, and a button to run discovery again. A later run only *proposes* swaps.
- **Page view:** what Google sees on one URL, its problems, and its full change history.

The plain-language text for every rule lives in `src/catalog.ts`; add an entry there whenever you add a rule.

## What a run checks (Phase 1)

| Level | Checks |
|---|---|
| **Site** | robots.txt availability, Googlebot access, per-AI-bot access changes, sitemap present, sitemap URL count, TLS expiry, domain expiry (RDAP) |
| **Page** | hangs, redirect loops and chains, 4xx/5xx, sitemap URLs that redirect, noindex on sitemap URLs, cross-host canonical or og:url, invalid JSON-LD, FAQ schema not visible on the page, doubled `/en/en/` prefix, hreflang region outside the market, missing lang/title/meta/H1, soft-404, empty JavaScript app shell |
| **Cross-page** | duplicate titles (cannibalization), hreflang reciprocity and broken targets, schema missing on a language alternate, indexable pages missing from the sitemap |
| **Changes** | title, meta, H1, canonical, robots, lang, hreflang, JSON-LD types, FAQ count, content hash, status, new/gone pages, sitemap added/removed |

**Guardrail:** when many previously-OK pages fail at once, or the sitemap collapses, the run is marked `suspect`. Its findings are held for one run instead of firing a burst of false alarms.

## Competitor discovery (Phase 4a)

`discover` profiles the business from its latest crawl. It picks keywords: with Search Console connected, the model may only select from your real queries, and code checks that. It then runs a localized search per keyword and scores visibility as CTR × demand. Platforms and directories are dropped, and the model verifies the top 12 against each site's real homepage text. A verdict whose quote isn't on the page is rejected. The first run starts watching the top 3; your pins, exclusions and manual additions survive re-runs.

Parsing comes from [claude-seo-ai](https://github.com/Hainrixz/claude-seo-ai) (MIT), vendored in `src/vendor/claude-seo-ai/`.
