import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// RELEASE.md PR 26c (audit Q25): a service goes live only after every service it hands work to, so a task in
// a new shape is never sent to an old worker. Wave 1 the workers, wave 2 meetings (it queues the
// transcoder's runs), wave 3 the api (it queues everyone's); a failed wave stops the ones after it.
// Read as text, like the other workflow tests: each job is its block under `jobs:`.
const text = fs.readFileSync('.github/workflows/deploy-staging.yml', 'utf8');
const body = text.slice(text.indexOf('\njobs:\n'));
const jobs: Record<string, string> = {};
for (const m of body.matchAll(/\n  ([a-z-]+):\n([\s\S]*?)(?=\n  [a-z-]+:\n|$)/g)) jobs[m[1]] = m[2];
const needs = (job: string) => /\n    needs: \[([^\]]*)\]/.exec(`\n${jobs[job]}`)![1].split(',').map((n) => n.trim());
/** A job's `if:`, joined onto one line (the waves' conditions are folded, `>-`). */
const cond = (job: string) => (/\n    if: (?:>-\n)?([\s\S]*?)\n    runs-on:/.exec(`\n${jobs[job]}`)![1]).replace(/\s+/g, ' ').trim();
const pick = jobs.changes;

/** The waves the pick step writes for `services`, by running its own jq filters. */
function waves(services: string[]) {
  const out: Record<string, string[]> = {};
  for (const n of [1, 2, 3]) {
    const filter = new RegExp(`wave${n}=\\$\\(printf '%s' "\\$out" \\| jq -c '([^']+)'\\)`).exec(pick)![1];
    out[`wave${n}`] = JSON.parse(execFileSync('jq', ['-c', filter], { input: JSON.stringify(services) }).toString());
  }
  return out;
}

describe('the staging rollout', () => {
  it('puts the api last, meetings before it, and every other service first, each exactly once', () => {
    const all = JSON.parse(/all='(\[[^']*\])'/.exec(pick)![1]) as string[];
    const w = waves(all);
    expect(w.wave3).toEqual(['api']);
    expect(w.wave2).toEqual(['meetings']);
    expect([...w.wave1, ...w.wave2, ...w.wave3].sort()).toEqual([...all].sort());
    expect(waves(['api', 'db-job'])).toEqual({ wave1: ['db-job'], wave2: [], wave3: ['api'] });
    expect(waves(['transcoder', 'db-job'])).toEqual({ wave1: ['transcoder', 'db-job'], wave2: [], wave3: [] });
  });

  it('deploys each wave from its own list, and each after the one before', () => {
    // Every image is built first, whichever wave it rolls out in; each wave deploys only its own services.
    expect(jobs.build).toContain('service: ${{ fromJSON(needs.changes.outputs.services) }}');
    expect(jobs.rollout).toContain('service: ${{ fromJSON(needs.changes.outputs.wave1) }}');
    expect(cond('rollout')).toBe("needs.changes.outputs.wave1 != '[]'");
    expect(needs('rollout-meetings')).toEqual(expect.arrayContaining(['migrate', 'rollout']));
    expect(needs('rollout-api')).toEqual(expect.arrayContaining(['migrate', 'rollout', 'rollout-meetings']));
    expect(jobs['rollout-meetings']).toMatch(/run: gcloud run services update meetings /);
    expect(jobs['rollout-api']).toMatch(/run: gcloud run services update api /);
    expect(jobs['rollout-meetings']).toContain('/algominutes/meetings:${{ github.sha }}');
    expect(jobs['rollout-api']).toContain('/algominutes/api:${{ github.sha }}');
    expect(cond('rollout-meetings')).toContain("needs.changes.outputs.wave2 != '[]'");
    expect(cond('rollout-api')).toContain("needs.changes.outputs.wave3 != '[]'");
  });

  it('never runs a later wave, or the smoke, after a failure: only after success or nothing to deploy', () => {
    for (const [job, earlier] of [['rollout-meetings', ['rollout']], ['rollout-api', ['rollout', 'rollout-meetings']]] as const) {
      const c = cond(job);
      expect(c).toContain('!cancelled()');
      expect(c).toContain("needs.migrate.result == 'success'");
      for (const e of earlier) expect(c, `${job} after ${e}`).toContain(`(needs.${e}.result == 'success' || needs.${e}.result == 'skipped')`);
    }
    expect(needs('smoke')).toEqual(expect.arrayContaining(['migrate', 'rollout', 'rollout-meetings', 'rollout-api']));
    expect(cond('smoke')).toContain("!contains(needs.*.result, 'failure')");
    expect(cond('smoke')).toContain("needs.migrate.result == 'success'");
  });
});
