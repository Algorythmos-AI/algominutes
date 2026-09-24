import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The contract is authored once (packages/contracts) and generated into three
// clients, so the api's real routes and the OpenAPI document must agree.
// This test is a RATCHET: it pins the remaining drift exactly,
// so any NEW drift fails CI, and each reconciliation must shrink these lists
// (the test fails until the list is updated to match, keeping it honest).
// Reconciling to zero is scheduled before the iOS /v1 client work (plan PR-17).
const root = resolve(__dirname, '..');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function routerRoutes(): Set<string> {
  const src = readFileSync(resolve(root, 'services/api/src/routes/index.js'), 'utf8');
  return new Set(
    [...src.matchAll(/router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g)].map(
      (m) => `${m[1]!.toUpperCase()} /v1${m[2]!.replace(/:([A-Za-z]+)/g, '{$1}')}`,
    ),
  );
}

function specRoutes(): Set<string> {
  const spec = JSON.parse(readFileSync(resolve(root, 'packages/contracts/openapi/openapi.v1.json'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  return new Set(
    Object.entries(spec.paths).flatMap(([p, ops]) =>
      Object.keys(ops)
        .filter((k) => METHODS.includes(k))
        .map((k) => `${k.toUpperCase()} ${p}`),
    ),
  );
}

// In the spec under a name the router does not serve. Zero since the renames were
// reconciled; keep it that way.
const KNOWN_SPEC_ONLY: string[] = [];

// Served by the router but missing from the spec.
const KNOWN_ROUTER_ONLY: string[] = []; // zero: every served route is documented

describe('api routes vs OpenAPI contract (ratchet)', () => {
  const router = routerRoutes();
  const spec = specRoutes();

  it('parses a plausible route table', () => {
    expect(router.size).toBeGreaterThan(10);
    expect(router.has('GET /v1/health')).toBe(true);
  });

  it('spec-only drift matches the known list exactly (no new drift)', () => {
    expect([...spec].filter((r) => !router.has(r)).sort()).toEqual(KNOWN_SPEC_ONLY);
  });

  it('router-only drift matches the known list exactly (no new drift)', () => {
    expect([...router].filter((r) => !spec.has(r)).sort()).toEqual(KNOWN_ROUTER_ONLY);
  });
});
