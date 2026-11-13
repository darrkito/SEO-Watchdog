import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dizaynContract } from '../src/agents/hooks.ts';
import { AGENT_SITES } from '../src/agents/sites.ts';

test('Dizayn contract reports the current twin structure and handles missing data', () => {
  const wt = mkdtempSync(join(tmpdir(), 'post-contract-'));
  try {
    mkdirSync(join(wt, '_src'));
    writeFileSync(join(wt, '_src/posts.py'), `POSTS=[{"slug":"a","mins":5,"h":["x","y","z"]},{"slug":"b","mins":5,"h":[]}]
def render(p): return "".join('<h2 id="%s">T</h2><a href="https://e.com/%s">l</a>' % (i,i) for i in p["h"])
`);
    writeFileSync(join(wt, '_src/posts_es.py'), `import posts as P
from posts import render
POSTS_ES=[{"en":"a","slug":"es-a","mins":5,"h":["x","z"]}]
def twin_of(s): return next((t for t in POSTS_ES if t["en"]==s),None)
def render_es(t): return render(t)
`);
    const contract = dizaynContract(wt, 'a');
    for (const expected of ['["x","y","z"]', '["x","z"]', 'es-a', 'EXACTAMENTE', 'mins 5', 'enlaces externos 3', 'enlaces externos 2']) assert.ok(contract.includes(expected));
    assert.equal(dizaynContract(wt, 'b'), '');
    mkdirSync(join(wt, 'broken'));
    assert.equal(dizaynContract(join(wt, 'broken'), 'a'), '');
    assert.equal(AGENT_SITES['dizaynseo.com'].postContract, dizaynContract);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});
