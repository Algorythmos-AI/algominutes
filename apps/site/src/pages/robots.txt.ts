// Nothing is disallowed: the app, share links and billing pages carry noindex
// (meta and X-Robots-Tag), and a crawler kept out by robots.txt never sees it,
// so an externally linked share URL could still be listed as a bare URL.
import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) =>
  new Response(['User-agent: *', 'Allow: /', '', `Sitemap: ${new URL('/sitemap.xml', site).href}`, ''].join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
