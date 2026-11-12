# Plan: topic researcher v2 (demand-first), 2026-11-12

Goal: most weekly runs keep several topics that honestly score 9-10, on every site, without lowering the threshold.

## 1. What the data says (watchdog.db, 2026-11-12)

| Finding | Evidence |
|---|---|
| Waiting for the Trends unblock will not fix it | 10 of the 12 Trends results cached before the block are "no data", the other 2 are "down". Trends has no data for 5-8 word queries. |
| Bing is empty in Mexico | 2 of 175 cached Bing lookups have any exact impressions (max 6). The rubric's 3 Bing points are unreachable for the MX sites. |
| Serper gives no "People also ask" or related searches for MX/es | 0 of 138 cached SERPs have them. Live test: `gl=mx, hl=es` returns only `organic`; `gl=us, hl=en` returns 4 PAA + 8 related. |
| The LLM invents the queries | 14 of 42 candidates had zero demand on every source; 21 of 42 were queries the site already ranks top 3 for. |
| 9 is structurally out of reach in MX | Best case with strong Search Console data: base 1 + autocomplete 1 + GSC 2 + brands 1 + small sites 1 + intent 1 + geo 1 = 8. The 9th point needs Trends, Bing, a forum result, or a competitor-gap title that equals the query exactly. Best real candidate ("renta de baños portatiles guadalajara", 74 GSC impressions, position 7) scored 8. |
| Real demand exists and is not used as the source | Search Console queries with >=10 impressions in 60 days at position worse than 3: Luvory 74, Yume 41, Dizayn MX 33, Dizayn SEO 13, Vexon 11, Dizayn US 3. |
| Past topics mostly missed | 12 of 89 published topics got any impression on their exact target query in the last 28 days. |

Root cause: the pipeline is "LLM proposes, code verifies". The proposals are plausible phrases nobody types, so verification correctly rejects them. The fix is to reverse the order.

## 2. Design: measured queries first, LLM chooses among them

1. **Demand pool (code only, no LLM).** Per site, collect real queries with their numbers:
   - Search Console, 60 days, position worse than 3 (free, strongest).
   - Google autocomplete expansion: each seed (top GSC queries + service names from the site profile) with modifiers (`para`, `precio`, `cuánto`, `cómo`, `qué`, `vs`, cities; English equivalents for US sites). A phrase Google suggests is a phrase people type.
   - Bing related keywords with impressions (useful for the US sites).
   - Serper PAA and related searches (US sites today; MX after the probe in T5).
   - Drop for free, before any Serper call: queries the site already holds at position <=3 in GSC, and queries whose words match an existing post or backlog slug.
2. **Clusters.** Queries with the same significant words (accents, stopwords and word order ignored) are one topic. Cluster demand is the sum of its members. "oficinas moviles guadalajara" + "oficinas moviles en guadalajara" + "renta de oficinas móviles guadalajara" is one topic with 45 impressions, not three weak ones.
3. **LLM pick (1 call instead of 3).** The model gets the pool and picks up to 12 clusters for the ideal customer, writes title/slug/action/why. The `query` must be a pool entry; code rejects anything else. About two thirds fewer research tokens.
4. **SERP check (Serper, only for picked clusters).** Winnability and own rank, as today.
5. **Score v2 in code**, threshold stays 9.

### Score v2 (10 points)

Demand, 0-5, best single source on the cluster, plus a second-signal bonus:

| Evidence | Points |
|---|---|
| GSC cluster impressions 60d: >=50 / >=20 / >=10 / >=1 | 5 / 4 / 3 / 2 |
| Bing exact or related impressions: >=50 / >=10 | 4 / 3 |
| Verbatim Google autocomplete suggestion, PAA or related search | 3 |
| A second independent source also present, or Trends on the head term flat/up/seasonal peak within 8 weeks | +1 (cap 5) |
| None | 0, dropped as "no measured demand" |

Winnability, 0-3: at most 2 big brands in the top 10; no top-10 title that already targets the query, or a forum/thin result is present; own page absent or at position 4-30 (top 3 stays excluded).

Fit, 0-2: belongs to an ideal-customer segment of the audience brief; clear intent with the local modifier when the business is local.

A 9 therefore means: strong GSC demand, or two independent demand signals, plus a winnable SERP and customer fit. Autocomplete alone tops out at 8.

### Trends, used differently
Only on 3-5 head terms per site per week (2-3 words, where Trends has data), cached 14 days. About 25 calls a week across the fleet instead of 12 long-tail calls per site. Never called from tests or probes.

## 3. Tickets (Codex, verified by Claude, straight to main)

| # | Ticket | Acceptance |
|---|---|---|
| T1 | `buildDemandPool()` in `topicdata.ts`: GSC + autocomplete expansion + Bing related, free pre-filters, each entry `{query, source, impressions, position}` | Unit tests with fixtures; pool for Luvory from the live DB has >=60 entries |
| T2 | `clusterQueries()` | The three Vexon variants above become one cluster of 45 |
| T3 | Researcher: one pick call, query must be in the pool | Test: an out-of-pool query is rejected and logged |
| T4 | `scoreTopic` v2 + `evidenceLine` names the signal that gave the demand; old tests replaced | Table-driven tests for every row of the rubric |
| T5 | Trends on head terms; probe Serper MX for PAA (`hl=es-419`, no `gl`) and wire it only if it returns data | No Trends call in `npm test` |
| T6 | `npm run wd -- research-replay <site>`: pool, clusters and score from the DB and cached SERPs, no LLM, no Trends | Prints the funnel; this is the gate before the live run |
| T7 | Outcome report: published topics by score bucket vs impressions 28 days after publish | Shown in `/agents`; baseline today is 12 of 89 |

Order: T1, T2, T6 (replay shows how many 9+ each site can produce before anything changes live), then T4, T3, T5, T7.

## 4. What to expect, honestly

- Luvory, Yume, Dizayn MX: the pools are large enough for several 9+ per week for many weeks.
- Vexon, Dizayn SEO, Dizayn US: the measured market is small (11, 13 and 3 queries). Some weeks will keep 1-3 or none. The run should say "pool exhausted" instead of padding. More topics there need more demand data, not a looser score.
- The replay numbers from T6 replace these estimates before go-live.

## 5. Owner decisions

1. Approve score v2 (threshold stays 9, the meaning of 9 changes as in section 2).
2. Backlog: 60 topics with status `new` were scored 5.7-6.9 by the old rubric. Recommended: re-score them with v2 and reject those under 9.
3. Optional later: Google Ads Keyword Planner volumes (needs an Ads account and API token) would be the one source that gives real Google volume in Mexico.
