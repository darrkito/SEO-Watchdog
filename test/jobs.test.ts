import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { AGENTS, LimitError } from '../src/agents/agents.ts';
import { runAgent, resumeQueued, retryQueued, dismissQueued, retryAllFailed, setLimitRetry, serial } from '../src/agents/scheduler.ts';
import { jobLabel, listJobs, setStage } from '../src/agents/jobs.ts';

test('clicked job states, retries, dismissal, limit and resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-')); const db = openDb(join(dir, 'db'));
  const old = AGENTS.collect; const token = process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    db.prepare("INSERT INTO sites (id,url) VALUES (101,'https://example.com')").run();
    const site = db.prepare('SELECT * FROM sites WHERE id=101').get() as any;
    (AGENTS as any).collect = async () => { throw new Error('broken'); };
    await runAgent(db, 'collect', site, null, { slug: 'a' });
    let q = db.prepare('SELECT * FROM agent_queue').get() as any;
    assert.equal(q.state, 'failed'); assert.equal(q.last_error, 'broken'); assert.equal(q.attempts, 1);
    assert.equal(resumeQueued(db), 0);
    db.prepare("INSERT INTO agent_settings (agent,site_id,enabled) VALUES ('*',0,0)").run();
    await runAgent(db, 'collect', site, null, { slug: 'a' });
    q = db.prepare('SELECT * FROM agent_queue').get() as any; assert.equal(q.state, 'queued'); assert.equal(q.last_error, null);
    dismissQueued(db, q.id); assert.ok(db.prepare('SELECT id FROM agent_queue').get());
    db.prepare("UPDATE agent_queue SET state='failed' WHERE id=?").run(q.id);
    retryQueued(db, q.id); assert.equal((db.prepare('SELECT state FROM agent_queue').get() as any).state, 'queued');
    db.prepare("UPDATE agent_queue SET state='failed' WHERE id=?").run(q.id);
    db.prepare("INSERT INTO agent_queue (agent,site_id,slug,state) VALUES ('collect',101,'b','failed'),('collect',101,'c','failed')").run();
    assert.equal(retryAllFailed(db, 999), 0); assert.equal(retryAllFailed(db, 101), 3);
    db.prepare("UPDATE agent_queue SET state='failed' WHERE slug='c'").run();
    dismissQueued(db, (db.prepare("SELECT id FROM agent_queue WHERE slug='c'").get() as any).id);
    assert.equal(db.prepare("SELECT id FROM agent_queue WHERE slug='c'").get(), undefined);
    (AGENTS as any).collect = async () => 'ok';
    db.prepare("UPDATE agent_settings SET enabled=1 WHERE agent='*'").run();
    assert.equal(resumeQueued(db), 2); await serial(async () => {});
    assert.equal((db.prepare('SELECT count(*) n FROM agent_queue').get() as any).n, 0);
    setLimitRetry(3600000); (AGENTS as any).collect = async () => { throw new LimitError('limit'); };
    await runAgent(db, 'collect', site, null, { slug: 'limited' });
    q = db.prepare('SELECT * FROM agent_queue').get() as any; assert.equal(q.state, 'queued'); assert.equal(q.last_error, 'waiting for the usage limit to reset');
  } finally { (AGENTS as any).collect = old; setLimitRetry(1800000); if (token !== undefined) process.env.TELEGRAM_BOT_TOKEN = token; db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('progress, job labels and lists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-')); const db = openDb(join(dir, 'db'));
  try {
    db.exec("INSERT INTO sites (id,url) VALUES (1,'https://example.com'),(2,'https://other.com'); INSERT INTO topics (id,site_id,title,slug) VALUES (5,1,'Topic title','topic'); INSERT INTO runs (id,site_id,status) VALUES (1,1,'ok'); INSERT INTO pages (id,site_id,url) VALUES (1,1,'https://example.com/blog/post'); INSERT INTO snapshots (page_id,run_id,extract_json) VALUES (1,1,'{\"h1\":[\"Page title\"]}');");
    assert.equal(jobLabel(db,1,'writer','topic:5'),'Topic title'); assert.equal(jobLabel(db,1,'fixer','ids:1,2'),'2 issues to fix'); assert.equal(jobLabel(db,1,'writer','post'),'Page title'); assert.equal(jobLabel(db,1,'writer','unknown'),'unknown'); assert.equal(jobLabel(db,1,'writer',''),'writer');
    db.exec("INSERT INTO agent_runs (id,agent,site_id,detail) VALUES (1,'writer',1,'post'); INSERT INTO agent_runs (id,agent,site_id,status,output) VALUES (2,'fixer',1,'ok','x');");
    for (let i=0;i<85;i++) setStage(db,1,'building',String(i));
    assert.equal(JSON.parse((db.prepare('SELECT progress FROM agent_runs WHERE id=1').get() as any).progress).length,80);
    db.exec("INSERT INTO agent_queue (agent,site_id,slug,state,attempts,last_error) VALUES ('writer',1,'post','running',2,NULL),('fixer',1,'one','queued',0,NULL),('fixer',1,'two','queued',0,NULL),('writer',1,'bad','failed',1,'oops'),('writer',2,'other','queued',0,NULL)");
    const jobs = listJobs(db,1); assert.equal(jobs.running[0].stageLabel,'Codex is building'); assert.equal(jobs.running[0].attempts,2); assert.equal(jobs.running[0].steps.length,12); assert.equal(jobs.running[0].steps[0].note,'84'); assert.deepEqual(jobs.waiting.map(j => j.position),[1,2]); assert.equal(jobs.failed[0].error,'oops'); assert.equal(jobs.recent[0].status,'ok'); assert.equal(jobs.recent[0].output,'x');
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});
