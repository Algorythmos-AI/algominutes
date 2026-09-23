import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Services load the repo layer by explicit subpath (e.g. notifier requires
// '@algominutes/db/push-tokens-repo'). The './*' wildcard maps to './src/*' with
// no extension, so a bare subpath only resolves if it has an explicit export.
// A missing export is a boot crash in production, so pin it here.
const root = resolve(__dirname, '..');
const dbPkg = JSON.parse(readFileSync(join(root, 'packages/db/package.json'), 'utf8')) as {
  exports: Record<string, string>;
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(c?js|ts)$/.test(name)) out.push(p);
  }
  return out;
}

describe('@algominutes/db exports', () => {
  it('every explicit export points at a file that exists', () => {
    for (const [key, target] of Object.entries(dbPkg.exports)) {
      if (key.includes('*')) continue;
      expect(existsSync(join(root, 'packages/db', target)), `${key} -> ${target}`).toBe(true);
    }
  });

  it('every literal @algominutes/db/<name> subpath used by a service has an explicit export', () => {
    const used = new Set<string>();
    for (const f of walk(join(root, 'services'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/['"`]@algominutes\/db\/([a-z0-9-]+)['"`]/g)) {
        used.add(`./${m[1]}`);
      }
    }
    expect(used.size).toBeGreaterThan(0);
    for (const sub of used) expect(dbPkg.exports[sub], `missing export for ${sub}`).toBeDefined();
  });
});
