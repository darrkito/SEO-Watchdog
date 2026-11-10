# Token and cost reduction plan (2026-11-10)

Goal: same or better drafts at well under half the cost. Claude plans and verifies; Codex implements tickets A to D in order.
Baseline commit: `ef37988`. Tests: `npm test` (197 pass, 1 skipped).

## Measured today (agent_runs + pm2 log, last 14 days)

| Fact | Number |
|---|---|
| Spend, list-price equivalent | $320 in 14 days; writer + improver are $305 of it |
| Failed writer/improver runs | 176 of 382 finished runs, $154 (50% of the spend); last 7 days $64 of $155 |
| Cost per successful draft | $1.23 blended (last 7 days); $0.55 when everything passes first time |
| Happy-path split | plan output ~$0.19, research ~$0.15, plan input ~$0.11, review ~$0.10 |
| Extra plan in a run that still succeeds | 25% of ok runs (each ~$0.26) |
| Cause of plan rejections | 51 of 54 are "internal link does not exist": the planner is never given a list of valid links |
| Prompt caching on single-shot calls | every no-tool call pays a 1-hour cache WRITE at 2x input price and never reads it (tested: 15.4k tokens cost $0.0616 cached vs $0.0308 with caching off) |
| Research call | ~115k cumulative input tokens for a 3k-char prompt (6 web turns), on Sonnet; cache key includes the date, so a retry next day pays again |
| Codex executor | copies text the code already computes (`simulateOrder`); 14 BLOCKED of 327 runs, each one a wasted Claude round |
| Worst site | dizaynseo improver: 21 ok / 55 failed in 7 days, $31 wasted |
| Legacy Claude executor | 64 runs above 600k input tokens (last 2026-10-29); still reachable as a silent fallback when Codex is down |

Analyst ($0.04/run), researcher ($0.14) and fixer ($0.08) are 2% of the spend. They only get the cheap wins (model, cache-off).

## Phase 1 (tickets A to D, dispatched in order; each lands on main with tests green)

| Ticket | Change | Expected effect |
|---|---|---|
| A | Per-call ledger (`agent_calls`), `wd tokens` report, caching off for no-tool calls, Haiku for research + analyst | input cost of plan/review/revise halves; research ~3x cheaper; every later change is measurable per role |
| B | Valid-links list in the plan prompt + validator; patch-mode fix for plan-lint failures (small patch, not a full re-plan) | removes ~94% of plan rejections; a lint fix costs ~1k output tokens, not ~19k |
| C | Apply orders in code (no Codex for writer/improver); no silent fallback to the Claude executor | no BLOCKED rounds, ~35 s faster per round, zero Codex quota for drafts, no 1M-token runs |
| D | Prompt diet (review without playbook, -U3 review diff, revise without duplicated post text), research cache 14 days and 4 turns, no research for structural improves, diagnostics for "no changes made" | smaller review/revise input; improver skips ~$0.15 research when the fix is structural |

Estimate after phase 1: happy path $0.55 -> about $0.30; blended $1.23 -> about $0.55. These are estimates; ticket A's ledger gives the real numbers.

## Phase 2 (decide after 3 days of ledger data)

1. Improver writes targeted edits (replace single paragraphs) instead of rewriting the whole post in ES + EN: output tokens are the largest remaining cost.
2. Plan effort medium -> low, A/B on rejection rate.
3. EN twin translated by Haiku in a separate call.
4. Round 2+ review sees only the incremental diff.
5. dizaynseo: locate the ES twin (`_src/posts_es.py`, dict with `"en": "<slug>"`) and hand its text and range to the planner; today it guesses anchors.

## Rollback switches (env, no code change)

`AGENT_APPLY=codex` (ticket C), `AGENT_MODEL_RESEARCH=sonnet`, `AGENT_MODEL_ANALYST=sonnet`, `AGENT_CACHE=1` (ticket A), `AGENT_RESEARCH=0` (existing).

## Verification after each ticket (Claude, outside Codex's sandbox)

`npm test`, `git status --short` (scope), read the diff, then `node src/cli.ts tokens 3` once runs exist. pm2 `seo-watchdog` is restarted only when the queue is empty.
