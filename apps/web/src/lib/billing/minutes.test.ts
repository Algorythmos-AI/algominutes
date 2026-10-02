import { describe, expect, it } from 'vitest';
import { resetDate } from './minutes';

// RELEASE.md rev 11, H18: minutes renew on the first of the next month (UTC), from the entitlement's period.
describe('resetDate', () => {
  it('is the first of the next month', () => {
    expect(resetDate('2026-09')).toBe('1 October');
    expect(resetDate('2026-12')).toBe('1 January');
  });
  it('is nothing for a period it can’t read', () => {
    expect(resetDate('')).toBeNull();
    expect(resetDate('2026-9')).toBeNull();
  });
});
