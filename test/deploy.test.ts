import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployAfterPush } from '../src/agents/agents.ts';
import { AGENT_SITES } from '../src/agents/sites.ts';

test('deploy after push handles missing configuration, failures, and success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-deploy-'));
  const script = join(dir, 'deploy.sh');
  const marker = join(dir, 'marker');
  const cfg = { ...AGENT_SITES['dizaynseo.com'], deployCmd: [script] };
  const savedToken = process.env.DIZAYNSEO_VERCEL_TOKEN;
  const savedTelegram = process.env.TELEGRAM_BOT_TOKEN;
  try {
    delete process.env.TELEGRAM_BOT_TOKEN;
    assert.equal(await deployAfterPush({ ...cfg, deployCmd: undefined }), '');
    writeFileSync(script, `#!/bin/sh\nprintf executed > '${marker}'\n`);
    chmodSync(script, 0o700);
    delete process.env.DIZAYNSEO_VERCEL_TOKEN;
    assert.match(await deployAfterPush(cfg), /^deploy skipped/);
    assert.equal(existsSync(marker), false);
    process.env.DIZAYNSEO_VERCEL_TOKEN = 'tok_SECRET_123';
    writeFileSync(script, '#!/bin/sh\necho "$VERCEL_TOKEN"\nexit 1\n');
    const failed = await deployAfterPush(cfg);
    assert.match(failed, /^deploy failed/);
    assert.doesNotMatch(failed, /tok_SECRET_123/);
    writeFileSync(script, `#!/bin/sh\nprintf '%s' "$VERCEL_TOKEN" > '${marker}'\n`);
    assert.equal(await deployAfterPush(cfg), 'deployed');
    assert.equal(readFileSync(marker, 'utf8'), 'tok_SECRET_123');
  } finally {
    if (savedToken === undefined) delete process.env.DIZAYNSEO_VERCEL_TOKEN; else process.env.DIZAYNSEO_VERCEL_TOKEN = savedToken;
    if (savedTelegram === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = savedTelegram;
    rmSync(dir, { recursive: true, force: true });
  }
});
