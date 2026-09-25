import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';

// Error Reporting groups errors from Cloud Run logs only when the entry carries
// a stack trace in a top-level field (stack_trace), not nested under err.
const require = createRequire(import.meta.url);
const { makeLogger } = require('@algominutes/ai/logger.cjs');

afterEach(() => vi.restoreAllMocks());
const capture = () => {
  const lines: any[] = [];
  const grab = (chunk: any) => { lines.push(JSON.parse(String(chunk))); return true; };
  vi.spyOn(process.stderr, 'write').mockImplementation(grab);
  vi.spyOn(process.stdout, 'write').mockImplementation(grab);
  return lines;
};

describe('logger and Error Reporting', () => {
  it('an error line with an Error carries its stack at the top level', () => {
    const lines = capture();
    const err = new Error('boom');
    makeLogger({ traceId: 't' }).error({ err, noteId: 'n' }, 'thing_failed');
    expect(lines[0]).toMatchObject({ severity: 'ERROR', msg: 'thing_failed', traceId: 't', noteId: 'n' });
    expect(lines[0].stack_trace).toBe(err.stack);
    expect(lines[0].err.stack).toBe(err.stack);
  });

  it('warnings, and errors without an Error, stay as they were', () => {
    const lines = capture();
    makeLogger().warn({ err: new Error('meh') }, 'soft');
    makeLogger().error({ reason: 'x' }, 'no_err');
    makeLogger().error({ err: 'a string' }, 'string_err');
    makeLogger().error({ err: { message: 'plain' } }, 'object_err');
    expect(lines.map((l) => l.stack_trace)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('fatal lines carry it too, and a stack_trace the caller set is kept', () => {
    const lines = capture();
    const err = new Error('down');
    makeLogger().fatal({ err }, 'crash');
    makeLogger().error({ err, stack_trace: 'forwarded stack' }, 'wrapped');
    makeLogger({ stack_trace: 'bound' }).error({ err }, 'child_bound');
    expect(lines.map((l) => [l.severity, l.stack_trace])).toEqual([
      ['CRITICAL', err.stack], ['ERROR', 'forwarded stack'], ['ERROR', 'bound'],
    ]);
  });
});
