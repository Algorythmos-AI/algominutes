import { describe, it, expect } from 'vitest';
// @ts-expect-error: plain .mjs script, no type declarations
import { findSilentCatches } from '../scripts/check-no-silent-catch.mjs';

const hits = (src: string, file = 'x.js') => (findSilentCatches(file, src) as unknown[]).length;

describe('silent-catch gate (syntax-aware)', () => {
  it.each([
    ["resp.text().catch(() => '')", 'returning a value (hid the Vertex error-body loss)'],
    ['p.catch(() => {})', 'empty arrow'],
    ['p.catch(function () { return null; })', 'function expression returning null'],
    ["try { a(); } catch { return ''; }", 'catch returning a value (hid the STT decode loss)'],
    ['try { a(); } catch (err) {}', 'unused binding, empty body'],
    ['try {\n  a();\n} catch (e) {\n  // nothing to do\n  x = 1;\n}', 'multi-line, binding unused'],
  ])('flags %s (%s)', (src) => {
    expect(hits(src)).toBe(1);
  });

  it.each([
    ["p.catch((err) => log.error({ err }, 'x'))", 'logs'],
    ["p.catch((err) => (opts.log ?? log).error({ err }, 'x'))", 'logs via an expression'],
    ["try { a(); } catch (err) { reqLog.warn({ err }, 'x'); return null; }", 'any logger name'],
    ['try { a(); } catch (err) { throw new Error(`wrapped: ${err.message}`); }', 'rethrows'],
    ['try { a(); } catch (err) { lastErr = err; }', 'keeps the error'],
    ['p.catch((err) => reject(err))', 'passes it on'],
    ["try { a(); } catch (err) { return res.status(400).json({ error: err.message }); }", 'answers with it'],
    ["// silent-catch-ok: existence probe\ntry { a(); } catch { return false; }", 'marker on the line before'],
    ["try { a(); } catch { /* silent-catch-ok: the original error is rethrown below */ }", 'marker inside'],
  ])('allows %s (%s)', (src) => {
    expect(hits(src)).toBe(0);
  });

  // Every path out of the catch has to throw, log, or let the error escape. Reading the
  // error only to decide which way to go handles nothing on the way that doesn't throw.
  it.each([
    ['try { a(); } catch (err) { if (err?.code !== X) throw err; return fallback; }', 'rethrow guard, silent fallback'],
    ['try { a(); } catch (err) { if (!(err instanceof NotFound)) throw err; return null; }', 'instanceof guard'],
    ["try { a(); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }", 'early silent return'],
    ['try { a(); } catch (err) { if (isGone(err)) return null; throw err; }', 'predicate call in the condition'],
    ['try { a(); } catch (err) { switch (err.code) { case 1: return null; default: throw err; } }', 'switch on the error'],
    ['try { a(); } catch (err) { if (err.retryable) log.warn({ err }, "x"); return null; }', 'logs on one branch only'],
    ['try { a(); } catch (err) { const code = err?.code; if (code !== X) throw err; return fallback; }', 'guard through a local'],
    ['for (const x of xs) { try { a(); } catch (err) { if (err.fatal) throw err; continue; } }', 'continue out of the catch'],
    ['p.catch((err) => (err.code === X ? fallback : Promise.reject(err)))', 'conditional arrow, silent branch'],
    ["p.catch((err) => { if (err.name === 'AbortError') return; throw err; })", 'block arrow, silent early return'],
    ["try { a(); } catch (err) { if (log && err.retryable) log.warn({ err }, 'x'); return null; }", 'a logger guard that also tests the error'],
    ['try { a(); } catch (err) { const code = codeOf(err); if (CANCELLED.has(code)) return false; throw err; }', "guard through a helper's result"],
  ])('flags %s (%s)', (src) => {
    expect(hits(src)).toBe(1);
  });

  it.each([
    ["try { a(); } catch (err) { if (err?.code !== X) throw err; log.warn({ err }, 'x'); return fallback; }", 'rethrow guard, logged fallback'],
    ["try { a(); } catch (err) { if (err?.code !== X) throw err; req.log.warn({ err }, 'x'); return fallback; }", 'req.log'],
    ["try { a(); } catch (err) { if (err.code === 'ENOENT') { logger.info({ err }, 'x'); return null; } throw err; }", 'logged early return'],
    ['try { a(); } catch (err) { if (err instanceof HttpError) return res.status(err.status).json({ error: err.message }); throw err; }', 'answers on the non-throwing branch'],
    ['p.catch((err) => (err.code === X ? fallback(err) : Promise.reject(err)))', 'conditional arrow, both branches use it'],
    ['try { a(); } catch (err) { const msg = err instanceof Error ? err.message : String(err); return { ok: false, msg }; }', 'returned through a local'],
    ['try { a(); } catch (err) { if (err.fatal) throw err; errors.push(err); }', 'kept on the non-throwing path'],
    ["// silent-catch-ok: a missing file is the empty state\ntry { a(); } catch (err) { if (err?.code !== 'ENOENT') throw err; return null; }", 'guard with a marker'],
    ["try { a(); } catch (err) { if (err.fatal) throw err; void reportCrash('x', err); return null; }", 'reported on the non-throwing path'],
    ['p.catch((err) => { setError(describe(err)); })', "a call made with a helper's result"],
    ["try { a(); } catch (err) { if (log) log.warn({ err }, 'x'); return null; }", 'an optional logger'],
    ["try { a(); } catch (err) { if (req.log && typeof req.log.warn === 'function') { req.log.warn({ err }, 'x'); } return null; }", 'a checked logger method'],
  ])('allows %s (%s)', (src) => {
    expect(hits(src)).toBe(0);
  });

  it('a marker without a reason does not count', () => {
    expect(hits('// silent-catch-ok:\ntry { a(); } catch { return false; }')).toBe(1);
  });

  it('parses TypeScript too', () => {
    expect(hits("async function f(): Promise<string> { try { return await g(); } catch { return ''; } }", 'x.ts')).toBe(1);
  });
});
