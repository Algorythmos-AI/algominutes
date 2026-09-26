// algominutes.algorythmos.com: static HTML, no client JavaScript on the public
// pages. Hosting (headers, CSP, rewrites) is vercel.json; see docs/runbooks/site.md.
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://algominutes.algorythmos.com',
  output: 'static',
  // /privacy is served from privacy.html (vercel.json cleanUrls), so canonical
  // URLs never carry a trailing slash.
  trailingSlash: 'never',
  build: {
    format: 'file',
    // Every stylesheet is a file, so the CSP needs no 'unsafe-inline' for styles.
    inlineStylesheets: 'never',
  },
  // No dev toolbar, no telemetry-looking extras on the built pages.
  devToolbar: { enabled: false },
});
