import { parseOrder, orderPrompt, fixPrompt, simulateOrder, preflightOrder, compareFiles, verbatimCheck, type WorkOrder } from './orders.ts';
import type { CodexResult } from './runner.ts';

export class HybridLimit extends Error {}
export type Review = { ok: boolean; problems: string[]; changeOrder?: string };
export type HybridDeps = {
  plan: (prompt: string) => Promise<string>;
  revise: (prompt: string) => Promise<string>;
  execute: (prompt: string) => Promise<CodexResult>;
  verify: () => string | null;
  addedText: () => string;
  diff: () => string;
  review: (order: WorkOrder, diff: string) => Promise<Review>;
  root: string;
  log: (m: string) => void;
};
export type HybridInput = { planPrompt: string; rules: string; allowedPaths: string[]; maxRounds?: number };
export type HybridResult = { orders: WorkOrder[]; review: Review; stages: { plans: number; revisions: number; executions: number; reviews: number; rounds: number } };

export function revisePrompt(problems: string[], diff: string, ctx: { planPrompt: string; previousOrder: WorkOrder }): string {
  return [
    'Below is the ORIGINAL BRIEF you were given, then the order you wrote from it, then why it is not approved. Write a corrected order.',
    '=== ORIGINAL BRIEF ===', ctx.planPrompt, '=== END OF ORIGINAL BRIEF ===',
    '=== YOUR PREVIOUS ORDER (JSON) ===', JSON.stringify(ctx.previousOrder, null, 2), '=== END OF PREVIOUS ORDER ===',
    '=== PROBLEMS ===', ...problems.map((problem) => '- ' + problem),
    '=== CURRENT CHANGES IN THE WORKTREE (diff with context; empty means nothing was written) ===',
    diff.slice(0, 60000) + (diff.length > 60000 ? '\n[diff cut]' : ''), '=== END OF DIFF ===',
    'Return a CHANGE ORDER: the same JSON format as in the brief (analysis, title, meta, steps, mustContain, forbiddenPaths, doneWhen). If the diff is empty, nothing was written: the steps must then apply to the ORIGINAL files exactly as in the brief (use the verified anchors from the brief). If the diff is not empty, the steps fix ONLY the problems against the CURRENT state of the files, and every anchor must occur exactly once in the current files: copy it from the diff context. If a problem says text is not allowed or not in the repo facts, REMOVE that text instead of rewording it. JSON only, no prose.',
  ].join('\n');
}

export async function runHybrid(d: HybridDeps, input: HybridInput): Promise<HybridResult> {
  const stages = { plans: 0, revisions: 0, executions: 0, reviews: 0, rounds: 0 };
  const orders: WorkOrder[] = [];
  let knownClaims: NonNullable<WorkOrder['claims']> = [];
  async function getOrder(ask: (prompt: string) => Promise<string>, firstPrompt: string): Promise<WorkOrder> {
    let problems: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const prompt = firstPrompt + (attempt ? '\n\nYour previous order failed validation. Problems:\n- '
        + problems.join('\n- ') + '\nReturn the COMPLETE corrected order (JSON only).' : '');
      const reply = await ask(prompt);
      let order: WorkOrder;
      try { order = parseOrder(reply, { allowedPaths: input.allowedPaths }); }
      catch (e) { problems = [(e as Error).message]; continue; }
      problems = preflightOrder(order, d.root);
      if (!problems.length) {
        const claims = new Map(knownClaims.map((item) => [item.claim, item]));
        for (const item of order.claims ?? []) claims.set(item.claim, item);
        knownClaims = [...claims.values()];
        if (knownClaims.length || order.claims !== undefined) order.claims = knownClaims;
        return order;
      }
    }
    throw new Error('plan rejected: ' + problems.join('; '));
  }
  const revise = (prompt: string): Promise<string> => {
    stages.revisions++;
    return d.revise(prompt);
  };
  let order = await getOrder((prompt) => { stages.plans++; return d.plan(prompt); }, input.planPrompt);
  for (;;) {
    orders.push(order);
    const expected = simulateOrder(order, d.root).files;
    const check = (): string[] => {
      const problems = [...compareFiles(expected, d.root), ...verbatimCheck(order, d.addedText())];
      if (problems.length) return problems;
      const v = d.verify();
      return v ? [v] : [];
    };
    const r = await d.execute(orderPrompt(order, input.rules));
    stages.executions++;
    if (r.limited) throw new HybridLimit(r.error ?? 'codex usage limit');
    let problems = r.ok ? check() : ['executor: ' + (r.error ?? r.text)];
    if (problems.length && r.ok) {
      const r2 = await d.execute(fixPrompt(problems.join('\n'), [...new Set(order.steps.map((step) => step.file))], input.rules));
      stages.executions++;
      if (r2.limited) throw new HybridLimit(r2.error ?? 'codex usage limit');
      problems = r2.ok ? check() : ['executor could not fix it: ' + (r2.error ?? r2.text)];
    }
    let changeRaw: string | undefined;
    if (!problems.length) {
      const review = await d.review(order, d.diff());
      stages.reviews++;
      if (review.ok) return { orders, review, stages };
      problems = review.problems.map((p) => 'reviewer: ' + p);
      changeRaw = review.changeOrder;
    }
    stages.rounds++;
    if (stages.rounds >= (input.maxRounds ?? 3)) {
      throw new Error('not approved after ' + stages.rounds + ' rounds: ' + problems.join('; '));
    }
    if (changeRaw === undefined) changeRaw = await revise(revisePrompt(problems, d.diff(), { planPrompt: input.planPrompt, previousOrder: order }));
    let first = true;
    order = await getOrder((prompt) => {
      if (first) { first = false; return Promise.resolve(changeRaw!); }
      return revise(prompt);
    }, revisePrompt(problems, d.diff(), { planPrompt: input.planPrompt, previousOrder: order }));
  }
}
