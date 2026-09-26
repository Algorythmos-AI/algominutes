// RFC 9116. Expires must be under a year away, so it's set from the build date:
// any deploy in the next 180 days renews it (the uptime check alerts if it lapses).
import type { APIRoute } from 'astro';
import processing from '../../data/processing.json';

export function securityTxt(site: URL, now = new Date()): string {
  const expires = new Date(now.getTime() + 180 * 24 * 3600 * 1000);
  expires.setUTCHours(0, 0, 0, 0);
  return [
    `Contact: mailto:${processing.operator.privacy}`,
    `Expires: ${expires.toISOString()}`,
    'Preferred-Languages: en',
    `Canonical: ${new URL('/.well-known/security.txt', site).href}`,
    `Policy: ${new URL('/privacy#security', site).href}`,
    '',
  ].join('\n');
}

export const GET: APIRoute = ({ site }) =>
  new Response(securityTxt(site!), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
