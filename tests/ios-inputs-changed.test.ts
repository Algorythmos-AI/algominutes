import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// scripts/ios-inputs-changed.sh decides whether ios.yml's ios-test and codeql-swift.yml's analyze (swift) run
// (a skipped job satisfies a required check). Run here against a real git repository: an "origin" with a PR's
// head at refs/pull/7/head, and the merge queue's commit made from it, as GitHub makes it. `gh` is a stub
// that answers how many successful runs of the check the head has.
const SCRIPT = path.resolve(__dirname, '../scripts/ios-inputs-changed.sh');
let dir: string;
let origin: string;
let work: string;
let bin: string;
const sha: Record<string, string> = {};

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
  fs.writeFileSync(path.join(work, rel), text);
};
const commit = (msg: string) => { git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', msg); return git(work, 'rev-parse', 'HEAD'); };

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-inputs-'));
  origin = path.join(dir, 'origin.git');
  work = path.join(dir, 'work');
  bin = path.join(dir, 'bin');
  git(dir, 'init', '-q', '--bare', origin);
  git(dir, 'init', '-q', '-b', 'integration', work);
  git(work, 'remote', 'add', 'origin', origin);
  write('apps/ios/App.swift', 'let a = 1\n');
  write('services/api/x.js', '1\n');
  sha.base = commit('base');
  // The PR: an iOS change and a server change.
  git(work, 'switch', '-q', '-c', 'pr');
  write('apps/ios/App.swift', 'let a = 2\n');
  write('services/api/x.js', '2\n');
  sha.head = commit('pr');
  git(work, 'push', '-q', 'origin', `${sha.head}:refs/pull/7/head`);
  // The queue's commit: the PR squashed onto integration (same tree as the head).
  git(work, 'switch', '-q', 'integration');
  git(work, 'switch', '-q', '-c', 'queue');
  git(work, 'checkout', '-q', sha.head, '--', '.');
  sha.queue = commit('queue');
  // A queue with another iOS change ahead of the PR.
  git(work, 'switch', '-q', '-c', 'queue2', sha.base);
  write('apps/ios/Other.swift', 'let b = 1\n');
  commit('ahead');
  git(work, 'checkout', '-q', sha.head, '--', 'apps/ios/App.swift', 'services/api/x.js');
  sha.queue2 = commit('queue2');
  // A server-only change.
  git(work, 'switch', '-q', '-c', 'server', sha.base);
  write('services/api/x.js', '3\n');
  sha.server = commit('server');
  fs.mkdirSync(bin);
  // The pulls endpoint answers the merged PR's number; the check-runs endpoint, how many runs passed.
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "$@" >> "$GH_LOG"\ncase "$*" in *"/pulls"*) echo "${GH_PR:-}" ;; *) echo "${GH_PASSED:-0}" ;; esac\n', { mode: 0o755 });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(env: Record<string, string>, check = 'analyze (swift)') {
  const out = path.join(dir, `out-${Math.random()}`);
  const log = path.join(dir, `gh-${Math.random()}`);
  fs.writeFileSync(out, '');
  const r = spawnSync('bash', [SCRIPT, check, 'apps/ios', '.github/workflows/codeql-swift.yml'], {
    cwd: work,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: out, GH_LOG: log, REPO: 'o/r', GH_TOKEN: 't', ...env },
  });
  expect(r.status, r.stderr.toString()).toBe(0);
  const ios = /ios=(\w+)/.exec(fs.readFileSync(out, 'utf8'))?.[1];
  return { ios, said: r.stdout.toString(), asked: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

describe('a pull request or a push', () => {
  it('runs when an iOS input changed, and skips when none did', () => {
    expect(run({ EVENT: 'pull_request', PR_BASE: sha.base, GITHUB_SHA: sha.head }).ios).toBe('true');
    expect(run({ EVENT: 'pull_request', PR_BASE: sha.base, GITHUB_SHA: sha.server }).ios).toBe('false');
    expect(run({ EVENT: 'push', BEFORE: sha.base, GITHUB_SHA: sha.server }).ios).toBe('false');
  });

  it('runs with no usable base (a new branch, a force-push), and when scheduled', () => {
    expect(run({ EVENT: 'push', BEFORE: '0000000000000000000000000000000000000000', GITHUB_SHA: sha.server }).ios).toBe('true');
    expect(run({ EVENT: 'push', BEFORE: 'deadbeef'.repeat(5), GITHUB_SHA: sha.server }).ios).toBe('true');
    expect(run({ EVENT: 'schedule', GITHUB_SHA: sha.server }).ios).toBe('true');
  });
});

describe('the merge queue', () => {
  const queued = (extra: Record<string, string> = {}) => ({
    EVENT: 'merge_group', QUEUE_BASE: sha.base, GITHUB_SHA: sha.queue,
    QUEUE_HEAD_REF: `refs/heads/gh-readonly-queue/integration/pr-7-${sha.base}`, ...extra,
  });

  it('skips when its iOS inputs are exactly the PR head\'s, which passed the check', () => {
    const r = run({ ...queued(), GH_PASSED: '1' });
    expect(r.ios).toBe('false');
    expect(r.said).toContain('PR #7');
    expect(r.asked).toContain(`repos/o/r/commits/${sha.head}/check-runs?check_name=analyze%20%28swift%29`);
  });

  it('runs when the head has the same inputs but hasn\'t passed the check', () => {
    expect(run({ ...queued(), GH_PASSED: '0' }).ios).toBe('true');
  });

  it('runs when something ahead of it in the queue changed the iOS inputs, and never asks about the check', () => {
    const r = run({ ...queued({ GITHUB_SHA: sha.queue2 }), GH_PASSED: '1' });
    expect(r.ios).toBe('true');
    expect(r.asked).toBe('');
  });

  it('runs when the queued PR can\'t be found', () => {
    expect(run({ ...queued({ QUEUE_HEAD_REF: 'refs/heads/gh-readonly-queue/integration/pr-99-abc' }), GH_PASSED: '1' }).ios).toBe('true');
    expect(run({ ...queued({ QUEUE_HEAD_REF: '' }), GH_PASSED: '1' }).ios).toBe('true');
  });

  it('a queue with no iOS change at all skips without asking', () => {
    const r = run({ EVENT: 'merge_group', QUEUE_BASE: sha.base, GITHUB_SHA: sha.server, QUEUE_HEAD_REF: `refs/heads/gh-readonly-queue/integration/pr-7-${sha.base}` });
    expect(r.ios).toBe('false');
    expect(r.asked).toBe('');
  });
});

describe('after a merge (a push), for the iOS tests only', () => {
  const merged = (extra: Record<string, string> = {}) => ({ EVENT: 'push', BEFORE: sha.base, GITHUB_SHA: sha.queue, GH_PR: '7', ...extra });

  it('skips when the merged PR\'s head passed on the same inputs', () => {
    const r = run({ ...merged(), SKIP_PUSH_IF_PR_PASSED: 'true', GH_PASSED: '1' });
    expect(r.ios).toBe('false');
    expect(r.asked).toContain(`repos/o/r/commits/${sha.queue}/pulls`);
  });

  it('runs when that head didn\'t pass, when other changes landed with it, or when there\'s no PR', () => {
    expect(run({ ...merged(), SKIP_PUSH_IF_PR_PASSED: 'true', GH_PASSED: '0' }).ios).toBe('true');
    expect(run({ ...merged({ GITHUB_SHA: sha.queue2 }), SKIP_PUSH_IF_PR_PASSED: 'true', GH_PASSED: '1' }).ios).toBe('true');
    expect(run({ ...merged({ GH_PR: '' }), SKIP_PUSH_IF_PR_PASSED: 'true', GH_PASSED: '1' }).ios).toBe('true');
  });

  it('without the switch (the Swift scan, which keeps code scanning current), always runs, and asks nothing', () => {
    const r = run({ ...merged(), GH_PASSED: '1' });
    expect(r.ios).toBe('true');
    expect(r.asked).toBe('');
  });
});

describe('the workflows', () => {
  const read = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');

  it('each asks about its own check, by the name GitHub reports it, over its own inputs', () => {
    const ios = read('.github/workflows/ios.yml');
    expect(ios).toContain('run: bash scripts/ios-inputs-changed.sh ios-test apps/ios packages/contracts .github/workflows/ios.yml scripts/ios-inputs-changed.sh');
    expect(ios).toMatch(/\n  ios-test:\n    needs: changes\n    if: needs.changes.outputs.ios == 'true'/);
    expect(ios).toContain("SKIP_PUSH_IF_PR_PASSED: 'true'");
    const swift = read('.github/workflows/codeql-swift.yml');
    expect(swift).not.toContain('SKIP_PUSH_IF_PR_PASSED');
    expect(swift).toContain("run: bash scripts/ios-inputs-changed.sh 'analyze (swift)' apps/ios .github/workflows/codeql-swift.yml scripts/ios-inputs-changed.sh");
    expect(swift).toMatch(/\n  analyze:\n    name: analyze \(swift\)\n    needs: changes\n    if: needs.changes.outputs.ios == 'true'/);
    for (const w of [ios, swift]) {
      // A new push cancels the PR's superseded run; queue and push runs never are.
      expect(w).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
      expect(w).toContain("group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.sha }}");
      expect(w).toContain('QUEUE_HEAD_REF: ${{ github.event.merge_group.head_ref }}');
      expect(w).toMatch(/pull-requests: read\n\s+checks: read/);
    }
  });

  it('the Swift scan fetches its packages before CodeQL traces, from the cache, and builds from them', () => {
    const swift = read('.github/workflows/codeql-swift.yml');
    const resolve = swift.indexOf('name: Resolve packages (not traced)');
    const init = swift.indexOf('uses: github/codeql-action/init@v4');
    expect(swift.indexOf('name: Cache Swift packages')).toBeGreaterThan(0);
    expect(resolve).toBeGreaterThan(0);
    expect(resolve).toBeLessThan(init);
    expect(swift.slice(init)).toContain('-clonedSourcePackagesDirPath "$HOME/spm-packages" \\\n            -disableAutomaticPackageResolution');
  });
});
