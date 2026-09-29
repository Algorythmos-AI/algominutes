import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// A refused Vertex call, described by its status and enum only (RELEASE.md PR 15a; audit Q29).
const require = createRequire(import.meta.url);
const { vertexRefusal, refusalReason } = require('../packages/ai/src/vertex-refusal.cjs');
const { isTransientError } = require('../packages/ai/src/intelligence.cjs');

const body = (status: string, message = "quoting 'the transcript' back") => JSON.stringify({ error: { code: 0, status, message } });

describe('a refused Vertex call', () => {
  it("keeps Vertex's status enum, in an object or an array, and never its message", () => {
    expect(vertexRefusal('Vertex Gemini', 429, body('RESOURCE_EXHAUSTED')).message).toBe('Vertex Gemini 429 RESOURCE_EXHAUSTED');
    expect(refusalReason(500, JSON.stringify([JSON.parse(body('INTERNAL'))]))).toBe('INTERNAL');
    expect(vertexRefusal('x', 400, body('INVALID_ARGUMENT')).message).not.toMatch(/transcript/);
  });

  it('keeps only real google.rpc names from a body, else what the HTTP status means', () => {
    expect(refusalReason(400, body('PRIYA_4111'))).toBe('INVALID_ARGUMENT');
    expect(refusalReason(500, '<html>Internal Server Error</html>')).toBe('INTERNAL');
    expect(refusalReason(504, '')).toBe('DEADLINE_EXCEEDED');
    expect(vertexRefusal('Vertex Gemini', 502, '<html>Bad Gateway</html>').message).toBe('Vertex Gemini 502');
  });

  it('is retried exactly when Vertex says it is transient', () => {
    const transient = (s: number, b = '') => isTransientError(vertexRefusal('Vertex Gemini', s, b));
    expect([transient(429), transient(503), transient(500), transient(504)]).toEqual([true, true, true, true]);
    expect([transient(400), transient(403), transient(404)]).toEqual([false, false, false]);
    // What the body names wins over what the status would mean.
    expect(transient(400, body('UNAVAILABLE'))).toBe(true);
  });
});
