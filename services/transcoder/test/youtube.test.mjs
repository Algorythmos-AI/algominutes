// yt-dlp is bounded (RELEASE.md rev 11, H2): a size cap, a length filter, no live streams, a wall clock, and
// only the tail of its output kept (memory only, so not tested here). A fake yt-dlp on PATH stands in; nothing reaches YouTube.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const youtube = require('../src/youtube.js');

const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ytdlp-'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-out-'));
const argsFile = path.join(bin, 'args');
const savedPath = process.env.PATH;
const URL_OK = 'https://www.youtube.com/watch?v=abc';

// FAKE_MODE picks the fake's behaviour: ok (prints a file path), hang, skip (exit 0, nothing).
before(() => {
  fs.writeFileSync(path.join(bin, 'yt-dlp'), `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
case "$FAKE_MODE" in
  ok) echo "${out}/abc.m4a" ;;
  hang) sleep 30 ;;
  skip) exit 0 ;;
esac
`, { mode: 0o755 });
  process.env.PATH = `${bin}:${savedPath}`;
});
after(() => { process.env.PATH = savedPath; });

const run = (mode, opts = {}) => {
  process.env.FAKE_MODE = mode;
  return youtube.fetchAudio({ url: URL_OK, outDir: out, ...opts });
};

test('asks yt-dlp for at most 500 MB, at most 4 hours and a minute, and no live stream', async () => {
  assert.equal(await run('ok'), `${out}/abc.m4a`);
  const args = fs.readFileSync(argsFile, 'utf8').split('\n');
  assert.equal(args[args.indexOf('--max-filesize') + 1], '500M');
  assert.equal(args[args.indexOf('--match-filter') + 1], `duration <= ${4 * 3600 + 60} & !is_live`);
});

test('a download that runs past the clock is killed, and fails permanently with a message', async () => {
  const started = Date.now();
  await assert.rejects(run('hang', { timeoutMs: 300 }), (err) => {
    assert.equal(err.code, 'YOUTUBE_TIMEOUT');
    assert.equal(err.isPermanent, true);
    assert.match(err.publicMessage, /took too long/);
    return true;
  });
  assert.ok(Date.now() - started < 5000, 'killed, not waited out');
});

test('a video the filters skip fails permanently, saying why it might have', async () => {
  await assert.rejects(run('skip'), (err) => {
    assert.equal(err.code, 'YOUTUBE_SKIPPED');
    assert.equal(err.isPermanent, true);
    assert.match(err.publicMessage, /longer than 4 hours.*live stream/);
    return true;
  });
});
