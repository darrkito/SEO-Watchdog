// Runs `claude -p` on the Claude SUBSCRIPTION, never the API. The child env is built from scratch so ANTHROPIC_API_KEY
// (which SEO-Watchdog/.env holds for competitor discovery) can never reach it; the login must say `claude.ai`.
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

export function codexEnv(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'USER', 'SHELL', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'NVM_DIR', 'CODEX_HOME'];
  return Object.fromEntries(keep.filter((k) => src[k] !== undefined).map((k) => [k, src[k]!]));
}

let codexAuthChecked = 0;
export function resetCodexAuthCache(): void { codexAuthChecked = 0; }

export function assertCodexSubscription(): void {
  if (Date.now() - codexAuthChecked < 600_000) return;
  const r = spawnSync('codex', ['login', 'status'], { env: codexEnv(), encoding: 'utf8', timeout: 30_000 });
  const text = (r.stdout ?? '') + (r.stderr ?? '') + (r.error ? String(r.error.message) : '');
  if (!text.includes('Logged in using ChatGPT')) throw new Error(`Codex is not logged in with a ChatGPT plan (got: ${text.trim().slice(0, 200)}); refusing to run it on an API key.`);
  codexAuthChecked = Date.now();
}

export type CodexResult = { ok: boolean; limited: boolean; blocked: boolean; text: string; error?: string };

export function runCodex(o: { prompt: string; cwd: string; write: boolean; timeoutMs: number; model?: string }): Promise<CodexResult> {
  assertCodexSubscription();
  return new Promise((resolve) => {
    let dir = '', done = false, timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: CodexResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (dir) rmSync(dir, { recursive: true, force: true }); }
      catch (e) { result = { ok: false, limited: false, blocked: false, text: '', error: (e as Error).message }; }
      resolve(result);
    };
    const fail = (err: Error) => finish({ ok: false, limited: false, blocked: false, text: '', error: err.message });
    try {
      dir = mkdtempSync(join(tmpdir(), 'codex-'));
      const lastFile = join(dir, 'last.txt');
      const child = spawn('nice', ['-n', '19', 'codex', 'exec', '-C', o.cwd, '-s', o.write ? 'workspace-write' : 'read-only',
        '--ephemeral', '--color', 'never', '-o', lastFile, ...(o.model ? ['-m', o.model] : []), '-'],
      { cwd: o.cwd, env: codexEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ ok: false, limited: false, blocked: false, text: '', error: `timeout after ${Math.round(o.timeoutMs / 1000)}s` });
      }, o.timeoutMs);
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', fail);
      child.stdin.on('error', () => {}); // An early exit can close stdin before the prompt is written.
      child.on('close', (code) => {
        if (done) return;
        try {
          const text = (existsSync(lastFile) ? readFileSync(lastFile, 'utf8') : '').trim();
          const blocked = /^BLOCKED:/m.test(text), failed = code !== 0 || text === '';
          const limited = failed && /usage limit|rate.?limit|limit reached|quota|too many requests|429/i.test(stderr + stdout + text);
          const ok = !failed && !blocked;
          finish({ ok, limited, blocked, text, ...(!ok ? { error: blocked ? text.split('\n').find((line) => line.startsWith('BLOCKED:'))! : (limited ? ((stderr + stdout).split('\n').find((line) => /usage limit|rate.?limit|limit reached|quota|too many requests|429/i.test(line)) ?? 'usage limit') : (stderr || stdout || `exit ${code}`)).slice(0, 500) } : {}) });
        } catch (e) { fail(e as Error); }
      });
      child.stdin.end(o.prompt);
    } catch (e) { fail(e as Error); }
  });
}
