import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// deploy-production.yml is deploy-staging.yml's pipeline for `main` (RELEASE.md PR 39). Two copies of a
// pipeline drift apart; this keeps them one. The jobs must be the same, text for text, but for exactly the
// substitutions below, so a change to one (a wave, a smoke, a guard) fails here until it's made to both.
const staging = fs.readFileSync('.github/workflows/deploy-staging.yml', 'utf8');
const production = fs.readFileSync('.github/workflows/deploy-production.yml', 'utf8');
const jobs = (s: string) => s.slice(s.indexOf('\njobs:\n'));

const SUBSTITUTIONS: Array<[string, string]> = [
  ["vars.DEPLOY_STAGING == 'true'", "vars.DEPLOY_PRODUCTION == 'true'"],
  ['environment: staging', 'environment: production'],
  ['secrets.STAGING_FIREBASE_API_KEY', 'secrets.PROD_FIREBASE_API_KEY'],
];

describe('the production deploy', () => {
  it('runs exactly the staging pipeline, but for prod', () => {
    let expected = jobs(staging);
    for (const [from, to] of SUBSTITUTIONS) {
      expect(expected).toContain(from);
      expected = expected.split(from).join(to);
    }
    expect(jobs(production)).toBe(expected);
  });

  it('deploys nothing to prod from staging\'s side, and nothing to staging from prod\'s', () => {
    expect(jobs(production)).not.toMatch(/environment: staging|DEPLOY_STAGING|STAGING_FIREBASE_API_KEY/);
    expect(jobs(staging)).not.toMatch(/environment: production|DEPLOY_PRODUCTION|PROD_FIREBASE_API_KEY/);
    // Every job that authenticates to GCP runs in the production Environment, whose WIF provider trusts only main.
    const envs = [...jobs(production).matchAll(/environment: (\S+)/g)].map((m) => m[1]);
    expect(envs.length).toBeGreaterThanOrEqual(6);
    expect(new Set(envs)).toEqual(new Set(['production']));
  });

  it('runs on main only, gated, in its own lane', () => {
    expect(production).toMatch(/^name: deploy-production$/m);
    expect(production).toMatch(/\non:\n  push:\n    branches: \[main\]\n/);
    expect(production).toMatch(/concurrency:\n  group: deploy-production\n  cancel-in-progress: false/);
    expect(production).toContain("- '.github/workflows/deploy-production.yml'");
    expect(production).not.toContain("- '.github/workflows/deploy-staging.yml'");
    // CI runs on pushes to main too, so the gate that waits for it has something to wait for.
    expect(fs.readFileSync('.github/workflows/ci.yml', 'utf8')).toMatch(/push:\n    branches: \[integration, main\]/);
    expect(fs.readFileSync('.github/workflows/invariants.yml', 'utf8')).toMatch(/push:\n    branches: \[integration, main\]/);
  });

  it('prod\'s keyless deploys trust main, in the production Environment', () => {
    const prod = fs.readFileSync('infra/terraform/envs/prod/main.tf', 'utf8');
    expect(prod).toMatch(/wif_allowed_refs\s*=\s*\["refs\/heads\/main"\]/);
    expect(prod).toMatch(/wif_github_environment\s*=\s*"production"/);
  });
});
