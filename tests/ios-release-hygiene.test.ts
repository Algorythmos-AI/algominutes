import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// What a tester's build (Staging, Release) must and mustn't carry (RELEASE.md
// PR 11). Neither defines DEBUG: `#if DEBUG` code is compiled out of both.

const APP = 'apps/ios/AlgoMinutes';

function swiftFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return swiftFiles(p);
    return e.name.endsWith('.swift') ? [p] : [];
  });
}

/** The source as a build without DEBUG sees it: `#if DEBUG` blocks (and their `#else` kept) resolved. */
export function withoutDebug(source: string): string {
  const out: string[] = [];
  // One entry per open #if: whether its current branch is dropped.
  const stack: { debug: boolean; dropping: boolean }[] = [];
  const dropped = () => stack.some((s) => s.dropping);
  for (const line of source.split('\n')) {
    const t = line.trim();
    if (/^#if\b/.test(t)) {
      const debug = /^#if\s+DEBUG\s*$/.test(t);
      stack.push({ debug, dropping: debug });
      continue;
    }
    if (/^#else\b/.test(t) && stack.length) {
      const top = stack[stack.length - 1];
      if (top.debug) top.dropping = !top.dropping;
      continue;
    }
    if (/^#endif\b/.test(t) && stack.length) {
      stack.pop();
      continue;
    }
    if (!dropped()) out.push(line);
  }
  return out.join('\n');
}

describe('iOS Release hygiene', () => {
  const sources = swiftFiles(APP).map((f) => ({ f, text: fs.readFileSync(f, 'utf8') }));

  it('resolves #if DEBUG blocks the way a Release build does', () => {
    const src = ['a', '#if DEBUG', 'b', '#else', 'c', '#endif', '#if os(iOS)', 'd', '#endif', '#if DEBUG', 'e', '#endif'].join('\n');
    expect(withoutDebug(src).split('\n')).toEqual(['a', 'c', 'd']);
  });

  it('no admin card, and no admin allowlist, in a tester build', () => {
    for (const { f, text } of sources) {
      const release = withoutDebug(text);
      expect(release, f).not.toMatch(/AdminCostsCard|adminEmails|isAdmin\b/);
    }
  });

  it("names no one: the only email addresses in the app are the company's", () => {
    const plist = fs.readFileSync(`${APP}/Info.plist`, 'utf8');
    for (const { f, text } of [...sources, { f: 'Info.plist', text: plist }]) {
      for (const [address] of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
        expect(address, `${f}: ${address}`).toMatch(/@algorythmos\.com$/);
      }
    }
  });

  it('logs through AppLog: os.Logger, with Crashlytics breadcrumbs outside Debug, and never print', () => {
    const appLog = fs.readFileSync(`${APP}/Services/AppLog.swift`, 'utf8');
    expect(appLog).toMatch(/Logger\(/);
    expect(withoutDebug(appLog)).toMatch(/Crashlytics\.crashlytics\(\)\.log\(/);
    for (const { f, text } of sources) {
      const calls = text.split('\n').filter((l) => /(?<![.\w])print\(/.test(l) && !/func print\(/.test(l));
      expect(calls, f).toEqual([]);
    }
  });

  // The microphone text is per configuration (MICROPHONE_USAGE_DESCRIPTION in project.yml). 1.0 ships without
  // call capture (DECISIONS.md, 2026-10-29), so the App Store build's text says nothing of calls; staging, which
  // keeps "Record a call", still covers it.
  it('the microphone text covers a call in another app only where the build captures one', () => {
    const plist = fs.readFileSync(`${APP}/Info.plist`, 'utf8');
    const mic = plist.match(/<key>NSMicrophoneUsageDescription<\/key>\s*<string>([^<]*)<\/string>/)?.[1] ?? '';
    expect(mic).toBe('$(MICROPHONE_USAGE_DESCRIPTION)');
    const yml = fs.readFileSync('apps/ios/project.yml', 'utf8');
    const setting = (config: string, key: string) => {
      const block = yml.split(new RegExp(`\\n    ${config}:\\n`))[1]?.split(/\n    [A-Za-z]+:\n/)[0] ?? '';
      return block.match(new RegExp(`^\\s+${key}:\\s*"([^"]*)"`, 'm'))?.[1] ?? '';
    };
    expect(setting('Release', 'CALL_CAPTURE_ENABLED')).toBe('NO');
    expect(setting('Release', 'MICROPHONE_USAGE_DESCRIPTION')).not.toMatch(/call|another app|capture/i);
    for (const config of ['Debug', 'Staging']) {
      expect(setting(config, 'CALL_CAPTURE_ENABLED'), config).toBe('YES');
      expect(setting(config, 'MICROPHONE_USAGE_DESCRIPTION'), config).toMatch(/a call in another app/);
    }
    for (const config of ['Debug', 'Staging', 'Release']) {
      expect(setting(config, 'MICROPHONE_USAGE_DESCRIPTION'), config).toMatch(/never starts on its own/);
    }
  });
});
