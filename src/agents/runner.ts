// Runs `claude -p` on the Claude SUBSCRIPTION, never the API. The child env is built from scratch so ANTHROPIC_API_KEY
// (which SEO-Watchdog/.env holds for competitor discovery) can never reach it; the login must say `claude.ai`.
import { spawn, execFileSync } from 'node:child_process';

export type ClaudeResult = { ok: boolean; limited: boolean; text: string; tokensIn: number; tokensOut: number; costUsd: number; error?: string };

/** Only what the CLI needs. Anything ANTHROPIC_* / API-ish is dropped by construction (allowlist, not blocklist). */
export function cleanEnv(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'USER', 'SHELL', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'NVM_DIR'];
  return Object.fromEntries(keep.filter((k) => src[k]).map((k) => [k, src[k]!]));
}

let authChecked = 0;
/** Throws unless the CLI is logged in with a claude.ai subscription. Cached for 10 min. */
export function assertSubscription(): void {
  if (Date.now() - authChecked < 600_000) return;
  let s: { loggedIn?: boolean; authMethod?: string };
  try { s = JSON.parse(execFileSync('claude', ['auth', 'status'], { env: cleanEnv(), encoding: 'utf8', timeout: 30_000 })); }
  catch (e) { throw new Error(`claude auth status failed: ${(e as Error).message}`); }
  if (!s.loggedIn || s.authMethod !== 'claude.ai') throw new Error(`Claude CLI is not on the subscription (authMethod=${s.authMethod}); refusing to run agents on the API.`);
  authChecked = Date.now();
}

const LIMIT = /usage limit|rate.?limit|limit reached|quota|overloaded|too many requests|529|429/i;

export function runClaude(o: { prompt: string; cwd: string; tools: string[]; maxTurns: number; timeoutMs: number; model?: string }): Promise<ClaudeResult> {
  assertSubscription();
  const args = ['-n', '19', 'claude', '-p', '--output-format', 'json', '--max-turns', String(o.maxTurns), '--no-session-persistence',
    '--setting-sources', 'project', '--model', o.model ?? process.env.AGENT_MODEL ?? 'sonnet',
    '--tools', o.tools.join(','), '--allowedTools', o.tools.join(',')];
  return new Promise((resolve) => {
    const child = spawn('nice', args, { cwd: o.cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      let j: any;
      try { j = JSON.parse(out); } catch { /* not JSON: crash or timeout */ }
      if (!j) { const msg = (err || out || `exit ${code}`).slice(0, 500); return resolve({ ok: false, limited: LIMIT.test(msg), text: '', tokensIn: 0, tokensOut: 0, costUsd: 0, error: msg }); }
      const u = j.usage ?? {};
      const text = String(j.result ?? '');
      resolve({
        ok: !j.is_error && j.subtype === 'success', limited: !!j.is_error && LIMIT.test(text + (j.api_error_status ?? '')), text,
        tokensIn: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), tokensOut: u.output_tokens ?? 0,
        costUsd: j.total_cost_usd ?? 0, // list-price equivalent; on the subscription nothing is billed per token
        error: j.is_error || j.subtype !== 'success' ? `${j.subtype}: ${text}`.slice(0, 500) : undefined,
      });
    });
    child.stdin.end(o.prompt);
  });
}

/** Pull the first JSON object/array out of a model reply (plain, or inside a ```json fence). */
export function extractJson<T = unknown>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error('no JSON in reply');
  const open = body[start], close = open === '{' ? '}' : ']';
  return JSON.parse(body.slice(start, body.lastIndexOf(close) + 1));
}
