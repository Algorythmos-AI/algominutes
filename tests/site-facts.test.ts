import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { MODULE, read, stripComments } from './helpers/terraform';
import { PRIVACY_VERSION, RETENTION_OPTIONS_DAYS, TERMS_VERSION } from '@algominutes/contracts';
import processing from '../apps/site/src/data/processing.json';
import { brandCss } from '../apps/site/src/pages/brand.css.ts';

// The Privacy Policy (apps/site/src/pages/privacy.astro) renders who processes
// data and where from processing.json. These tests hold that file to the code
// and Terraform, so a change that makes the published policy untrue fails CI.
// The policy once said Gemini ran in the US and named a speech provider we no
// longer use (L21); nothing checked it.
const cloudRun = stripComments(read(`${MODULE}/cloud-run.tf`));
const main = stripComments(read(`${MODULE}/main.tf`));
const variables = stripComments(read(`${MODULE}/variables.tf`));
const byId = Object.fromEntries(processing.processors.map((p) => [p.id, p]));

const regionDefault = /variable "region"\s*\{[^}]*default\s*=\s*"([\w-]+)"/.exec(variables)![1];
const envRegions = ['staging', 'prod'].map((env) => /^region\s*=\s*"([\w-]+)"/m.exec(read(`infra/terraform/envs/${env}/terraform.tfvars`))![1]);

describe('where data is processed', () => {
  it('every environment runs in the one region the policy names', () => {
    expect(envRegions).toEqual([regionDefault, regionDefault]);
    expect(processing.primaryRegion).toBe(regionDefault);
    expect(processing.primaryRegion).toBe('australia-southeast1');
    expect(processing.primaryRegionLabel).toBe('Sydney, Australia');
  });

  it('Cloud SQL, Storage and Firestore are in that region', () => {
    expect(main).toMatch(/resource "google_sql_database_instance"[\s\S]*?region\s*=\s*var\.region/);
    expect(main).toMatch(/resource "google_firestore_database"[\s\S]*?location_id\s*=\s*var\.region/);
    for (const id of ['cloud-sql', 'cloud-storage', 'firestore']) expect(byId[id].region, id).toBe(regionDefault);
  });

  it('Vertex AI (Gemini, embeddings) is called in that region', () => {
    expect(cloudRun).toMatch(/AIPLATFORM_LOCATION\s*=\s*var\.region/);
    expect(byId['vertex-ai'].region).toBe(regionDefault);
  });

  it('speech-to-text is Google, on its global endpoint, and disclosed as possibly outside Australia', () => {
    // A different provider (or a regional endpoint) is a policy change: update processing.json with it.
    expect(/transcoder\s*=\s*merge\([^\n]*STT_PROVIDER\s*=\s*"(\w+)"/.exec(cloudRun)?.[1]).toBe('google');
    expect(read('services/transcoder/src/stt.js')).toMatch(/\/locations\/global\/recognizers\/_/);
    expect(byId['speech-to-text'].region).toBe('global');
    expect(byId['speech-to-text'].where).toMatch(/outside Australia/);
  });

  it('names no provider the code no longer uses', () => {
    const site = [JSON.stringify(processing), ...fs.readdirSync('apps/site/src/pages', { recursive: true })
      .filter((f) => String(f).endsWith('.astro'))
      .map((f) => read(`apps/site/src/pages/${f}`))].join('\n');
    expect(site).not.toMatch(/AssemblyAI|Deepgram|OpenAI|us-central1|United States only/i);
  });

  it('server logs: the region and retention the policy states', () => {
    const bucket = /resource "google_logging_project_bucket_config" "default"\s*\{([^}]*)\}/.exec(main)![1];
    expect(/location\s*=\s*"(\w+)"/.exec(bucket)![1]).toBe(byId['cloud-logging'].region);
    expect(Number(/retention_days\s*=\s*(\d+)/.exec(bucket)![1])).toBe(processing.logRetentionDays);
  });

  it('backups expire inside the stated deletion window', () => {
    expect(processing.backupWindowDays).toBe(30);
    expect(Number(/retained_backups\s*=\s*(\d+)/.exec(main)![1])).toBeLessThanOrEqual(processing.backupWindowDays);
    expect(variables).toMatch(/noncurrent_version_retention_days <= 30/);
    expect(read('docs/DATA-RETENTION.md')).toMatch(/within 30 days of deletion/);
  });

  it('Crashlytics is disclosed exactly when the app links it', () => {
    const linked = /product:\s*FirebaseCrashlytics/.test(read('apps/ios/project.yml'));
    expect('crashlytics' in byId).toBe(linked);
  });
});

