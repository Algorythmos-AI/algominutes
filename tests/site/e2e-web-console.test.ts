import { describe, it, expect } from 'vitest';
// @ts-expect-error: a plain .mjs script, no types
import { consoleProblem } from '../../scripts/e2e-web.mjs';

// The web journey's console check (scripts/e2e-web.mjs). Chrome's "Failed to load resource" names no URL: the
// 10-16 journey's two 401s after the deletion said only "status of 401", so nothing said which request sent the
// deleted account's token.
const msg = (text: string, url?: string) => ({ text: () => text, location: () => ({ url: url ?? '', lineNumber: 0, columnNumber: 0 }) });

describe('a console error as the journey reports it', () => {
  it('names the resource that failed to load, by origin and path only', () => {
    expect(consoleProblem(msg('Failed to load resource: the server responded with a status of 401 ()', 'https://api-1.a.run.app/v1/entitlement?key=AIzaSecret')))
      .toBe('Failed to load resource: the server responded with a status of 401 () [https://api-1.a.run.app/v1/entitlement]');
  });

  it('keeps any other error as Chrome wrote it, cut at 200 characters', () => {
    expect(consoleProblem(msg('Refused to connect: CSP', 'https://x.example/a'))).toBe('Refused to connect: CSP');
    expect(consoleProblem(msg('e'.repeat(300)))).toHaveLength(200);
  });

  it('a resource error with no usable location is still reported', () => {
    expect(consoleProblem(msg('Failed to load resource: net::ERR_FAILED'))).toBe('Failed to load resource: net::ERR_FAILED');
    expect(consoleProblem({ text: () => 'Failed to load resource: x' })).toBe('Failed to load resource: x');
  });
});
