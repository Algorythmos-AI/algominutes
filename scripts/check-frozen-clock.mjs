#!/usr/bin/env node
// Fails CI if an integration test freezes its clock (`const now = new Date('2026-…')`)
// and then, in the same test block, calls a repo or job function that takes a
// `now` without passing it. Such a test runs on two clocks: the data is made at
// the frozen one and read at the real one, so it passes until the calendar
// moves past what the frozen clock built. It happened once: the db-job invite
// test made a 14-day invite "on 2026-10-01" and redeemed it at the real clock,
// so every PR was red from 2026-10-18 (BLOCKERS §0, plan rev 12 S1).
//
// Syntax-light: the clock-taking functions are read from their signatures in
// the repo layer and the db-job handlers, and a test block is the text from one
// `it(`/`test(` to the next.
import fs from 'node:fs';
import path from 'node:path';

// Source files under a directory; tests included only when asked.
const walk = (d, { tests = false } = {}, o = []) => {
  for (const n of fs.readdirSync(d)) {
    if (n === 'node_modules' || n === 'dist') continue;
    const p = path.join(d, n);
    if (fs.statSync(p).isDirectory()) walk(p, { tests }, o);
    else if (/\.(c?js|mjs|ts)$/.test(n) && /\.test\./.test(n) === tests) o.push(p);
  }
  return o;
};

// The text between a function's opening paren and its matching close.
function paramsAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return '';
}

// Every exported function whose parameters include a `now` (`now?: Date`,
// `now: Date = new Date()`, `now = new Date()`, or `now` in a destructured
// options object).
const clockTakers = new Set();
const sources = [...walk('packages/db/src'), ...walk('services/db-job/src/handlers')];
for (const f of sources) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const params = paramsAt(src, m.index + m[0].length - 1);
    if (/(?:^|[\s{,])now\s*(?:[?:=,}]|$)/.test(params)) clockTakers.add(m[1]);
  }
}
if (!clockTakers.has('redeemInvite') || !clockTakers.has('run')) {
  console.log('FAIL  check-frozen-clock: could not read the clock-taking functions (expected redeemInvite and run among them).');
  process.exit(1);
}

const frozenClock = /\bconst\s+now\s*=\s*new Date\(\s*['"]\d{4}-/;
const calls = new RegExp(`(?:^|[^\\w$.])(?:[\\w$]+\\.)?(${[...clockTakers].join('|')})\\s*\\(`, 'g');
let failed = false;
const testFiles = walk('tests/integration', { tests: true });
if (testFiles.length === 0) {
  console.log('FAIL  check-frozen-clock: no integration tests found under tests/integration.');
  process.exit(1);
}
for (const f of testFiles) {
  const src = fs.readFileSync(f, 'utf8');
  if (!frozenClock.test(src)) continue;
  // Blocks: each `it(`/`test(` at the start of a line to the next one.
  const starts = [...src.matchAll(/^\s*(?:it|test)\s*\(/gm)].map(m => m.index);
  for (let b = 0; b < starts.length; b++) {
    const block = src.slice(starts[b], starts[b + 1] ?? src.length);
    if (!frozenClock.test(block)) continue;
    for (const c of block.matchAll(calls)) {
      const args = paramsAt(block, c.index + c[0].length - 1);
      if (/(?:^|[\s{,(])now\s*(?:[,}:)]|$)/.test(args)) continue;
      const line = src.slice(0, starts[b] + c.index).split('\n').length;
      console.log(`  FAIL  ${f}:${line}: ${c[1]}(…) runs on the real clock inside a test whose clock is frozen; pass \`now\`.`);
      failed = true;
    }
  }
}
if (failed) {
  console.log('\nA test that freezes `now` must pass it to every call that takes one, or it passes only until the calendar catches up.');
  process.exit(1);
}
console.log(`OK: every frozen-clock integration test passes its clock (${clockTakers.size} clock-taking functions checked).`);
