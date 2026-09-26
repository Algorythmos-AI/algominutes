import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// The capabilities the iOS targets must be signed with (the App IDs registered
// on 2026-09-26: docs/runbooks/xcode-cloud.md). Dropping one breaks a feature
// silently: push, Sign in with Apple, or the broadcast hand-off.
/** An entitlements plist's top-level keys and their string values (a string, or an array of strings). */
function entitlements(p: string): Map<string, string[]> {
  const xml = fs.readFileSync(`apps/ios/${p}`, 'utf8');
  // The plist tokens in order, comments skipped: <key>, <string>, <array>, </array>, and <true/> etc.
  const tokens = [...xml.matchAll(/<!--[\s\S]*?-->|<(key|string)>([^<]*)<\/\1>|<(\/?array)>|<(true|false)\/>/g)]
    .filter((m) => !m[0].startsWith('<!--'))
    .map((m) => (m[1] ? { tag: m[1], text: m[2] } : { tag: m[3] ?? m[4], text: '' }));
  const out = new Map<string, string[]>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].tag !== 'key') continue;
    const values: string[] = [];
    const next = tokens[i + 1];
    if (next?.tag === 'string') values.push(next.text);
    if (next?.tag === 'array') {
      for (let j = i + 2; j < tokens.length && tokens[j].tag !== '/array'; j++) if (tokens[j].tag === 'string') values.push(tokens[j].text);
    }
    out.set(tokens[i].text, values);
  }
  return out;
}

describe('iOS entitlements', () => {
  const app = entitlements('AlgoMinutes/AlgoMinutes.entitlements');
  const ext = entitlements('BroadcastExtension/BroadcastExtension.entitlements');

  it('the app has push, Sign in with Apple and the shared App Group', () => {
    expect(app.get('aps-environment')).toEqual(['development']);
    expect(app.get('com.apple.developer.applesignin')).toEqual(['Default']);
    expect(app.get('com.apple.security.application-groups')).toEqual(['group.com.algorythmos.algominutes']);
  });

  it('the broadcast extension shares the App Group', () => {
    expect(ext.get('com.apple.security.application-groups')).toEqual(['group.com.algorythmos.algominutes']);
  });
});
