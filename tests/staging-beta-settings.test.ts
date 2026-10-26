import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Staging carries the external beta's real notes (docs/plans/RELEASE.md, PR 6).
// Its data is kept like prod's, and its beta switches are set, so a later edit
// can't quietly make it disposable again. (The values themselves are in the
// reviewed plan the owner applies; this pins what's committed.)
const root = readFileSync('infra/terraform/envs/staging/main.tf', 'utf8');
const cloudRun = readFileSync('infra/terraform/modules/environment/cloud-run.tf', 'utf8');
const setting = (name: string) => {
  const m = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*(#.*)?$`, 'm').exec(root);
  return m ? m[1] : undefined;
};

describe('staging holds the beta’s data', () => {
  it('keeps it like prod: PITR, deletion protection, no lifecycle delete, nothing destroyed with the stack', () => {
    expect(setting('db_point_in_time_recovery')).toBe('true');
    expect(setting('deletion_protection')).toBe('true');
    expect(setting('recordings_lifecycle_days')).toBe('0');
    expect(setting('bucket_force_destroy')).toBe('false');
    expect(setting('firestore_deletion_policy')).toBe('"ABANDON"');
  });

  it('runs the beta: the trial off, an explicit spend cap, and the beta web origin allowed', () => {
    expect(setting('trial_on_first_use')).toBe('"off"');
    expect(Number(setting('daily_spend_cap_aud'))).toBeGreaterThan(0);
    expect(setting('allowed_origins')).toContain('https://beta.algominutes.algorythmos.com');
  });

  it('wires the switches to the services that read them', () => {
    expect(cloudRun).toMatch(/TRIAL_ON_FIRST_USE\s*=\s*var\.trial_on_first_use/);
    // The cap is checked in the api (kickoff) and the transcoder (paid work).
    expect(cloudRun).toMatch(/api\s*=\s*merge\([^)]*local\.spend_env/);
    expect(cloudRun).toMatch(/transcoder\s*=\s*merge\([^)]*local\.spend_env/);
  });
});
