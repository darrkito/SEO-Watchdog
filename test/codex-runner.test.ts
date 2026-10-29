// Codex runner: env allowlist, subscription check, argv, BLOCKED and limit handling, with a fake codex on PATH (the real one is never called).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexEnv, resetCodexAuthCache, assertCodexSubscription, runCodex, parseLimitReset } from '../src/agents/runner.ts';

const originalPath = process.env.PATH, dirs: string[] = [];
function fakeCodex(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-codex-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'codex'), '#!/bin/sh\n' + script, { mode: 0o755 });
  process.env.PATH = dir + ':' + (originalPath ?? '');
  return dir;
}
afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetCodexAuthCache();
});
function script(exec: string, login = "printf '%s\\n' 'Logged in using ChatGPT'"): string {
  return `if [ "$1" = login ] && [ "$2" = status ]; then
  ${login}
  exit 0
fi
[ "$1" = exec ] || exit 2
base=$(dirname "$0")
printf '%s\\n' "$@" >> "$base/argv.log"
cat > "$base/stdin.txt"
printf '%s\\n' "$$" > "$base/pid.txt"
last=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then shift; last=$1; fi
  shift
done
${exec}
`;
}

test('codexEnv keeps only allowed environment variables', () => {
  assert.deepEqual(codexEnv({ PATH: '/bin', HOME: '/home/test', CODEX_HOME: '/codex', OPENAI_API_KEY: 'a', ANTHROPIC_API_KEY: 'b', CODEX_API_KEY: 'c', TELEGRAM_BOT_TOKEN: 'd' }),
    { PATH: '/bin', HOME: '/home/test', CODEX_HOME: '/codex' });
});

test('subscription check accepts ChatGPT on stdout or stderr and rejects API keys', () => {
  resetCodexAuthCache();
  fakeCodex(script('', "printf '%s\\n' 'Logged in using ChatGPT'"));
  assert.doesNotThrow(assertCodexSubscription);
  resetCodexAuthCache();
  fakeCodex(script('', "printf '%s\\n' 'Logged in using ChatGPT' >&2"));
  assert.doesNotThrow(assertCodexSubscription);
  resetCodexAuthCache();
  fakeCodex(script('', "printf '%s\\n' 'Logged in using an API key'"));
  assert.throws(assertCodexSubscription, /not logged in with a ChatGPT plan/);
});

test('runCodex passes sandbox, cwd, ephemeral, model and prompt', async () => {
  resetCodexAuthCache();
  const dir = fakeCodex(script('printf "  DONE\\n" > "$last"'));
  const prompt = 'Do the requested work.\nKeep this exact prompt.\n';
  const result = await runCodex({ prompt, cwd: dir, write: true, timeoutMs: 2000, model: 'test-model' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'DONE');
  const argv = readFileSync(join(dir, 'argv.log'), 'utf8').split('\n');
  assert.equal(argv[argv.indexOf('-s') + 1], 'workspace-write');
  assert.ok(argv.includes('--ephemeral'));
  assert.equal(argv[argv.indexOf('-C') + 1], dir);
  assert.equal(argv[argv.indexOf('-m') + 1], 'test-model');
  assert.equal(readFileSync(join(dir, 'stdin.txt'), 'utf8'), prompt);
  writeFileSync(join(dir, 'argv.log'), '');
  const readOnly = await runCodex({ prompt, cwd: dir, write: false, timeoutMs: 2000 });
  assert.equal(readOnly.ok, true);
  const args = readFileSync(join(dir, 'argv.log'), 'utf8').split('\n');
  assert.equal(args[args.indexOf('-s') + 1], 'read-only');
});

test('BLOCKED output is reported as blocked', async () => {
  resetCodexAuthCache();
  const dir = fakeCodex(script('printf "BLOCKED: anchor missing\\n" > "$last"'));
  const result = await runCodex({ prompt: 'test', cwd: dir, write: false, timeoutMs: 2000 });
  assert.equal(result.blocked, true);
  assert.equal(result.ok, false);
  assert.match(result.error!, /^BLOCKED:/);
});

test('usage limit on stderr is reported as limited', async () => {
  resetCodexAuthCache();
  const dir = fakeCodex(script('printf "%s\\n" "You\'ve hit your usage limit" >&2\nexit 1'));
  const result = await runCodex({ prompt: 'test', cwd: dir, write: false, timeoutMs: 2000 });
  assert.equal(result.limited, true);
  assert.equal(result.ok, false);
});

test('timeout kills the child and reports timeout', async () => {
  resetCodexAuthCache();
  const dir = fakeCodex(script('exec sleep 5'));
  const result = await runCodex({ prompt: 'test', cwd: dir, write: false, timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.match(result.error!, /timeout/);
  const pid = Number(readFileSync(join(dir, 'pid.txt'), 'utf8'));
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); } catch (e) { assert.equal((e as NodeJS.ErrnoException).code, 'ESRCH'); return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('timeout child is still running');
});


test('parseLimitReset parses Claude reset times and clamps them', () => {
  const now = new Date('2026-10-29T18:00:00Z');
  assert.equal(parseLimitReset("You've hit your 5-hour limit · resets 8:40pm (Europe/London)", now), Date.parse('2026-10-29T20:42:00Z'));
  assert.equal(parseLimitReset('resets 8pm (Europe/London)', now), Date.parse('2026-10-29T20:02:00Z'));
  const localNow = new Date('2026-10-29T12:00:00');
  assert.equal(parseLimitReset('resets 2pm', localNow), new Date('2026-10-29T14:02:00').getTime());
  assert.equal(parseLimitReset('Codex usage limit resets 8pm', now), null);
  assert.equal(parseLimitReset('garbage', now), null);
  assert.equal(parseLimitReset('resets 6pm (Europe/London)', now), now.getTime() + 300000);
  assert.equal(parseLimitReset('resets 8pm (Europe/London)', new Date('2026-10-29T21:00:00Z')), Date.parse('2026-10-30T03:00:00Z'));
  assert.equal(parseLimitReset('resets 1am (Europe/London)', new Date('2026-10-29T23:00:00Z')), Date.parse('2026-10-30T01:02:00Z'));
});
