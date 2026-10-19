// HTML building blocks. Everything interpolated is escaped unless wrapped in raw(): crawled pages are untrusted.

export type Html = { __html: string };
export const raw = (s: string): Html => ({ __html: s });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const part = (v: unknown): string =>
  v == null || v === false ? '' : Array.isArray(v) ? v.map(part).join('') : typeof v === 'object' && '__html' in (v as object) ? (v as Html).__html : esc(v);
export const h = (s: TemplateStringsArray, ...v: unknown[]): Html => raw(s.reduce((a, str, i) => a + str + (i < v.length ? part(v[i]) : ''), ''));

/** Only http(s) URLs become links; anything else renders as text. */
export const safeHref = (u: string) => (/^https?:\/\//i.test(u) ? u : '#');
export const pathOf = (u: string) => { try { const x = new URL(u); return x.pathname + x.search || '/'; } catch { return u; } };

export function ago(sqlTime: string | null): string {
  if (!sqlTime) return 'never';
  const s = (Date.now() - Date.parse(sqlTime.replace(' ', 'T') + 'Z')) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

export type Sev = 'critical' | 'warn' | 'info' | 'good';
const SEV_LABEL: Record<Sev, string> = { critical: 'Fix now', warn: 'Improve', info: 'Note', good: 'Healthy' };
const SEV_ICON: Record<Sev, string> = {
  critical: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1z" fill="currentColor"/><path d="M8 6v3.5M8 11.6v.1" stroke="var(--surface)" stroke-width="1.6" stroke-linecap="round"/></svg>',
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="currentColor"/><path d="M8 4.6v4M8 11v.1" stroke="var(--surface)" stroke-width="1.6" stroke-linecap="round"/></svg>',
  info: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 7.2v4M8 4.8v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  good: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="currentColor"/><path d="m5 8.2 2 2 4-4.2" fill="none" stroke="var(--surface)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
/** Status is never color alone: icon + word. */
export const chip = (sev: Sev, label = SEV_LABEL[sev]) => h`<span class="chip ${sev}">${raw(SEV_ICON[sev])}${label}</span>`;

/** Open issues over time: two status series, direct-labelled at the last point, native tooltip per run. */
export function trendChart(points: { at: string; critical: number; warn: number }[]): Html {
  if (points.length < 2) return h`<p class="muted small">The trend appears after the second check.</p>`;
  const max = Math.max(1, ...points.flatMap((p) => [p.critical, p.warn]));
  // Even top value so the midline tick is a whole number of issues.
  const nice = max <= 4 ? 4 : max <= 10 ? max + (max % 2) : Math.ceil(max / 10) * 10;
  const series = [
    { key: 'critical' as const, label: 'Fix now', color: 'var(--s-crit)' },
    { key: 'warn' as const, label: 'Improve', color: 'var(--s-warn)' },
  ];
  const day = (s: string) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const ticks = [0, nice / 2, nice];
  const last = points.length - 1;
  // Drawn at two native widths (CSS shows one) so text renders at true size on desktop and phone.
  const render = (W: number, H: number, cls: string) => {
    const L = 34, R = 104, T = 12, B = 26;
    const x = (i: number) => L + (i * (W - L - R)) / last;
    const y = (v: number) => T + (H - T - B) * (1 - v / nice);
    let ya = y(points[last].critical), yb = y(points[last].warn);
    if (Math.abs(ya - yb) < 16) { const mid = (ya + yb) / 2; [ya, yb] = ya <= yb ? [mid - 8, mid + 8] : [mid + 8, mid - 8]; }
    const labelY = { critical: ya, warn: yb };
    const w = (W - L - R) / last;
    return `<svg class="trend ${cls}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Open issues over the last ${points.length} checks">
    ${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${L - 8}" y="${y(t) + 4}" class="tick" text-anchor="end">${t}</text>`).join('')}
    <line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="axis"/>
    <text x="${L}" y="${H - 6}" class="tick">${esc(day(points[0].at))}</text>
    <text x="${W - R}" y="${H - 6}" class="tick" text-anchor="end">${esc(day(points[last].at))}</text>
    ${series.map((s) => `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${points.map((p, i) => `${x(i)},${y(p[s.key])}`).join(' ')}"/>
      ${points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p[s.key])}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`).join('')}
      <text x="${x(last) + 10}" y="${labelY[s.key] + 4}" class="dlabel">${points[last][s.key]} ${s.label}</text>`).join('')}
    ${points.map((p, i) => `<rect x="${x(i) - w / 2}" y="${T}" width="${w}" height="${H - T - B}" class="hit"><title>${esc(day(p.at))}: ${p.critical} to fix now, ${p.warn} to improve</title></rect>`).join('')}
  </svg>`;
  };
  const svg = render(1000, 200, 'wide') + render(358, 170, 'narrow');
  return h`<figure class="chart">
    <figcaption><span class="legend"><i style="background:var(--s-crit)"></i>Fix now</span><span class="legend"><i style="background:var(--s-warn)"></i>Improve</span></figcaption>
    ${raw(svg)}
    <details class="small"><summary>Show as table</summary><table><thead><tr><th>Check</th><th>Fix now</th><th>Improve</th></tr></thead><tbody>
      ${points.map((p) => h`<tr><td>${day(p.at)}</td><td class="num">${p.critical}</td><td class="num">${p.warn}</td></tr>`)}
    </tbody></table></details>
  </figure>`;
}

export function layout(title: string, body: Html, opts: { refresh?: number } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · SEO Watchdog</title>${opts.refresh ? `<meta http-equiv="refresh" content="${opts.refresh}">` : ''}
<style>${CSS}</style></head><body>
<header class="top"><a href="/" class="brand"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="m13.5 13.5 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>SEO Watchdog</a></header>
<main>${body.__html}</main></body></html>`;
}

const CSS = `
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;--muted:#6f6d68;--line:#e1e0d9;--line-2:#c3c2b7;
--critical:#d03b3b;--critical-wash:#fbeaea;--warning:#fab219;--warning-ink:#b07400;--warning-wash:#fdf4e1;--good:#0ca30c;--good-ink:#006300;--good-wash:#e7f5e7;
--accent:#2a78d6;--ring:rgba(11,11,11,.10);--r:10px;--s-crit:#d03b3b;--s-warn:#eda100}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink-2:#c3c2b7;--muted:#9b9991;--line:#2c2c2a;--line-2:#383835;
--critical:#e66767;--critical-wash:#3a1d1d;--warning-ink:#fab219;--warning-wash:#3a2e14;--good:#0ca30c;--good-ink:#0ca30c;--good-wash:#14301a;--accent:#3987e5;--ring:rgba(255,255,255,.10);--s-crit:#d03b3b;--s-warn:#c98500}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--page);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
a:focus-visible,button:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.top{border-bottom:1px solid var(--line);background:var(--surface)}
.brand{display:flex;align-items:center;gap:8px;max-width:1080px;margin:0 auto;padding:14px 16px;font-weight:650;color:var(--ink)}
.brand svg{width:20px;height:20px}
main{max-width:1080px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:26px;line-height:1.25;margin:0 0 4px;letter-spacing:-.01em}h2{font-size:17px;margin:32px 0 12px}h3{font-size:15px;margin:0}
p{margin:0 0 8px}.muted{color:var(--muted)}.small{font-size:13px}.num{font-variant-numeric:tabular-nums;text-align:right}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:16px}
.grid-sites{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
.site-card{display:flex;flex-direction:column;gap:10px;color:inherit}.site-card:hover{border-color:var(--line-2);text-decoration:none}
.site-card .host{font-weight:650;font-size:16px;overflow-wrap:anywhere}
.verdict{font-size:15px;color:var(--ink)}
.chip{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;padding:2px 8px 2px 6px;border-radius:999px;white-space:nowrap}
.chip svg{width:14px;height:14px}
.chip.critical{color:var(--critical);background:var(--critical-wash)}.chip.warn{color:var(--warning-ink);background:var(--warning-wash)}
.chip.good{color:var(--good-ink);background:var(--good-wash)}.chip.info{color:var(--ink-2);background:transparent;box-shadow:inset 0 0 0 1px var(--line)}
.counts{display:flex;flex-wrap:wrap;gap:6px}
.hero{display:flex;flex-direction:column;gap:6px;margin-bottom:8px}
.headline{font-size:20px;line-height:1.35;font-weight:600;margin:12px 0 4px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.stat .v{font-size:24px;font-weight:650;line-height:1.2}.stat .k{color:var(--muted);font-size:13px}
.issue{padding:0;overflow:hidden}.issue+.issue{margin-top:10px}
.issue summary{list-style:none;cursor:pointer;padding:14px 16px;display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:start}
.issue summary::-webkit-details-marker{display:none}
.issue .count{font-variant-numeric:tabular-nums;color:var(--ink-2);font-size:13px;white-space:nowrap;padding-top:2px}
.issue .why{color:var(--ink-2);font-size:14px;margin-top:2px}
.issue .body{border-top:1px solid var(--line);padding:12px 16px 14px}
.fix{background:var(--page);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:14px}.fix b{font-weight:650}
ul.urls{list-style:none;padding:0;margin:0;font-size:13.5px}ul.urls li{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-top:1px solid var(--line)}
ul.urls li:first-child{border-top:0}ul.urls .u{overflow-wrap:anywhere}ul.urls .m{color:var(--muted)}
.area{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.check{display:flex;gap:10px;align-items:flex-start}.check .t{font-weight:600;font-size:14px}.check .d{font-size:13px;color:var(--ink-2)}
.changes{list-style:none;padding:0;margin:0}.changes li{display:grid;grid-template-columns:18px 1fr;gap:10px;padding:10px 0;border-top:1px solid var(--line)}
.changes li:first-child{border-top:0}.changes .dot{width:10px;height:10px;border-radius:50%;margin-top:6px}
.dot.good{background:var(--good)}.dot.bad{background:var(--critical)}.dot.neutral{background:var(--line-2)}
.ba{font-size:13px;color:var(--ink-2);overflow-wrap:anywhere;margin-top:2px}.ba del{color:var(--muted)}.ba ins{text-decoration:none;color:var(--ink)}
.banner{border-radius:var(--r);padding:12px 16px;margin:12px 0;font-size:14px}.banner.warn{background:var(--warning-wash)}.banner.info{background:var(--page);border:1px solid var(--line)}
.btn{font:inherit;font-size:14px;font-weight:600;border-radius:8px;padding:8px 14px;border:1px solid var(--line-2);background:var(--surface);color:var(--ink);cursor:pointer}
.btn.primary{background:var(--ink);color:var(--surface);border-color:var(--ink)}.btn.link{border:0;background:none;padding:0;color:var(--accent);font-weight:500;font-size:13px}
.btn:disabled{opacity:.55;cursor:default}
.row{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
form.add{display:grid;grid-template-columns:2fr 1fr auto;gap:8px;align-items:end}
form.add label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--ink-2)}
input,select{font:inherit;font-size:14px;padding:8px 10px;border:1px solid var(--line-2);border-radius:8px;background:var(--surface);color:var(--ink);min-width:0}
@media (max-width:700px){form.add{grid-template-columns:1fr}.issue summary{grid-template-columns:auto 1fr}.issue .count{grid-column:2}}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin:24px 0 16px;overflow-x:auto}
.tabs a{padding:8px 12px;color:var(--ink-2);border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.tabs a.on{color:var(--ink);border-color:var(--ink);font-weight:600}.tabs a:hover{text-decoration:none;color:var(--ink)}
.chart{margin:0}.chart figcaption{display:flex;gap:16px;font-size:13px;color:var(--ink-2);margin-bottom:4px}
.legend{display:inline-flex;align-items:center;gap:6px}.legend i{width:12px;height:3px;border-radius:2px;display:inline-block}
svg.trend{width:100%;height:auto;display:block;overflow:visible;max-width:1000px}svg.trend.narrow{display:none}@media (max-width:700px){svg.trend.wide{display:none}svg.trend.narrow{display:block}}
svg.trend .grid{stroke:var(--line);stroke-width:1}svg.trend .axis{stroke:var(--line-2);stroke-width:1}
svg.trend .tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
svg.trend .dlabel{fill:var(--ink-2);font-size:12px;font-weight:600}
svg.trend .hit{fill:transparent}svg.trend .hit:hover{fill:var(--ring)}
table{border-collapse:collapse;width:100%;font-size:13px;margin-top:8px}th,td{text-align:left;padding:6px 8px;border-top:1px solid var(--line)}th{color:var(--muted);font-weight:500}
details>summary{cursor:pointer}
.empty{padding:32px 16px;text-align:center;color:var(--ink-2)}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:14px}.kv dt{color:var(--muted)}.kv dd{margin:0;overflow-wrap:anywhere}
`;