describe('the operator', () => {
  it('publishes a valid ABN (ATO checksum)', () => {
    const digits = processing.operator.abn.replace(/\s/g, '').split('').map(Number);
    expect(digits).toHaveLength(11);
    digits[0] -= 1;
    const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
    expect(digits.reduce((s, d, i) => s + d * weights[i], 0) % 89).toBe(0);
  });

  it('uses the company mailboxes, never a personal address', () => {
    expect(processing.operator.support).toBe('support@algorythmos.com');
    expect(processing.operator.privacy).toBe('privacy@algorythmos.com');
    const pages = fs.readdirSync('apps/site/src', { recursive: true }).filter((f) => /\.(astro|ts|json)$/.test(String(f)));
    for (const f of pages) expect(read(`apps/site/src/${f}`), String(f)).not.toMatch(/@gmail\.com|@outlook\.com|@icloud\.com/);
  });
});

describe('document versions and retention: the three clients agree', () => {
  const swift = read('apps/ios/AlgoMinutes/Services/ComplianceContract.swift');
  it('iOS ComplianceContract mirrors @algominutes/contracts', () => {
    expect(/termsVersion = "([\d-]+)"/.exec(swift)![1]).toBe(TERMS_VERSION);
    expect(/privacyVersion = "([\d-]+)"/.exec(swift)![1]).toBe(PRIVACY_VERSION);
    expect(JSON.parse(/retentionOptionsDays: \[Int\] = (\[[\d, ]+\])/.exec(swift)![1])).toEqual([...RETENTION_OPTIONS_DAYS]);
  });

  it('the versions are real dates', () => {
    for (const v of [TERMS_VERSION, PRIVACY_VERSION]) {
      expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10)).toBe(v);
    }
  });

  it('the site renders the versions and retention options from the contracts, not copies', () => {
    const site = read('apps/site/src/lib/site.ts');
    expect(site).toMatch(/from '@algominutes\/contracts'/);
    for (const page of ['privacy', 'terms']) expect(read(`apps/site/src/pages/${page}.astro`)).toMatch(/_VERSION\}/);
    expect(read('apps/site/src/pages/privacy.astro')).toMatch(/retentionChoices\(\)/);
  });
});

describe('every link the apps and server build has a page', () => {
  const pages = 'apps/site/src/pages';
  const has = (route: string) =>
    fs.existsSync(`${pages}${route}.astro`) || fs.existsSync(`${pages}${route}/index.astro`);

  it('the iOS app\'s LegalLinks', () => {
    const login = read('apps/ios/AlgoMinutes/Features/Auth/LoginView.swift');
    expect(/static let site = URL\(string: "([^"]+)"\)/.exec(login)![1]).toBe('https://algominutes.algorythmos.com');
    const paths = [...login.matchAll(/site\.appendingPathComponent\("([\w-]+)"\)/g)].map((m) => `/${m[1]}`);
    expect(paths.sort()).toEqual(['/privacy', '/support', '/terms']);
    for (const p of paths) expect(has(p), p).toBe(true);
  });

  it('the api and billing (PUBLIC_SITE_URL)', () => {
    const shares = read('services/api/src/routes/shares.js');
    expect(shares).toMatch(/\$\{publicSiteUrl\(\)\}\/s\/\$\{raw\}/);
    expect(has('/s')).toBe(true); // vercel.json rewrites /s/<token> to it
    const billing = read('services/billing/src/routes/checkout.js') + read('services/billing/src/routes/portal.js');
    const paths = [...billing.matchAll(/\$\{publicSiteUrl\(\)\}(\/[\w/-]+)/g)].map((m) => m[1]);
    expect(paths.sort()).toEqual(['/billing', '/billing/cancel', '/billing/success']);
    for (const p of paths) expect(has(p), p).toBe(true);
  });

  it('the store listings (Play\'s account-deletion URL)', () => {
    expect(read('docs/STORE-COMPLIANCE.md')).toContain('`https://algominutes.algorythmos.com/delete-account`');
    expect(has('/delete-account')).toBe(true);
  });
});

// WCAG AA (4.5:1) for the text colours on the backgrounds they're used on, in
// both schemes, read from the stylesheet the site actually serves (/brand.css).
describe('colour contrast', () => {
  const css = brandCss();
  const scheme = (block: string) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)].map((m) => [m[1], m[2]]));
  const [darkBlock, lightBlock] = css.split('@media (prefers-color-scheme: light)');
  const dark = scheme(darkBlock);
  const light = { ...dark, ...scheme(lightBlock) };
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  it.each([['dark', dark], ['light', light]] as const)('%s scheme text is ≥ 4.5:1', (_, s) => {
    for (const bg of ['bg', 'card']) {
      for (const fg of ['heading', 'body', 'muted', 'link']) {
        expect(ratio(s[fg], s[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('white on the mark gradient (buttons, step numbers) is ≥ 4.5:1 at both ends', () => {
    for (const end of ['mark-start', 'mark-end']) expect(ratio(dark['on-mark'], dark[end]), end).toBeGreaterThanOrEqual(4.5);
  });
});
