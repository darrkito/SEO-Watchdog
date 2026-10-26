// The owner's ideal-customer brief steers every agent: what to write about, in what tone, and what NOT to attract.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Segment = 'event' | 'planner' | 'corporate-event' | 'bulk' | 'labels' | 'other';
/** Segments the owner wants to grow. */
export const TARGET = new Set<Segment>(['event', 'planner', 'corporate-event']);

const RX = {
  planner: /planner|organizador[a]?s? de (eventos|bodas|fiestas)|coordinador[a]?s? de (eventos|bodas)|proveedor(es)? (de|para) (bodas|eventos|planners)/i,
  corporate: /posada|corporativ|empresarial|evento[s]? (de|para) (la )?empresa|aniversario|lanzamiento|kit de bienvenida|congreso|evento[s]? con clientes/i,
  event: /boda|novia|novio|baby ?shower|bautizo|comuni[oó]n|xv ?a[nñ]os|quincea|quince|cumplea|graduaci|fiesta|souvenir|recuerdo|dulcero|invitaci|mesa de dulces|tatuaje[s]? temporal|evento|navidad|halloween|d[ií]a de muertos|d[ií]a del ni[nñ]o|despedida de soltera|regalo (para|de)|sorpresa|d[ií]a de la madre/i,
  bulk: /planilla|shampoo|mayoreo|por mayor|f[aá]brica|fabricante|miles de|c[oó]digo de barras|etiquetas? (para|de) (producto|envase|botella)|cu[aá]nto cuesta imprimir/i,
  labels: /etiqueta|sticker|vinil|rollo/i,
};
/** Which customer a query or post speaks to. Order matters: a bulk angle wins over a generic event word. */
export function segmentOf(text: string): Segment {
  if (RX.bulk.test(text)) return 'bulk';
  if (RX.planner.test(text)) return 'planner';
  if (RX.corporate.test(text)) return 'corporate-event';
  if (RX.event.test(text)) return 'event';
  if (RX.labels.test(text)) return 'labels';
  return 'other';
}

/** The brief text for a site host (empty when none is written), to append to agent prompts. */
export function audienceBrief(host: string): string {
  const f = join(import.meta.dirname, 'audience', `${host.replace(/^www\./, '')}.md`);
  return existsSync(f) ? `\n=== BRIEF DE AUDIENCIA DEL DUEÑO (prioridad máxima) ===\n${readFileSync(f, 'utf8')}\n=== FIN DEL BRIEF ===\n` : '';
}

/** The distilled SEO and local-SEO playbook (Get Found + Whitespark 2026), appended to the prompts of every agent that writes or judges SEO. */
export function seoPlaybook(): string {
  const f = join(import.meta.dirname, 'knowledge', 'seo-playbook.md');
  return existsSync(f) ? `\n=== PLAYBOOK DE SEO (reglas a aplicar; las cifras de Whitespark son opinión de expertos) ===\n${readFileSync(f, 'utf8')}\n=== FIN DEL PLAYBOOK ===\n` : '';
}
