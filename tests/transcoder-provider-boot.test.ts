import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';

// The transcoder refuses to boot with an engine it can't replay safely (audit Q30): Deepgram's inline mode
// records no operation id, so a replayed kickoff re-transcribes and pays again.
const require = createRequire(import.meta.url);
const { assertProviderBootable } = require('../services/transcoder/src/stt-provider.js');

describe('the speech engine at boot', () => {
  it('refuses Deepgram, in any spelling', () => {
    for (const v of ['deepgram', ' DeepGram ']) expect(() => assertProviderBootable({ STT_PROVIDER: v })).toThrow(/audit Q30/);
  });

  it('boots with Google (the default) and AssemblyAI', () => {
    expect(assertProviderBootable({})).toBe('google');
    expect(assertProviderBootable({ STT_PROVIDER: 'assemblyai' })).toBe('assemblyai');
  });

  it('is checked at startup, before the server listens', () => {
    const src = fs.readFileSync('services/transcoder/src/index.js', 'utf8');
    const check = src.indexOf("assertProviderBootable(process.env)");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(src.indexOf('app.listen('));
  });
});
