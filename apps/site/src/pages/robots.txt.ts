import type { APIRoute } from 'astro';
import { DISALLOWED } from '../lib/public-pages';

export const GET: APIRoute = ({ site }) =>
  new Response(
    ['User-agent: *', ...DISALLOWED.map((p) => `Disallow: ${p}`), '', `Sitemap: ${new URL('/sitemap.xml', site).href}`, ''].join('\n'),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
