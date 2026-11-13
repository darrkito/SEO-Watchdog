export type Diagnosis = { kind: 'executor' | 'check' | 'missing-context' | 'repeat' | 'content'; action: string };

/** problems: this round's prefixed problems; earlier: shortened problems from earlier rounds. */
export function diagnose(problems: string[], earlier: string[]): Diagnosis {
  if (problems.some((p) => p.startsWith('executor'))) return { kind: 'executor', action: 'Reescribir el paso que no se pudo aplicar con el texto literal del archivo actual (copiar el ancla del diff); no tocar los demás pasos.' };
  if (problems.some((p) => p.startsWith('check:') || p.startsWith('plan text:'))) return { kind: 'check', action: 'Corregir exactamente lo que dice el check y nada más; el código lo vuelve a comprobar antes de la revisión.' };
  const reviewer = problems.filter((p) => p.startsWith('reviewer:'));
  if (reviewer.length && reviewer.every((p) => /no (se )?(ve|muestra|aparece|es visible|puedo (ver|confirmar))|no (es )?(posible )?(determinar|verificar|confirmar)|contexto|not visible|cannot see|can't see/i.test(p))) return { kind: 'missing-context', action: 'No es un defecto del texto: el revisor no vio suficiente contexto. Repetir la revisión con el diff completo y los hechos verificados por el código, sin tocar archivos.' };
  const normalize = (p: string) => p.replace(/^reviewer: /, '').toLowerCase().replace(/\d/g, '#').replace(/\s+/g, ' ').slice(0, 100);
  if (reviewer.some((p) => earlier.some((old) => normalize(p) === normalize(old)))) return { kind: 'repeat', action: 'El revisor repite una objeción que la corrección no cambió: no reintentar a ciegas. El borrador queda en su rama; aprobarlo tal cual o dar una orden de cambio exacta desde el dashboard.' };
  return { kind: 'content', action: 'Aplicar la orden de cambio del revisor exactamente (pasos con texto literal) y no tocar nada fuera de ella.' };
}

export function rejectionMessage(prefix: string, problems: string[], dx: Diagnosis): string {
  const start = `${prefix}: `;
  const end = ` | → qué hacer (${dx.kind}): ${dx.action}`;
  return start + problems.map((p) => p.slice(0, 160)).join('; ').slice(0, Math.max(0, 480 - start.length - end.length)) + end;
}
