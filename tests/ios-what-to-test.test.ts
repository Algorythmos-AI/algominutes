import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// TestFlight's What to Test (apps/ios/ci_scripts/what-to-test.sh), run against
// a scratch repository so its commit filtering is exercised for real.
const SCRIPT = path.resolve('apps/ios/ci_scripts/what-to-test.sh');
const POST_BUILD = fs.readFileSync('apps/ios/ci_scripts/ci_post_xcodebuild.sh', 'utf8');

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function commit(file: string, subject: string) {
  const full = path.join(repo, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.appendFileSync(full, `${subject}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', subject);
}

function run(env: Record<string, string> = {}) {
  const out = path.join(repo, 'apps/ios/TestFlight/WhatToTest.en-US.txt');
  execFileSync('sh', [SCRIPT, out], {
    cwd: repo,
    env: { PATH: process.env.PATH ?? '', HOME: repo, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return fs.readFileSync(out, 'utf8');
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ci@example.com');
  git('config', 'user.name', 'CI');
  git('config', 'commit.gpgsign', 'false');
  commit('apps/ios/project.yml', 'chore: project');
  fs.writeFileSync(path.join(repo, 'apps/ios/project.yml'), 'settings:\n  base:\n    MARKETING_VERSION: "1.2.3"\n');
  git('commit', '-q', '-am', 'chore: version');
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('What to Test', () => {
  it('names the version, the build and the commit', () => {
    const text = run({ CI_BUILD_NUMBER: '52' });
    expect(text.split('\n')[0]).toBe(`AlgoMinutes 1.2.3 (52), commit ${git('rev-parse', '--short=12', 'HEAD')}`);
  });

  it("lists the app's own feat and fix commits, in plain words, newest first", () => {
    commit('apps/ios/AlgoMinutes/A.swift', 'feat(ios): a guest keeps their notes (#12)');
    commit('apps/ios/AlgoMinutesTests/T.swift', 'fix(ios): a test-only fix');
    commit('apps/ios/ci_scripts/x.sh', 'fix(ios): a CI-only fix');
    commit('apps/ios/AlgoMinutes/B.swift', 'docs(ios): a comment');
    commit('services/api/x.js', 'fix(api): a server fix');
    commit('apps/ios/BroadcastExtension/C.swift', 'fix(ios,contracts)!: capture asks first (#13)');
    const changes = run().split('RECENT CHANGES (newest first)\n')[1].split('\n\n')[0];
    expect(changes).toBe('- Capture asks first\n- A guest keeps their notes');
  });

  it('keeps only the 10 newest changes', () => {
    for (let i = 1; i <= 12; i++) commit(`apps/ios/AlgoMinutes/F${i}.swift`, `fix(ios): change ${i}`);
    const lines = run().split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe('- Change 12');
  });

  it("stays within TestFlight's 4,000 characters, cutting whole lines", () => {
    for (let i = 1; i <= 10; i++) commit(`apps/ios/AlgoMinutes/L${i}.swift`, `feat(ios): ${'long '.repeat(90)}${i}`);
    const text = run();
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text.split('\n').filter((l) => l.startsWith('- ')).length).toBeGreaterThan(0);
    expect(text).toContain('Share Beta Feedback');
  });

  it('puts the hand-written notes first, without their comment lines', () => {
    commit('apps/ios/release-notes/what-to-test.txt', '# a note for editors\n\nTry the new chat.\n');
    const text = run();
    expect(text).toContain('WHAT TO TRY\nTry the new chat.\n\nRECENT CHANGES');
    expect(text).not.toContain('a note for editors');
  });

  it('leaves out an empty or comment-only notes file', () => {
    commit('apps/ios/release-notes/what-to-test.txt', '# nothing to try this time');
    expect(run()).not.toContain('WHAT TO TRY');
  });

  it('says so when it finds no app changes', () => {
    expect(run()).toContain('- (no app changes found in the history this build could see)');
  });
});

describe('ci_post_xcodebuild.sh', () => {
  it('writes What to Test where Xcode Cloud reads it, before the dSYM upload, and never fails on it', () => {
    const call = POST_BUILD.indexOf('if ! sh ci_scripts/what-to-test.sh TestFlight/WhatToTest.en-US.txt; then');
    expect(call).toBeGreaterThan(POST_BUILD.indexOf('cd "${CI_PRIMARY_REPOSITORY_PATH'));
    expect(call).toBeLessThan(POST_BUILD.indexOf('"$UPLOAD" -gsp'));
  });
});
