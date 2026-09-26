import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// The capabilities the iOS targets must be signed with (the App IDs registered
// on 2026-09-26: docs/runbooks/xcode-cloud.md). Dropping one breaks a feature
// silently: push, Sign in with Apple, or the broadcast hand-off.
const plist = (p: string) => fs.readFileSync(`apps/ios/${p}`, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
// The key's own value: a string, or an array holding it (never a later key's).
const inArray = '(?:(?!</array>)[\\s\\S])*?';
const has = (xml: string, key: string, value: string) =>
  new RegExp(`<key>${key.replace(/\./g, '\\.')}</key>\\s*(<string>${value}</string>|<array>${inArray}<string>${value}</string>)`).test(xml);

describe('iOS entitlements', () => {
  const app = plist('AlgoMinutes/AlgoMinutes.entitlements');
  const ext = plist('BroadcastExtension/BroadcastExtension.entitlements');

  it('the app has push, Sign in with Apple and the shared App Group', () => {
    expect(has(app, 'aps-environment', 'development')).toBe(true);
    expect(has(app, 'com.apple.developer.applesignin', 'Default')).toBe(true);
    expect(has(app, 'com.apple.security.application-groups', 'group.com.algorythmos.algominutes')).toBe(true);
  });

  it('the broadcast extension shares the App Group', () => {
    expect(has(ext, 'com.apple.security.application-groups', 'group.com.algorythmos.algominutes')).toBe(true);
  });
});
