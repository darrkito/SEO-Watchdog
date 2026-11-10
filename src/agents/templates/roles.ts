import { readFileSync } from 'node:fs';

export type Role = 'research' | 'plan' | 'revise' | 'review' | 'fixplan' | 'analyst' | 'other';

const rules = readFileSync(new URL('./claude-rules.md', import.meta.url), 'utf8').trimEnd();
const appendices: Record<Role, string> = {
  research: 'Busca solo lo que el tema necesita, abre solo las páginas necesarias y para en cuanto tengas los hechos. Máximo 900 palabras y máximo 12 hallazgos.',
  plan: 'Escribes UNA orden de trabajo en JSON; el texto del post va completo y final; sin comentarios.',
  revise: 'Corriges UNA orden: solo lo que dicen los problemas; JSON.',
  review: 'Decides ok o no; todos los problemas de una vez (como máximo 12), cada uno de máximo 60 palabras; JSON.',
  fixplan: 'Escribes UNA orden de trabajo en JSON; el texto del post va completo y final; sin comentarios.',
  analyst: '',
  other: '',
};
export function systemPrompt(role: Role): string {
  return appendices[role] ? `${rules}\n\n${appendices[role]}` : rules;
}

const defaults: Record<Role, 'low' | 'medium' | 'high'> = {
  research: 'medium', plan: 'medium', revise: 'low', review: 'low', fixplan: 'medium', analyst: 'medium', other: 'medium',
};
export const EFFORT = Object.fromEntries((Object.keys(defaults) as Role[]).map((role) => [role, defaults[role]])) as Record<Role, 'low' | 'medium' | 'high'>;
for (const role of Object.keys(defaults) as Role[]) {
  Object.defineProperty(EFFORT, role, { enumerable: true, get() {
    for (const value of [process.env[`AGENT_EFFORT_${role.toUpperCase()}`], process.env.AGENT_EFFORT]) {
      if (value && /^(low|medium|high|xhigh|max)$/.test(value)) return value;
    }
    return defaults[role];
  } });
}

const modelDefaults: Record<Role, string | undefined> = { research: 'haiku', plan: undefined, revise: undefined, review: undefined, fixplan: undefined, analyst: 'haiku', other: undefined };
export const MODEL = Object.fromEntries((Object.keys(modelDefaults) as Role[]).map((role) => [role, modelDefaults[role]])) as Record<Role, string | undefined>;
for (const role of Object.keys(modelDefaults) as Role[]) {
  Object.defineProperty(MODEL, role, { enumerable: true, get() {
    return process.env[`AGENT_MODEL_${role.toUpperCase()}`] ?? modelDefaults[role];
  } });
}
