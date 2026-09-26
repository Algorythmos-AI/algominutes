#!/usr/bin/env node
// Fails CI if a service or shared package imports a bare module it does not
// declare in its own package.json. npm-workspace hoisting hides these locally
// (another workspace installed it), but each Cloud Run image installs only its
// own workspace closure, so an undeclared import builds fine and then crashes on
// boot with ERR_MODULE_NOT_FOUND. Found twice in practice: @google/generative-ai
// via the @algominutes/db barrel, and helmet in services/billing.
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';

const builtins = new Set([...builtinModules, ...builtinModules.map(m => 'node:' + m)]);
let failed = false;
const roots = [...fs.readdirSync('services').map(s => 'services/' + s), 'packages/ai', 'packages/db', 'packages/contracts'];
const walk = (d, o = []) => { for (const n of fs.readdirSync(d)) { if (n === 'node_modules') continue; const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p, o) : /\.(c?js|mjs|ts)$/.test(n) && !/\.test\./.test(n) && o.push(p); } return o; };
const re = /(?:require\(\s*|from\s+|import\(\s*)['"]([^'"./][^'"]*)['"]/g;
for (const r of roots) {
  if (!fs.existsSync(r + '/package.json')) continue;
  const pk = JSON.parse(fs.readFileSync(r + '/package.json'));
  const declared = new Set(Object.keys({ ...pk.dependencies, ...pk.peerDependencies }));
  const missing = new Map();
  for (const f of walk(r + '/src')) for (const m of fs.readFileSync(f, 'utf8').matchAll(re)) {
    const spec = m[1]; if (spec.includes('${')) continue;
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (builtins.has(name) || builtins.has(spec) || declared.has(name) || name === pk.name) continue;
    if (!missing.has(name)) missing.set(name, path.relative(r, f));
  }
  if (missing.size) {
    failed = true;
    for (const [n, f] of missing) console.log(`  FAIL  ${r}: imports '${n}' (${f}) but does not declare it`);
  }
}
if (failed) {
  console.log('\nDeclare each package in that workspace\'s package.json dependencies.');
  process.exit(1);
}
console.log('OK: every workspace declares the packages it imports.');
