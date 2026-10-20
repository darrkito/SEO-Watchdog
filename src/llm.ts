// Claude calls used by competitor discovery: structured JSON answers and localized web search.
import Anthropic from '@anthropic-ai/sdk';

// Haiku: about a cent per discovery with Serper doing the searches. Set WATCHDOG_MODEL for a stronger model.
export const MODEL = process.env.WATCHDOG_MODEL || 'claude-haiku-5-5';
// Claude's own web search (the no-Serper path) needs Opus/Sonnet-class models.
export const canWebSearch = /^claude-(opus|sonnet|fable)-/.test(MODEL);
// $/MTok for cost reporting; unknown models report tokens only.
const PRICE: Record<string, [number, number]> = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5] };
const SEARCH_USD = 0.01;

export type Usage = { input: number; output: number; searches: number };
export const newUsage = (): Usage => ({ input: 0, output: 0, searches: 0 });
export const costUsd = (u: Usage) => {
  const p = PRICE[MODEL];
  return p ? +((u.input * p[0] + u.output * p[1]) / 1e6 + u.searches * SEARCH_USD).toFixed(4) : null;
};

let client: Anthropic | null = null;
export const hasLlm = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const claude = () => (client ??= new Anthropic());

// Server-side fallback re-runs a declined request on another model inside the same call. Haiku has none.
const BASE = /^claude-(opus-5|sonnet-5-5|fable-5-1)/.test(MODEL)
  ? { model: MODEL, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
  : { model: MODEL };

function track(u: Usage, res: any) {
  u.input += (res.usage?.input_tokens ?? 0) + (res.usage?.cache_read_input_tokens ?? 0) + (res.usage?.cache_creation_input_tokens ?? 0);
  u.output += res.usage?.output_tokens ?? 0;
  u.searches += res.usage?.server_tool_use?.web_search_requests ?? 0;
}

/** One request whose answer must match `schema` (JSON Schema). Throws on refusal or unparsable output. */
export async function askJson<T>(u: Usage, system: string, prompt: string, schema: object, effort: 'low' | 'medium' = 'low'): Promise<T> {
  const res: any = await claude().beta.messages.create({
    ...BASE, max_tokens: 16000, system,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort, format: { type: 'json_schema', schema } },
  } as any);
  track(u, res);
  if (res.stop_reason === 'refusal') throw new Error(`model declined: ${res.stop_details?.category ?? 'unknown'}`);
  if (res.stop_reason === 'max_tokens') throw new Error('model answer was cut off (max_tokens)');
  const text = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  return JSON.parse(text) as T;
}

export type Loc = { city?: string; region?: string; country?: string };

/**
 * Web results for one query, in the order the search engine returned them. Positions come from the
 * web_search_result blocks themselves, never from model-written text.
 */
export async function webSearch(u: Usage, query: string, loc: Loc): Promise<{ url: string; title: string; position: number }[]> {
  if (!canWebSearch) throw new Error(`${MODEL} can't run web search: set SERPER_API_KEY, or WATCHDOG_MODEL=claude-sonnet-5-5`);
  const user_location = loc.country ? { type: 'approximate', country: loc.country, ...(loc.city && { city: loc.city }), ...(loc.region && { region: loc.region }) } : undefined;
  const messages: any[] = [{ role: 'user', content: `Search the web for exactly this query and nothing else: ${query}\nThen reply "done".` }];
  const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 1, ...(user_location && { user_location }) }];
  const out: { url: string; title: string; position: number }[] = [];
  for (let turn = 0; turn < 3; turn++) {
    const res: any = await claude().beta.messages.create({ ...BASE, max_tokens: 4000, tools, messages, output_config: { effort: 'low' } } as any);
    track(u, res);
    for (const b of res.content) {
      if (b.type !== 'web_search_tool_result' || !Array.isArray(b.content)) continue; // an error result is an object, not a list
      for (const r of b.content) if (r.type === 'web_search_result' && r.url) out.push({ url: r.url, title: r.title ?? '', position: out.length + 1 });
    }
    if (res.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: res.content });
  }
  return out;
}
