/** The indexable pages: the sitemap lists them, and robots.txt keeps the rest out. */
export const PUBLIC_PAGES = ['/', '/privacy', '/terms', '/support', '/delete-account'] as const;
/** Kept out of search engines: the app, share links and the billing returns. */
export const DISALLOWED = ['/app', '/s/', '/billing'] as const;
