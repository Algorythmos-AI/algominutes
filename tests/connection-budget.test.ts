import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { srcFiles } from './helpers/terraform';

// The Postgres connection budget (infra/terraform/envs/<env>/connection-budget.json,
// docs/DECISIONS.md). Terraform also enforces the sum with a precondition on the
// Cloud SQL instance; this catches it before a plan, and checks the budget
// against what the code actually opens.
const require = createRequire(import.meta.url);
const { buildPgConfig } = require('@algominutes/ai/pg-config.cjs');

type Budget = {
  tier: string; max_connections: number; reserved: number; operator_headroom: number;
  services: Record<string, { max_instances: number; pools: number; pool_max: number }>;
  jobs: Record<string, { connections: number; pool_max: number }>;
};
const ENVS = ['staging', 'prod'];
const budget = (env: string): Budget =>
  JSON.parse(fs.readFileSync(`infra/terraform/envs/${env}/connection-budget.json`, 'utf8'));

/** The pools a service's code opens: the repo pool, its own pg.Pool, the api's read pool. */
function poolsInCode(service: string): number {
  const src = srcFiles(`services/${service}/src`).join('\n');
  return Number(src.includes('@algominutes/db')) + Number(/new Pool\(/.test(src)) + Number(src.includes('pg-query'));
}

describe.each(ENVS)('%s connection budget', (env) => {
  const b = budget(env);

  it("fits the tier's usable connections in the worst case", () => {
    const worst = Object.values(b.services).reduce((n, s) => n + s.max_instances * s.pools * s.pool_max, 0)
      + Object.values(b.jobs).reduce((n, j) => n + j.connections, 0);
    expect(worst).toBeLessThanOrEqual(b.max_connections - b.reserved - b.operator_headroom);
  });

  it('matches the tier in main.tf', () => {
    const main = fs.readFileSync(`infra/terraform/envs/${env}/main.tf`, 'utf8');
    expect(main).toMatch(new RegExp(`db_tier\\s*=\\s*"${b.tier}"`));
  });

  it('covers every Cloud Run service, with the pool count its code opens', () => {
    const cloudRun = fs.readFileSync('infra/terraform/modules/environment/cloud-run.tf', 'utf8');
    const block = cloudRun.slice(cloudRun.indexOf('service_config = {'), cloudRun.indexOf('}\n\n', cloudRun.indexOf('service_config = {')));
    const services = [...block.matchAll(/^\s{4}(\w+)\s+=\s+\{/gm)].map((m) => m[1]);
    expect(services.sort()).toEqual(Object.keys(b.services).sort());
    for (const s of services) {
      expect({ s, pools: b.services[s].pools }).toEqual({ s, pools: poolsInCode(s) });
      if (b.services[s].pools > 0) expect(b.services[s].pool_max).toBeGreaterThanOrEqual(1);
    }
  });

  it('gives the sweep its lock connection plus a pool connection', () => {
    expect(b.jobs['db-sweep'].connections).toBeGreaterThanOrEqual(2);
  });
});

describe('PG_POOL_MAX', () => {
  it('caps a pool but never raises it', () => {
    expect(buildPgConfig({ max: 8 }, { PG_POOL_MAX: '2', PGHOST: 'h' }).max).toBe(2);
    expect(buildPgConfig({ max: 1 }, { PG_POOL_MAX: '5', PGHOST: 'h' }).max).toBe(1);
    expect(buildPgConfig({ max: 8 }, { PGHOST: 'h' }).max).toBe(8);
    expect(buildPgConfig({ max: 8 }, { PG_POOL_MAX: 'nope', PGHOST: 'h' }).max).toBe(8);
  });
});
