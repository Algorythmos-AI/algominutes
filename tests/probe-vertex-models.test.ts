import { describe, it, expect } from 'vitest';
// @ts-expect-error: a plain .mjs script, no types
import { parseArgs, probe } from '../scripts/probe-vertex-models.mjs';

// scripts/probe-vertex-models.mjs: the read-only check that a model is served
// in our region before it can enter the ladder (models.cjs).
describe('probe-vertex-models', () => {
  it('probes the registry\'s generative models by default, and takes a project and account', () => {
    const a = parseArgs([]);
    expect(a.candidates.length).toBeGreaterThan(0);
    expect(parseArgs(['--project', 'p', '--account', 'x@y', 'm1', 'm2'])).toMatchObject({ project: 'p', account: 'x@y', candidates: ['m1', 'm2'] });
  });

  it('asks the regional countTokens endpoint, and reads 200 as served and anything else as not', async () => {
    const calls: string[] = [];
    const doFetch = async (url: string, init: { method: string; headers: Record<string, string> }) => {
      calls.push(url);
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer t');
      return { status: url.includes('/models/good:') ? 200 : 404 };
    };
    const r = await probe({ project: 'p', region: 'australia-southeast1', token: 't', candidates: ['good', 'bad'], doFetch });
    expect(r).toEqual([{ model: 'good', served: true, status: 200 }, { model: 'bad', served: false, status: 404 }]);
    expect(calls[0]).toBe('https://australia-southeast1-aiplatform.googleapis.com/v1/projects/p/locations/australia-southeast1/publishers/google/models/good:countTokens');
  });
});
