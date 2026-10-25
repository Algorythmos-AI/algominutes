import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The free floor per environment (plan rev 12, Stage 3; owner decision 1): production gives every new account 120
// minutes, so a reviewer and every new user can record before buying. Staging's beta keeps none: an invite code is
// how a guest gets minutes, and the nightly's held-first case relies on it. Every service that resolves an
// entitlement (the api's kickoff, the transcoder's gate, billing's releases) reads the same number.
const cloudRun = readFileSync('infra/terraform/modules/environment/cloud-run.tf', 'utf8');
const scheduler = readFileSync('infra/terraform/modules/environment/scheduler.tf', 'utf8');
const variables = readFileSync('infra/terraform/modules/environment/variables.tf', 'utf8');
const prod = readFileSync('infra/terraform/envs/prod/main.tf', 'utf8');
const staging = readFileSync('infra/terraform/envs/staging/main.tf', 'utf8');

describe('the free floor, per environment', () => {
  it('reaches every service as FREE_FLOOR_MINUTES, only when the environment sets it', () => {
    expect(variables).toMatch(/variable "free_floor_minutes"[^]*?default\s*=\s*null/);
    expect(cloudRun).toMatch(/free_floor_env\s*=\s*var\.free_floor_minutes == null \? \{\} : \{ FREE_FLOOR_MINUTES = tostring\(var\.free_floor_minutes\) \}/);
    // Every service's env, the db-job's and the sweep's.
    expect(cloudRun).toMatch(/local\.common_env,\s*local\.free_floor_env,\s*local\.service_env\[each\.key\]/);
    expect(cloudRun).toMatch(/merge\(local\.common_env, local\.free_floor_env, local\.db_env, \{ PG_POOL_MAX/);
    expect(scheduler).toMatch(/merge\(local\.common_env, local\.free_floor_env, local\.db_env, \{/);
  });

  it('production gives every new account 120 minutes', () => {
    expect(prod).toMatch(/^\s*free_floor_minutes\s*=\s*120\b/m);
  });

  it('staging gives none', () => {
    expect(staging).not.toMatch(/free_floor_minutes\s*=/);
  });
});
