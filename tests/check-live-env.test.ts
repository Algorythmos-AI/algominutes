import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { liveEnv, liveEnvProblems } from '../scripts/check-live-env.mjs';

// The deploy preflight (RELEASE.md rev 11, H1b) reads `gcloud run services describe --format=json`, whose env
// is the Knative v1 shape: { name, value } or { name, valueFrom: { secretKeyRef } }.
const described = (env: Array<Record<string, unknown>>) => ({ spec: { template: { spec: { containers: [{ env }] } } } });
const script = resolve(__dirname, '../scripts/check-live-env.mjs');

describe('check-live-env', () => {
  it('reads plain values, and a Secret Manager reference as set', () => {
    expect(liveEnv(described([{ name: 'A', value: 'x' }, { name: 'P', valueFrom: { secretKeyRef: { name: 's', key: 'latest' } } }])))
      .toEqual({ A: 'x', P: '<secret>' });
  });

  it('a missing required variable stops the rollout; a missing soft one only warns', () => {
    const spec = { required: ['A'], soft: ['S'], exact: { W: 'true' } };
    expect(liveEnvProblems(spec, described([{ name: 'W', value: 'true' }]))).toEqual({
      hard: ['missing required env A'],
      soft: ['missing required env S'],
    });
    expect(liveEnvProblems(spec, described([{ name: 'A', value: 'x' }, { name: 'W', value: 'true' }, { name: 'S', value: 'y' }])))
      .toEqual({ hard: [], soft: [] });
  });

  // #281: billing's image required BILLING_URL, which the live service lacked until Apply B.
  it('as a command: exits 1 naming the variable, or warns and passes for a soft one', () => {
    const run = (svc: string, env: Array<Record<string, unknown>>) => {
      try {
        return { code: 0, out: execFileSync('node', [script, svc], { input: JSON.stringify(described(env)), encoding: 'utf8' }) };
      } catch (err) {
        const e = err as { status: number; stdout: string };
        return { code: e.status, out: e.stdout };
      }
    };
    const pg = [{ name: 'PGHOST', value: 'h' }, { name: 'PGDATABASE', value: 'd' }, { name: 'PGUSER', value: 'u' },
      { name: 'PGPASSWORD', valueFrom: { secretKeyRef: {} } }, { name: 'GOOGLE_CLOUD_PROJECT', value: 'p' }];
    const billing = run('billing', [...pg, { name: 'WRITE_POSTGRES', value: 'true' }, { name: 'JOBS_SA_EMAIL', value: 'j' }]);
    expect(billing.code).toBe(0);
    expect(billing.out).toMatch(/::warning::billing: missing required env BILLING_URL \(soft/);

    const broken = run('billing', pg);
    expect(broken.code).toBe(1);
    expect(broken.out).toMatch(/::error::billing: env WRITE_POSTGRES must be 'true'/);
  });
});
