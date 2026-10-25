import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Plan rev 12, Stage 2 (O5): production keeps one instance of the api and billing warm, so a user's first
// request (a sign-in, a kickoff, a purchase) doesn't wait on a cold start. Workers stay at zero: they are behind
// queues. Staging stays at zero everywhere.
const cloudRun = readFileSync('infra/terraform/modules/environment/cloud-run.tf', 'utf8');
const variables = readFileSync('infra/terraform/modules/environment/variables.tf', 'utf8');
const prod = readFileSync('infra/terraform/envs/prod/main.tf', 'utf8');
const staging = readFileSync('infra/terraform/envs/staging/main.tf', 'utf8');

describe('warm instances', () => {
  it('each service takes its minimum from min_instances, zero when unnamed', () => {
    expect(cloudRun).toMatch(/min_instance_count\s*=\s*lookup\(var\.min_instances,\s*each\.key,\s*0\)/);
    expect(variables).toMatch(/variable "min_instances"[^]*?default\s*=\s*\{\}/);
  });

  it('production keeps one api and one billing instance warm, and nothing else', () => {
    const m = /min_instances\s*=\s*\{([^}]*)\}/.exec(prod);
    expect(m).not.toBeNull();
    const entries = Object.fromEntries([...m![1].matchAll(/(\w+)\s*=\s*(\d+)/g)].map((e) => [e[1], Number(e[2])]));
    expect(entries).toEqual({ api: 1, billing: 1 });
  });

  it('staging keeps none warm', () => {
    expect(staging).not.toMatch(/min_instances\s*=/);
  });
});
