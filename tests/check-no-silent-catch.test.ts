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

  it('a marker without a reason does not count', () => {
    expect(hits('// silent-catch-ok:\ntry { a(); } catch { return false; }')).toBe(1);
  });

  it('parses TypeScript too', () => {
    expect(hits("async function f(): Promise<string> { try { return await g(); } catch { return ''; } }", 'x.ts')).toBe(1);
  });
});
