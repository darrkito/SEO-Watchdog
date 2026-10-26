// Google Search Console via a service-account key (input: path to the key JSON). Read-only scope.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url');

async function token(keyFile: string): Promise<string> {
  const key = JSON.parse(readFileSync(keyFile, 'utf8'));
  if (!key.client_email || !key.private_key) throw new Error(`${keyFile} is not a service-account key`);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))}`;
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url')}`;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`Google auth failed: ${j.error_description ?? j.error ?? r.status}`);
  return j.access_token;
}

/** The Search Console property this key can read for `siteUrl`: URL-prefix match first, then sc-domain. */
export async function findProperty(keyFile: string, siteUrl: string): Promise<string> {
  const t = await token(keyFile);
  const r = await fetch('https://www.googleapis.com/webmasters/v3/sites', { headers: { authorization: `Bearer ${t}` } });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`Search Console: ${j.error?.message ?? r.status}`);
  const host = new URL(siteUrl).hostname.replace(/^www\./, '');
  const props: string[] = (j.siteEntry ?? []).filter((s: any) => s.permissionLevel !== 'siteUnverifiedUser').map((s: any) => s.siteUrl);
  const match = props.find((p) => /^https?:/.test(p) && new URL(p).hostname.replace(/^www\./, '') === host)
    ?? props.find((p) => p === `sc-domain:${host}` || (p.startsWith('sc-domain:') && host.endsWith('.' + p.slice(10))));
  if (!match) throw new Error(`This key has no access to ${host}. It can see: ${props.join(', ') || 'nothing'}`);
  return match;
}

/** A site added with a path (https://x.mx/us) only counts searches that landed on that section. */
export function pageFilter(siteUrl?: string) {
  const u = siteUrl ? new URL(siteUrl) : null;
  const p = u?.pathname.replace(/\/$/, '');
  if (!u || !p) return undefined;
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [{ filters: [{ dimension: 'page', operator: 'includingRegex', expression: `^https?://(www\\.)?${esc(u.hostname.replace(/^www\./, ''))}${esc(p)}([/?#]|$)` }] }];
}

/** Top queries by impressions over the last `days` (excluding the 3 most recent days, which GSC hasn't settled yet). */
export async function topQueries(keyFile: string, property: string, siteUrl?: string, days = 90, limit = 250): Promise<{ query: string; impressions: number; clicks: number; position: number }[]> {
  const t = await token(keyFile);
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
    method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
    body: JSON.stringify({ startDate: day(days + 3), endDate: day(3), dimensions: ['query'], rowLimit: limit, dimensionFilterGroups: pageFilter(siteUrl) }),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`Search Console: ${j.error?.message ?? r.status}`);
  return (j.rows ?? []).map((x: any) => ({ query: x.keys[0], impressions: x.impressions, clicks: x.clicks, position: x.position }))
    .sort((a: any, b: any) => b.impressions - a.impressions);
}

/** Daily rows per (date, query, page) from `from` to `to` (YYYY-MM-DD), paged. GSC lags ~2 days, so callers end at today-2. */
export async function dailyRows(keyFile: string, property: string, siteUrl: string, from: string, to: string):
  Promise<{ date: string; query: string; page: string; clicks: number; impressions: number; position: number }[]> {
  const t = await token(keyFile);
  const out: any[] = [];
  for (let startRow = 0; startRow < 100_000; startRow += 25_000) {
    const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
      method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ startDate: from, endDate: to, dimensions: ['date', 'query', 'page'], rowLimit: 25_000, startRow, dimensionFilterGroups: pageFilter(siteUrl) }),
    });
    const j: any = await r.json();
    if (!r.ok) throw new Error(`Search Console: ${j.error?.message ?? r.status}`);
    out.push(...(j.rows ?? []));
    if ((j.rows ?? []).length < 25_000) break;
  }
  return out.map((x) => ({ date: x.keys[0], query: x.keys[1], page: x.keys[2], clicks: x.clicks, impressions: x.impressions, position: x.position }));
}
