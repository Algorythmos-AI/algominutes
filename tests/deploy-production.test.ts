import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// deploy-production.yml is deploy-staging.yml's pipeline for `main` (RELEASE.md PR 39). Two copies of a
// pipeline drift apart; this keeps them one. The jobs must be the same, text for text, but for exactly the
// substitutions below, so a change to one (a wave, a smoke, a guard) fails here until it's made to both.
const staging = fs.readFileSync('.github/workflows/deploy-staging.yml', 'utf8');
const production = fs.readFileSync('.github/workflows/deploy-production.yml', 'utf8');
const jobs = (s: string) => s.slice(s.indexOf('\njobs:\n'));
const blocks = (s: string) => jobs(s).split(/\n  (?=[a-z-]+:\n)/).slice(1);
const block = (s: string, name: string) => blocks(s).find((b) => b.startsWith(`${name}:\n`)) ?? '';
// A job's direct `needs`, one name or a list.
const needsOf = (b: string) => {
  const m = b.match(/\n    needs: (?:\[([^\]]*)\]|(\S+))\n/);
  return m ? (m[1] ?? m[2]).split(',').map((n) => n.trim()) : [];
};

// Production's one addition: the job that waits for the single approval, and `build` waiting on it. Everything
// else is staging's pipeline.
const GATE_COMMENT = '\n  # The one person in a production deploy.';
const withoutGate = (s: string) => {
  const from = s.indexOf(GATE_COMMENT);
  const to = s.indexOf('\n  # Nothing deploys a commit whose CI');
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  expect(s.split('needs: [changes, ci-gate, approve]')).toHaveLength(2);
  return (s.slice(0, from) + s.slice(to)).replace('needs: [changes, ci-gate, approve]', 'needs: [changes, ci-gate]');
};

const SUBSTITUTIONS: Array<[string, string]> = [
  ["vars.DEPLOY_STAGING == 'true'", "vars.DEPLOY_PRODUCTION == 'true'"],
  ['environment: staging', 'environment: production'],
  // The first job's target check reads this Environment's variables against this target's tfvars.
  ['TARGET: staging', 'TARGET: production'],
  ['secrets.STAGING_FIREBASE_API_KEY', 'secrets.PROD_FIREBASE_API_KEY'],
  // A failed prod deploy opens its own issue, under its own label, never a comment on staging's.
  ['stuck staging is seen', 'stuck production deploy is seen'],
  ['deploy-staging failed on', 'deploy-production failed on'],
  ['A staging deploy failed', 'A production deploy failed'],
  ['Staging deploy failed on', 'Production deploy failed on'],
  ['deploy-failed', 'prod-deploy-failed'],
];

