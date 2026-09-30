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

// 2026-10-01: a 400 INVALID_ARGUMENT came and went on one fast-path call, with nothing to say why.
describe("a refused call's details", () => {
  const detailed = (details: unknown[]) => JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: "quoting 'the transcript'", details } });

  it('keeps the refused fields and machine reasons, on err.detail, never a description', () => {
    const err = vertexRefusal('Vertex Gemini', 400, detailed([
      { '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'contents[0].parts[0].inline_data', description: "the transcript says 'Priya 4111'" }] },
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'INVALID_AUDIO', domain: 'aiplatform.googleapis.com' },
    ]));
    expect(err.message).toBe('Vertex Gemini 400 INVALID_ARGUMENT');
    expect(err.detail).toEqual({ fields: ['contents[0].parts[0].inline_data'], reasons: ['INVALID_AUDIO'] });
    expect(JSON.stringify(err.detail)).not.toMatch(/Priya|transcript/);
  });

  it("drops anything that isn't shaped like a path or an enum, and keeps at most 3 of each", () => {
    const err = vertexRefusal('x', 400, detailed([
      { fieldViolations: [{ field: "it said 'hello'" }, { field: 'a' }, { field: 'b' }, { field: 'c' }, { field: 'd' }] },
      { reason: 'lower case words' },
    ]));
    expect(err.detail).toEqual({ fields: ['a', 'b', 'c'], reasons: [] });
  });

  it('has none for a body without details, or not JSON', () => {
    expect(vertexRefusal('x', 400, body('INVALID_ARGUMENT')).detail).toBeUndefined();
    expect(vertexRefusal('x', 502, '<html>').detail).toBeUndefined();
  });

  it("a reason naming a transient enum doesn't make a 400 retryable", () => {
    const err = vertexRefusal('Vertex Gemini', 400, detailed([{ reason: 'INTERNAL' }]));
    expect(isTransientError(err)).toBe(false);
  });

  it('the logger keeps err.detail', () => {
    const { logger } = require('../packages/ai/src/logger.cjs');
    const lines: string[] = [];
    const write = process.stdout.write;
    const writeErr = process.stderr.write;
    (process.stdout as any).write = (s: string) => { lines.push(String(s)); return true; };
    (process.stderr as any).write = (s: string) => { lines.push(String(s)); return true; };
    try {
      logger.error({ err: vertexRefusal('Vertex Gemini', 400, detailed([{ reason: 'INVALID_AUDIO' }])) }, 'gemini_non_retryable');
    } finally {
      (process.stdout as any).write = write;
      (process.stderr as any).write = writeErr;
    }
    expect(lines.join('')).toContain('"detail":{"fields":[],"reasons":["INVALID_AUDIO"]}');
  });
});
