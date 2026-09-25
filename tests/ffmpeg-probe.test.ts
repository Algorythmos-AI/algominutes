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
