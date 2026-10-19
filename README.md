# SEO Watchdog

Watches any website for SEO, GEO and agent-readiness regressions. Each run fetches the site, saves a snapshot, compares it with the previous one, and turns what matters into findings and alerts. Every site is user input; nothing is hardcoded. The full roadmap is in [PLAN.md](PLAN.md).

Requires Node ≥ 24 (it runs TypeScript natively and uses the built-in `node:sqlite`). There are zero npm dependencies.

```bash
npm run wd -- add example.com --market MX          # own site; --competitor-of <site> for a rival
npm run wd -- run all                               # crawl + diff + findings + alert on new criticals
npm run wd -- findings example.com --severity critical
npm run wd -- changes example.com                   # what changed in the latest run
npm run wd -- mute <finding-id>
npm test                                            # replays real past bugs as fixtures
```

**Optional `.env` settings:**
- `WATCHDOG_CONTACT`: added to the crawler User-Agent.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`: instant alerts.
- `WATCHDOG_DATA`: database and HTML location (default `./data`).
- `WATCHDOG_TIMEOUT_MS`: per-request timeout (default 20000).

## What a run checks (Phase 1)

| Level | Checks |
|---|---|
| **Site** | robots.txt availability, Googlebot access, per-AI-bot access changes, sitemap present, sitemap URL count, TLS expiry, domain expiry (RDAP) |
| **Page** | hangs, redirect loops and chains, 4xx/5xx, sitemap URLs that redirect, noindex on sitemap URLs, cross-host canonical or og:url, invalid JSON-LD, FAQ schema not visible on the page, doubled `/en/en/` prefix, hreflang region outside the market, missing lang/title/meta/H1, soft-404, empty JavaScript app shell |
| **Cross-page** | duplicate titles (cannibalization), hreflang reciprocity and broken targets, schema missing on a language alternate, indexable pages missing from the sitemap |
| **Changes** | title, meta, H1, canonical, robots, lang, hreflang, JSON-LD types, FAQ count, content hash, status, new/gone pages, sitemap added/removed |

**Guardrail:** when many previously-OK pages fail at once, or the sitemap collapses, the run is marked `suspect`. Its findings are held for one run instead of firing a burst of false alarms.

Parsing comes from [claude-seo-ai](https://github.com/Hainrixz/claude-seo-ai) (MIT), vendored in `src/vendor/claude-seo-ai/`.