describe('the production deploy', () => {
  it('runs exactly the staging pipeline, but for prod', () => {
    let expected = jobs(staging);
    for (const [from, to] of SUBSTITUTIONS) {
      expect(expected).toContain(from);
      expected = expected.split(from).join(to);
    }
    expect(withoutGate(jobs(production))).toBe(expected);
  });

  it('deploys nothing to prod from staging\'s side, and nothing to staging from prod\'s', () => {
    expect(jobs(production)).not.toMatch(/environment: staging|DEPLOY_STAGING|STAGING_FIREBASE_API_KEY/);
    expect(jobs(staging)).not.toMatch(/environment: production|DEPLOY_PRODUCTION|PROD_FIREBASE_API_KEY/);
    // Every job that authenticates to GCP runs in the production Environment, whose WIF provider trusts only main
    // (and only this workflow file); the approval job alone names production-approval.
    const envs = [...jobs(production).matchAll(/environment: (\S+)/g)].map((m) => m[1]);
    expect(envs.filter((e) => e === 'production').length).toBeGreaterThanOrEqual(6);
    expect(envs.filter((e) => e === 'production-approval')).toHaveLength(1);
    expect(new Set(envs)).toEqual(new Set(['production', 'production-approval']));
    for (const b of blocks(production)) {
      if (b.includes('./.github/actions/gcp-auth')) expect(b, b.split('\n')[0]).toContain('\n    environment: production\n');
    }
  });

  // GitHub asks a reviewer once per job that names an Environment with required reviewers (the first prod deploy,
  // run 40299616305, holds 10 approval records), and a job's approval doesn't carry to the next. So the reviewer
  // sits on an Environment only one job names, and everything that reaches GCP waits for that job.
  it('one approval per deploy: a single job waits for the reviewer, and every GCP job waits for it', () => {
    const approve = block(production, 'approve');
    expect(approve).toContain('\n    environment: production-approval\n');
    expect(needsOf(approve)).toEqual(['changes']);
    // The approval is read back from this run: a missing or reviewer-less Environment (GitHub creates a missing
    // one, unprotected, when a job names it) fails here instead of deploying unasked.
    expect(approve).toContain('GATE: production-approval\n');
    expect(approve).toContain('repos/$REPO/actions/runs/$RUN_ID/approvals');
    expect(approve).toContain('select(.state == "approved" and any(.environments[]; .name == env.GATE))');
    expect(approve).toMatch(/if \[ -z "\$by" \]; then\n[^\n]*\n\s+exit 1\n/);
    expect(approve).toMatch(/\n      actions: read\n/);
    expect(approve).not.toContain('id-token: write');

    const needs = new Map(blocks(production).map((b) => [b.split(':')[0], needsOf(b)]));
    const waitsFor = (job: string, target: string): boolean =>
      (needs.get(job) ?? []).some((n) => n === target || waitsFor(n, target));
    const gcpJobs = blocks(production).filter((b) => b.includes('id-token: write')).map((b) => b.split(':')[0]);
    expect(gcpJobs).toEqual(['build', 'migrate', 'rollout', 'rollout-solo', 'rollout-meetings', 'rollout-api', 'smoke']);
    for (const job of gcpJobs) expect(waitsFor(job, 'approve'), job).toBe(true);
    // A rejected deploy is a decision, not an outage: it opens no prod-deploy-failed issue.
    expect(needsOf(block(production, 'report-failure'))).not.toContain('approve');
  });

  it('a failed prod deploy reports under its own label, and every job has a ceiling', () => {
    expect(jobs(production)).toContain('gh issue list --label prod-deploy-failed');
    expect(jobs(production)).not.toMatch(/--label deploy-failed\b/);
    // Each job carries a timeout-minutes, so a hung job fails naming itself (both files: the jobs are one),
    // and each says what was measured, so the next person can re-size it from the same evidence.
    for (const file of [staging, production]) {
      const blocks = jobs(file).split(/\n  (?=[a-z-]+:\n)/).slice(1);
      expect(blocks.length).toBeGreaterThanOrEqual(10);
      for (const b of blocks) expect(b, b.split('\n')[0]).toMatch(/\n    timeout-minutes: \d+ # \S.*\n/);
    }
  });

  it('authenticates through the local action, which asks WIF a second time, after a checkout', () => {
    const action = fs.readFileSync('.github/actions/gcp-auth/action.yml', 'utf8');
    // The pinned auth action appears twice in the composite (the attempt and the retry), and nowhere else:
    // every job authenticates through the composite, so a retry change is made once.
    const pinned = /google-github-actions\/auth@[0-9a-f]{40} # v\d+\.\d+\.\d+/g;
    expect(action.match(pinned)).toHaveLength(2);
    expect(new Set(action.match(pinned)).size).toBe(1);
    expect(action).toMatch(/- id: first\n\s+uses: google-github-actions\/auth@[0-9a-f]{40}[^\n]*\n(?:\s+#[^\n]*\n)*\s+continue-on-error: true\n/);
    expect(action.match(/if: steps\.first\.outcome == 'failure'/g)).toHaveLength(2);
    expect(action).toMatch(/\n\s+sleep \d+\n/);
    for (const file of [staging, production]) {
      expect(file).not.toContain('google-github-actions/auth@');
      const uses = file.match(/- uses: \.\/\.github\/actions\/gcp-auth\b/g) ?? [];
      expect(uses).toHaveLength(7);
      // A local action needs the repository on disk: the checkout comes first in each of those jobs.
      for (const b of jobs(file).split(/\n  (?=[a-z-]+:\n)/).slice(1)) {
        if (!b.includes('./.github/actions/gcp-auth')) continue;
        expect(b.indexOf('uses: actions/checkout@'), b.split('\n')[0]).toBeGreaterThan(-1);
        expect(b.indexOf('uses: actions/checkout@')).toBeLessThan(b.indexOf('./.github/actions/gcp-auth'));
      }
    }
  });

  it('the first job runs in the Environment and refuses the wrong project before anything else runs', () => {
    const tfvarsProject = (env: string) =>
      fs.readFileSync(`infra/terraform/envs/${env}/terraform.tfvars`, 'utf8').match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
    expect(tfvarsProject('staging')).toBe('algominutes-staging');
    expect(tfvarsProject('prod')).toBe('algominutes-production');
    for (const [file, env, target] of [[staging, 'staging', 'staging'], [production, 'production', 'production']] as const) {
      const changes = jobs(file).split(/\n  (?=[a-z-]+:\n)/)[1];
      expect(changes.startsWith('changes:\n')).toBe(true);
      expect(changes).toContain(`\n    environment: ${env}\n`);
      expect(changes).toContain(`TARGET: ${target}\n`);
      // The check's job comes before the paths filter (so it fails before CI is waited on), reads the three
      // variables, and maps each target to its tfvars.
      expect(changes.indexOf('Deploy target')).toBeLessThan(changes.indexOf('- id: filter'));
      for (const v of ['GCP_PROJECT_ID', 'GCP_WIF_PROVIDER', 'GCP_DEPLOYER_SA']) expect(changes).toContain(`vars.${v}`);
      expect(changes).toContain('staging)    tfvars=infra/terraform/envs/staging/terraform.tfvars');
      expect(changes).toContain('production) tfvars=infra/terraform/envs/prod/terraform.tfvars');
      expect(changes).toContain('if [ "$PROJECT" != "$want" ]; then');
    }
  });

  // A job that hits its timeout-minutes ends `cancelled`, not `failure` (the web journey killed at its limit on
  // 2026-10-23 concluded `cancelled`). With failure() alone, a hung deploy job would open no issue, and the
  // smoke would run after a rollout that never finished.
  it('a timed-out job counts as failed: the issue opens and the smoke stays out', () => {
    for (const file of [staging, production]) {
      const report = jobs(file).slice(jobs(file).indexOf('\n  report-failure:'));
      expect(report).toMatch(/if: >-\n\s+!cancelled\(\) && \(contains\(needs\.\*\.result, 'failure'\) \|\| contains\(needs\.\*\.result, 'cancelled'\)\)/);
      expect(report).not.toMatch(/\n    if: failure\(\)\n/);
      const smoke = jobs(file).slice(jobs(file).indexOf('\n  smoke:'), jobs(file).indexOf('\n  report-failure:'));
      for (const job of ['rollout', 'rollout-meetings', 'rollout-api']) {
        expect(smoke).toContain(`needs.${job}.result != 'cancelled'`);
      }
    }
    const web = fs.readFileSync('.github/workflows/web-e2e.yml', 'utf8');
    expect(web).toMatch(/!cancelled\(\) && github\.event_name == 'schedule'\n\s+&& \(needs\.gate\.result == 'failure' \|\| needs\.e2e\.result == 'failure' \|\| needs\.e2e\.result == 'cancelled'\)/);
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

  it('prod\'s keyless deploys trust main, in the production Environment, from this workflow only', () => {
    const prod = fs.readFileSync('infra/terraform/envs/prod/main.tf', 'utf8');
    expect(prod).toMatch(/wif_allowed_refs\s*=\s*\["refs\/heads\/main"\]/);
    expect(prod).toMatch(/wif_github_environment\s*=\s*"production"/);
    // `production` has no reviewer of its own, so no other workflow on main may mint a prod token.
    expect(prod).toMatch(/wif_allowed_workflows\s*=\s*\["\.github\/workflows\/deploy-production\.yml"\]/);
    expect(fs.readFileSync('infra/terraform/envs/staging/main.tf', 'utf8')).not.toContain('wif_allowed_workflows');
    const provider = fs.readFileSync('infra/terraform/modules/environment/cloud-run.tf', 'utf8');
    expect(provider).toContain('"assertion.job_workflow_ref == \\"${var.github_repo}/${w}@${r}\\""');
  });

  it('the repo settings put the reviewer on production-approval, and take it off production only once main is gated', () => {
    const settings = fs.readFileSync('scripts/github-settings.sh', 'utf8');
    expect(settings).toContain('environment production-approval main "$owner_id"');
    expect(settings).toMatch(
      /\nif main_has_gate; then\n  environment production main\nelse\n[^\n]*\n  environment production main "\$owner_id"\nfi\n/,
    );
    expect(settings).toContain("grep -q '^    environment: production-approval$'");
    // The line main_has_gate looks for is the approve job's.
    expect(production).toContain('\n    environment: production-approval\n');
  });
});
