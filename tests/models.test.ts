import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Model lifecycle tripwire (plan PR-10). Two retired models sat in the Gemini
// ladder unnoticed (1.5-flash since 2025-09-24, 2.0-flash since 2026-06-01) and
// the third retires 2026-10-20. This suite fails CI well before that can recur.
const require = createRequire(import.meta.url);
const models = require('../packages/ai/src/models.cjs');

const WARNING_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;
const daysUntil = (iso: string, now = new Date()) => (Date.parse(`${iso}T00:00:00Z`) - now.getTime()) / DAY_MS;

describe('model registry', () => {
  it('knows every model the code uses, and each is served in our region (data residency)', () => {
    for (const id of [...models.LADDER, models.CHAT_MODEL, models.EMBED_MODEL]) {
      expect(models.MODELS[id], id).toBeDefined();
      expect(models.MODELS[id].regions, id).toContain(models.REGION);
    }
    expect(models.REGION).toBe('australia-southeast1');
  });

  it('keeps the generative/embedding kinds straight', () => {
    for (const id of models.LADDER) expect(models.MODELS[id].kind).toBe('generative');
    expect(models.MODELS[models.CHAT_MODEL].kind).toBe('generative');
    expect(models.MODELS[models.EMBED_MODEL].kind).toBe('embedding');
  });

  it('drops a rung from the ladder on its retirement date, with no deploy', () => {
    expect(models.activeLadder(new Date('2026-10-19T23:00:00Z'))).toEqual(['gemini-3.5-flash', 'gemini-2.5-flash']);
    expect(models.activeLadder(new Date('2026-10-20T00:00:00Z'))).toEqual(['gemini-3.5-flash']);
  });

  it('refuses an unknown model id rather than guessing', () => {
    expect(() => models.isRetired('gemini-9-imaginary')).toThrow(/unknown model/);
  });
});

describe(`lifecycle tripwire (${WARNING_DAYS}-day warning)`, () => {
  // Fails CI when a model we DEPEND on is about to go. Re-check Google's tables
  // (links in models.cjs), pick a successor served in Sydney, update the registry.
  const critical = [models.LADDER[0], models.CHAT_MODEL, models.EMBED_MODEL];
  it.each(critical)('%s is not within %s days of an announced retirement', (id) => {
    const { retires } = models.MODELS[id];
    if (retires) expect(daysUntil(retires), `${id} retires ${retires}`).toBeGreaterThan(WARNING_DAYS);
  });
  it.each(critical)('%s is still inside its "supported until at least" window', (id) => {
    const { supportedUntilAtLeast } = models.MODELS[id];
    if (supportedUntilAtLeast) {
      expect(daysUntil(supportedUntilAtLeast), `${id}: re-check Google's lifecycle table`).toBeGreaterThan(WARNING_DAYS);
    }
  });
  it('the ladder always has a live model', () => {
    expect(models.activeLadder().length).toBeGreaterThan(0);
  });
});

describe('model ids live only in the registry', () => {
  const ROOTS = ['packages', 'services', 'functions', 'scripts'].map((d) => resolve(__dirname, '..', d));
  const SKIP = /node_modules|\/dist\/|\/generated\/|\/migrations\/|\.d\.ts$|models\.cjs$/;
  const ID = /['"`](gemini-\d[\w.-]*|text-embedding-\d+|gemini-embedding-[\w.-]+)['"`]/;
  function* files(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (SKIP.test(p)) continue;
      if (statSync(p).isDirectory()) yield* files(p);
      else if (/\.(c|m)?[jt]s$/.test(name)) yield p;
    }
  }
  it('no source file outside models.cjs hard-codes a model id', () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      try { statSync(root); } catch { continue; }
      for (const f of files(root)) {
        readFileSync(f, 'utf-8').split('\n').forEach((line, i) => {
          if (ID.test(line)) hits.push(`${f.replace(resolve(__dirname, '..') + '/', '')}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
