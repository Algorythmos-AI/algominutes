import { describe, expect, it } from 'vitest';
import { reportablePath } from './crashReport';

describe('a crash report', () => {
  it("never carries a share link's token", () => {
    expect(reportablePath('/app/s/Zm9vYmFyLXNlY3JldA')).toBe('/app/s/:token');
    expect(reportablePath('/s/abc123')).toBe('/s/:token');
    expect(reportablePath('/app/s/abc/extra')).toBe('/app/s/:token/extra');
  });

  it('keeps every other path as it is', () => {
    for (const p of ['/app', '/app/notes/n1', '/app/search', '/app/settings', '/app/sign-in', '/app/notes/s']) expect(reportablePath(p)).toBe(p);
  });
});
