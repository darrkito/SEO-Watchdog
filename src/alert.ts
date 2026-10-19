// Instant alerts for critical findings. Telegram when configured; the digest (Phase 7) covers the rest.
import type { RunSummary } from './crawl.ts';

export function alertText(s: RunSummary): string | null {
  const host = new URL(s.site.url).hostname;
  if (s.status === 'suspect')
    return `⚠️ ${host}: run #${s.runId} looks suspect (mass failures vs last run). Findings held; next run confirms or clears it.`;
  const crit = s.newFindings.filter((f) => f.severity === 'critical');
  if (!crit.length) return null;
  const lines = crit.slice(0, 15).map((f) => `• ${f.rule}: ${f.message}${f.subject ? `\n  ${f.subject}` : ''}`);
  if (crit.length > 15) lines.push(`…and ${crit.length - 15} more`);
  return `🚨 ${host}: ${crit.length} new critical finding(s)\n${lines.join('\n')}`;
}

export async function sendAlert(text: string): Promise<boolean> {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = process.env;
  if (!token || !chat) return false;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  if (!r.ok) console.error(`telegram: HTTP ${r.status} ${await r.text()}`);
  return r.ok;
}
