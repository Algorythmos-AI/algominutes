// The public site's origin: privacy, terms, support, share links, and the pages
// Stripe returns to. One value for the api and billing, from PUBLIC_SITE_URL
// (Terraform var.public_site_url), so no service hard-codes a domain.
const DEFAULT_PUBLIC_SITE_URL = 'https://algominutes.algorythmos.com';

/** The site's origin, without a trailing slash. */
function publicSiteUrl(env = process.env) {
  const configured = String(env.PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '');
  return configured || DEFAULT_PUBLIC_SITE_URL;
}

module.exports = { publicSiteUrl, DEFAULT_PUBLIC_SITE_URL };
