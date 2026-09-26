// The public site the app lives inside (apps/site). The app is served at
// <site>/app, so the site is this page's own origin; SSR-free, so window exists.
export const SITE_URL = typeof window === 'undefined' ? 'https://algominutes.algorythmos.com' : window.location.origin;
