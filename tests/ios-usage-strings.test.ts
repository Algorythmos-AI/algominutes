import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The permission prompts iOS shows (Info.plist usage strings) must say what the app does, and agree with the App
// Privacy answers: a scanned image never leaves the iPhone, only its text (#465; STORE-COMPLIANCE §2 declares no
// Photos or Videos). docs/STORE-COMPLIANCE.md §4.2 quotes each string; the quote must be the string itself.
const plist = readFileSync('apps/ios/AlgoMinutes/Info.plist', 'utf8');
const doc = readFileSync('docs/STORE-COMPLIANCE.md', 'utf8');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

const usage = (key: string) => {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist);
  if (!m) throw new Error(`${key} missing from Info.plist`);
  return squash(m[1].replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
};
const quoted = (key: string) => {
  const section = doc.slice(doc.indexOf('### 4.2'), doc.indexOf('## 5.'));
  const at = section.indexOf(`**\`${key}\`**`);
  if (at < 0) throw new Error(`${key} not quoted in STORE-COMPLIANCE §4.2`);
  const lines = section.slice(at).split('\n').slice(1);
  const quote = lines.slice(0, lines.findIndex((l) => !l.trim().startsWith('>'))).map((l) => l.replace(/^\s*>\s?/, '')).join(' ');
  return squash(quote).replace(/^"|"$/g, '');
};

const KEYS = ['NSMicrophoneUsageDescription', 'NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription'];

describe('the permission prompts', () => {
  it('never say a scanned image is kept: only its text leaves the iPhone', () => {
    for (const key of ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription']) {
      expect(usage(key), key).not.toMatch(/stored|uploaded|kept in your account/i);
      expect(usage(key), key).toMatch(/only the text/i);
    }
  });

  it('are quoted word for word in STORE-COMPLIANCE §4.2', () => {
    for (const key of KEYS) expect(quoted(key), key).toBe(usage(key));
  });
});
