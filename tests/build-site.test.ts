import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error: a plain .mjs script, no types
import { appEnabled, checkAppEnv, compose } from '../scripts/build-site.mjs';

// scripts/build-site.mjs decides whether the public build carries the web app.
// Getting it wrong either leaks the unfinished app to the public or serves two
// pages at /app.
describe('APP_ENABLED', () => {
  it('only the exact string "true" turns the app on', () => {
    expect(appEnabled({ APP_ENABLED: 'true' })).toBe(true);
    expect(appEnabled({ APP_ENABLED: ' true ' })).toBe(true);
    for (const v of [undefined, '', 'false', '1', 'TRUE', 'yes']) expect(appEnabled({ APP_ENABLED: v }), String(v)).toBe(false);
  });
});

describe('compose', () => {
  let tmp: string;
  let site: string;
  let web: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-'));
    site = path.join(tmp, 'site');
    web = path.join(tmp, 'web');
    fs.mkdirSync(site);
    fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(site, 'app.html'), 'placeholder');
    fs.writeFileSync(path.join(site, 'index.html'), 'home');
    fs.writeFileSync(path.join(web, 'index.html'), 'spa');
    fs.writeFileSync(path.join(web, 'assets/app.js'), 'js');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('puts the web build at app/ and removes the placeholder, leaving the site alone', () => {
    compose(site, web);
    expect(fs.existsSync(path.join(site, 'app.html'))).toBe(false);
    expect(fs.readFileSync(path.join(site, 'app/index.html'), 'utf8')).toBe('spa');
    expect(fs.readFileSync(path.join(site, 'app/assets/app.js'), 'utf8')).toBe('js');
    expect(fs.readFileSync(path.join(site, 'index.html'), 'utf8')).toBe('home');
  });

  it('refuses a failed web build, and a site that already has app/', () => {
    fs.rmSync(path.join(web, 'index.html'));
    expect(() => compose(site, web)).toThrow(/index\.html is missing/);
    fs.writeFileSync(path.join(web, 'index.html'), 'spa');
    fs.mkdirSync(path.join(site, 'app'));
    expect(() => compose(site, web)).toThrow(/already exists/);
    expect(fs.existsSync(path.join(site, 'app.html'))).toBe(true);
  });
});

describe('the web build\'s backends', () => {
  const STAGING = {
    VITE_API_ORIGIN: 'https://api-627101926311.australia-southeast1.run.app',
    VITE_BILLING_ORIGIN: 'https://billing-627101926311.australia-southeast1.run.app',
  };

  it('staging\'s api and billing are both allowed by the app\'s CSP', () => {
    expect(checkAppEnv(STAGING)).toEqual([]);
  });

  it('refuses a build whose origins are missing, or that the CSP would block', () => {
    expect(checkAppEnv({})).toEqual(['VITE_API_ORIGIN is not set', 'VITE_BILLING_ORIGIN is not set']);
    expect(checkAppEnv({ ...STAGING, VITE_API_ORIGIN: 'https://api.elsewhere.test' })).toEqual([
      "VITE_API_ORIGIN (https://api.elsewhere.test) is not in /app's connect-src in apps/site/vercel.json",
    ]);
  });
});
