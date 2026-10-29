# Token audit, 2026-10-29 (measured from agent_runs since 10-28 and the pm2 call log)

## Where the tokens went (input tokens, Claude only; Codex has its own allowance)
| Bucket | Runs | Input tokens | Note |
|---|---|---|---|
| Failed drafts (improver+writer) | 27 | **9.3M** | ~340k per failed draft: more than a successful one |
| Successful drafts | 12 | 4.0M | ~335k per draft |
| Limit probes ("limited" rows) | 1,343 | 0.7M | each retry started a Claude call that died on the limit message |

## Per call (pm2 log, prompt chars -> tokens)
- Planner WITH web tools (WebSearch+WebFetch, up to 20 turns): **170k to 330k tokens in per call**, 21 to 29k out. Every tool turn re-sends the whole context (playbook, audience, guides, facts, example post, current post, rules).
- Planner/reviewer/reviser WITHOUT tools: 18k to 60k in per call.
- Reviewer prompt 35k to 130k chars: the executed order(s) carry the full new post text AND the diff carries the same text again; grows each round.
- Revise prompt re-sends the ENTIRE original brief (50k to 100k chars) + previous order + diff.
- Auto-retry (T13) multiplies a failed 340k draft by up to 3.

## Redundant work found
1. Web research and planning are one call: research context is re-read every turn. (-> split: small research call, cached; plan call without tools)
2. Research is repeated on every retry/round. (-> cache per site+slug)
3. Revise sends the full brief again. (-> slim brief)
4. Reviewer sees the new text twice. (-> compact order rendering)
5. A retry that fails with the same error as the previous attempt burns another ~340k for nothing. (-> stop on identical failure signature)
6. Limit hit -> every queued job probes Claude. (-> park the queue once, parse the reset time)
7. 50 cancelled "re-check" jobs would each cost a full draft; a review-only mode costs ~1/6.

## Targets
Research+plan: 260k -> ~90k. Revise: 60k -> ~20k. Review: -30%. Failed-draft repeats: capped by signature. Expected per successful draft 335k -> ~130k.

## Templates (phase 2)
Static prompt text moves to versioned template files with {{slots}}; per site/task kind the CODE pre-fills the wiring steps of the order (anchors, index/sitemap/i18n entries) and Claude fills only the content slots; Codex prompts are rendered from the same skeleton.

## Result (same day, 3 real Yume improver test posts)
Shipped: T14 research split+cache, T15 slim revise/compact review/no identical retry, T16 limit parking, T17 Claude rules as system prompt + effort per role, T18 research limits + pre-write checklist, T19 reviewer lists all problems and sees earlier ones, T20 per-site neverWrite lists.
Measured input tokens per draft: before ~335k; first attempts 320k and 313k (failed 3 rounds); after T20 first attempt passed at 217k, of which research 168k (cache reads inflate it) and everything else ~49k.
Open: trim research further (3 turns, snippets only) if wanted; review-only mode for the 50 re-check jobs; phase-2 templates (static prompt text in files, code pre-fills wiring steps). Models unchanged by owner decision.
