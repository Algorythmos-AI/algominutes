// The public site's origin: privacy, terms, support, share links, and the pages
// Stripe returns to. One value for the api and billing, from PUBLIC_SITE_URL
// (Terraform var.public_site_url), so no service hard-codes a domain.
const DEFAULT_PUBLIC_SITE_URL = 'https://algominutes.algorythmos.com';

/** The site's origin, without a trailing slash. */
function publicSiteUrl(env = process.env) {
  const configured = String(env.PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '');
  return configured || DEFAULT_PUBLIC_SITE_URL;
}

/**
 * Where a share link opens (RELEASE.md PR 29): the web app's viewer, /app/s/<token>, on SHARE_VIEWER_ORIGIN
 * (Terraform var.share_viewer_origin: the beta's host, where the web app is public), else the public site.
 * Only an https origin is used (http only on localhost); anything else falls back to the site.
 */
function shareViewerOrigin(env = process.env) {
  const raw = String(env.SHARE_VIEWER_ORIGIN || '').trim();
  if (raw) {
    try {
      const url = new URL(raw);
      const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      const https = url.protocol === 'https:' || (local && url.protocol === 'http:');
      if (https && url.pathname === '/' && !url.search && !url.hash && !url.username) return url.origin;
    } catch {
      // silent-catch-ok: not a URL, so not an origin: the public site is used
    }
  }
  return publicSiteUrl(env);
}

module.exports = { publicSiteUrl, shareViewerOrigin, DEFAULT_PUBLIC_SITE_URL };
