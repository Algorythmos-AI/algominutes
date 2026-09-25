import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { publicSiteUrl, DEFAULT_PUBLIC_SITE_URL } = require('@algominutes/ai/site-url.cjs');

describe('publicSiteUrl', () => {
  it('reads PUBLIC_SITE_URL, without a trailing slash', () => {
    expect(publicSiteUrl({ PUBLIC_SITE_URL: 'https://site.test' })).toBe('https://site.test');
    expect(publicSiteUrl({ PUBLIC_SITE_URL: ' https://site.test// ' })).toBe('https://site.test');
  });

  it('falls back to the public site when unset or blank', () => {
    expect(DEFAULT_PUBLIC_SITE_URL).toBe('https://algominutes.algorythmos.com');
    expect(publicSiteUrl({})).toBe(DEFAULT_PUBLIC_SITE_URL);
    expect(publicSiteUrl({ PUBLIC_SITE_URL: '  ' })).toBe(DEFAULT_PUBLIC_SITE_URL);
  });

  it('is what share links and the billing return pages are built on', async () => {
    const fs = await import('node:fs');
    const shares = fs.readFileSync('services/api/src/routes/shares.js', 'utf8');
    expect(shares).toMatch(/`\$\{publicSiteUrl\(\)\}\/s\/\$\{raw\}`/);
    for (const f of ['checkout', 'portal']) {
      const src = fs.readFileSync(`services/billing/src/routes/${f}.js`, 'utf8');
      expect(src).toMatch(/publicSiteUrl\(\)\}\/billing/);
      // A substring check: the old, unregistered domain is gone from the source.
      expect(src.includes('algominutes.com')).toBe(false);
    }
  });
});
