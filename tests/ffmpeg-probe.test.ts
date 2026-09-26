import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// probeDuration tells a file it can't read (permanent) from the tools failing to
// run at all (transient): only the first may fail a note as damaged.
const require = createRequire(import.meta.url);
const ffmpeg = require('../services/transcoder/src/ffmpeg.js');
const hasFfprobe = (() => { try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
// CI installs ffmpeg (ci.yml), so there a missing binary is a failure, not a skip.
if (process.env.CI && !hasFfprobe) throw new Error('ffmpeg/ffprobe must be installed in CI');

describe('probeDuration failures', () => {
  it('tools that cannot run (not on PATH) are transient', async () => {
    const saved = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      await expect(ffmpeg.probeDuration('/tmp/whatever.m4a')).rejects.toMatchObject({ transient: true });
    } finally {
      process.env.PATH = saved;
    }
  });

  // ffprobe's bitrate estimate for this clip is about 223 s; the audio is 30 s.
  it.skipIf(!hasFfprobe)('ADTS AAC is measured by decoding, not by the bitrate estimate', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
    const f = path.join(dir, 'quiet-start.aac');
    try {
      execFileSync('ffmpeg', [
        '-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=20',
        '-f', 'lavfi', '-i', 'anoisesrc=d=10:r=44100:a=0.3',
        '-filter_complex', '[0][1]concat=n=2:v=0:a=1',
        '-c:a', 'aac', '-b:a', '64k', '-f', 'adts', f,
      ]);
      const d = await ffmpeg.probeDuration(f);
      expect(d).toBeGreaterThan(29.5);
      expect(d).toBeLessThan(30.5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasFfprobe)('a file the tools reject is permanent', async () => {
    // A private directory (mkdtemp), not a predictable name in the shared temp dir.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
    const f = path.join(dir, 'garbage.m4a');
    fs.writeFileSync(f, Buffer.from('this is not audio at all'));
    try {
      await expect(ffmpeg.probeDuration(f)).rejects.toMatchObject({ transient: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
