import { describe, it, expect } from 'vitest';
// @ts-expect-error: a plain .mjs script, no types
import { decide, gather } from '../scripts/e2e-web-gate.mjs';

// scripts/e2e-web-gate.mjs: web-e2e runs once integration's head is deployed, site and backend, whichever
// finishes last; never against a PR preview or a half-deployed backend.

const HEAD = 'a'.repeat(40);
const ready = { event: 'workflow_run', eventSha: '', head: HEAD, site: 'success', deploying: false, backend: { status: 'completed', conclusion: 'success' }, hasBypass: true };

describe('the decision', () => {
  it('runs when the site and the backend are both integration head, whichever event arrives last', () => {
    expect(decide(ready)).toMatchObject({ run: true });
    expect(decide({ ...ready, event: 'deployment_status', eventSha: HEAD })).toMatchObject({ run: true });
    // A push that changed no backend path has no deploy-staging run: the site alone decides.
    expect(decide({ ...ready, event: 'deployment_status', eventSha: HEAD, backend: null })).toMatchObject({ run: true });
  });

  it("skips a Vercel deployment that isn't integration's head (a PR preview, or superseded)", () => {
    const d = decide({ ...ready, event: 'deployment_status', eventSha: 'b'.repeat(40) });
    expect(d).toMatchObject({ run: false, level: 'notice' });
    expect(d.why).toMatch(/bbbbbbb.*not integration's head \(aaaaaaa\)/);
  });

  it("waits for the site when the backend finishes first", () => {
    for (const site of ['none', 'pending', 'in_progress', 'failure']) {
      expect(decide({ ...ready, site }), site).toMatchObject({ run: false });
    }
    expect(decide({ ...ready, site: 'pending' }).why).toMatch(/its deployment will start the run/);
  });

  it('waits while any staging deploy is still running, since Vercel usually finishes first', () => {
    const d = decide({ ...ready, event: 'deployment_status', eventSha: HEAD, deploying: true, backend: { status: 'in_progress', conclusion: null } });
    expect(d).toMatchObject({ run: false, level: 'notice' });
    expect(d.why).toMatch(/its completion will start the run/);
  });

  it("warns, and doesn't run, when head's backend deploy failed", () => {
    const d = decide({ ...ready, event: 'deployment_status', eventSha: HEAD, backend: { status: 'completed', conclusion: 'failure' } });
    expect(d).toMatchObject({ run: false, level: 'warning' });
    expect(d.why).toMatch(/ended failure/);
  });

  it("with no backend deploy of head, trusts the backend only if integration's last deploy succeeded", () => {
    const webOnly = { ...ready, event: 'deployment_status', eventSha: HEAD, backend: null };
    expect(decide({ ...webOnly, lastBackend: { sha: 'c'.repeat(40), conclusion: 'success' } })).toMatchObject({ run: true });
    const d = decide({ ...webOnly, lastBackend: { sha: 'c'.repeat(40), conclusion: 'failure' } });
    expect(d).toMatchObject({ run: false, level: 'warning' });
    expect(d.why).toMatch(/ccccccc\) ended failure/);
  });

  it('runs nightly and on demand against staging as it is', () => {
    for (const event of ['schedule', 'workflow_dispatch']) {
      expect(decide({ event, hasBypass: true }), event).toMatchObject({ run: true });
    }
  });

  it("needs the bypass secret, whatever the event, and says so", () => {
    for (const event of ['schedule', 'workflow_run']) {
      const d = decide({ ...ready, event, hasBypass: false });
      expect(d, event).toMatchObject({ run: false, level: 'warning' });
      expect(d.why).toMatch(/VERCEL_AUTOMATION_BYPASS_SECRET/);
    }
  });
});

describe('what it asks GitHub', () => {
  const fakeGitHub = (routes: Record<string, unknown>) => {
    const calls: string[] = [];
    const doFetch = async (url: string, init: { headers: Record<string, string> }) => {
      const path = url.replace('https://api.github.com/repos/o/r/', '');
      calls.push(path);
      expect(init.headers.Authorization).toBe('Bearer t');
      return path in routes ? { ok: true, json: async () => routes[path] } : { ok: false, status: 404, json: async () => ({}) };
    };
    return { calls, doFetch };
  };
  const unfinished = (counts: Record<string, number>) => Object.fromEntries(['requested', 'queued', 'pending', 'waiting', 'in_progress'].map((s) => [`actions/workflows/deploy-staging.yml/runs?branch=integration&status=${s}&per_page=1`, { total_count: counts[s] ?? 0, workflow_runs: [] }]));

  it("reads head, Vercel's newest deployment of it, and deploy-staging's runs", async () => {
    const { calls, doFetch } = fakeGitHub({
      'commits/integration': { sha: HEAD },
      [`deployments?sha=${HEAD}&environment=Preview&per_page=20`]: [{ id: 7, creator: { login: 'someone' } }, { id: 9, creator: { login: 'vercel[bot]' } }],
      'deployments/9/statuses?per_page=1': [{ state: 'success' }],
      ...unfinished({ in_progress: 1 }),
      [`actions/workflows/deploy-staging.yml/runs?head_sha=${HEAD}&per_page=1`]: { workflow_runs: [{ status: 'in_progress', conclusion: null }] },
    });
    expect(await gather({ repo: 'o/r', token: 't', doFetch })).toEqual({ head: HEAD, site: 'success', deploying: true, backend: { status: 'in_progress', conclusion: null }, lastBackend: null });
    expect(calls).not.toContain('deployments/7/statuses?per_page=1');
  });

  it("knows when Vercel has no deployment of head yet, and head changed no backend path (then integration's last real deploy)", async () => {
    const { doFetch } = fakeGitHub({
      'commits/integration': { sha: HEAD },
      [`deployments?sha=${HEAD}&environment=Preview&per_page=20`]: [],
      ...unfinished({}),
      [`actions/workflows/deploy-staging.yml/runs?head_sha=${HEAD}&per_page=1`]: { workflow_runs: [] },
      'actions/workflows/deploy-staging.yml/runs?branch=integration&status=completed&per_page=10': { workflow_runs: [{ head_sha: 'd'.repeat(40), conclusion: 'cancelled' }, { head_sha: 'c'.repeat(40), conclusion: 'failure' }] },
    });
    expect(await gather({ repo: 'o/r', token: 't', doFetch })).toEqual({ head: HEAD, site: 'none', deploying: false, backend: null, lastBackend: { sha: 'c'.repeat(40), conclusion: 'failure' } });
  });

  it('counts a deploy waiting its turn (pending) as still deploying', async () => {
    const { doFetch } = fakeGitHub({
      'commits/integration': { sha: HEAD },
      [`deployments?sha=${HEAD}&environment=Preview&per_page=20`]: [],
      ...unfinished({ pending: 1 }),
      [`actions/workflows/deploy-staging.yml/runs?head_sha=${HEAD}&per_page=1`]: { workflow_runs: [{ status: 'pending', conclusion: null }] },
    });
    expect(await gather({ repo: 'o/r', token: 't', doFetch })).toMatchObject({ deploying: true });
  });

  it('fails loudly when GitHub refuses, rather than guessing', async () => {
    const { doFetch } = fakeGitHub({});
    await expect(gather({ repo: 'o/r', token: 't', doFetch })).rejects.toThrow(/commits\/integration: HTTP 404/);
  });
});
