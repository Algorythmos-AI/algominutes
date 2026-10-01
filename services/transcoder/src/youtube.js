'use strict';

// yt-dlp wrapper with strict host allowlist. Must reject anything that
// isn't YouTube — yt-dlp itself supports hundreds of sites and we don't
// want a misuse vector. Validation runs on the parsed URL host, so
// no string-prefix shenanigans.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Bounds on a download (RELEASE.md rev 11, H2): the transcoder's /tmp is memory, so an unbounded one (a
// 10-hour video, a live stream that never ends) could take the instance down. The longest a note can be
// (any plan's cap, plus the settle's minute of slack), the api's upload size limit, and a wall clock.
const MAX_VIDEO_SECONDS = 4 * 60 * 60 + 60;
const MAX_FILESIZE = '500M';
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
// yt-dlp's stderr is kept for the error, its last part only: a chatty run can't grow it without bound.
const STDERR_KEEP = 16 * 1024;

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

function validateYoutubeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch { // silent-catch-ok: an unparseable URL is invalid input, reported as such
    return { ok: false, reason: 'invalid_url' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'bad_protocol' };
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    return { ok: false, reason: 'host_not_allowed' };
  }
  return { ok: true, url: parsed.toString() };
}

function resolveCookiesFile(outDir) {
  const configuredPath = process.env.YOUTUBE_COOKIES_FILE;
  if (configuredPath) return configuredPath;

  const rawCookies = process.env.YOUTUBE_COOKIES_B64
    ? Buffer.from(process.env.YOUTUBE_COOKIES_B64, 'base64').toString('utf8')
    : process.env.YOUTUBE_COOKIES;
  if (!rawCookies) return null;

  const cookiePath = path.join(outDir, 'youtube-cookies.txt');
  fs.writeFileSync(cookiePath, rawCookies, { mode: 0o600 });
  return cookiePath;
}

function classifyYtDlpError(stderr) {
  const text = String(stderr || '');
  const err = new Error(`yt-dlp failed: ${text.slice(0, 500)}`);
  err.isPermanent = true;
  if (/sign in to confirm|not a bot|use --cookies|cookies-from-browser/i.test(text)) {
    err.code = 'YOUTUBE_COOKIES_REQUIRED';
    err.publicMessage = 'YouTube requires verification for this video right now. Please upload the audio file directly or try another public video.';
    return err;
  }
  if (/precondition check failed|HTTP Error 400: Bad Request/i.test(text)) {
    err.code = 'YOUTUBE_PRECONDITION_FAILED';
    err.publicMessage = 'YouTube refused this download request. Please upload the audio file directly or try another public video.';
    return err;
  }
  if (/signature solving failed|n challenge solving failed|supported JavaScript runtime|challenge solver/i.test(text)) {
    err.code = 'YOUTUBE_EJS_REQUIRED';
    err.publicMessage = 'YouTube download failed because the service could not solve YouTube\'s playback challenge. Please try again shortly.';
    return err;
  }
  if (/private video|members-only|copyright|unavailable|not available|age-restricted/i.test(text)) {
    err.code = 'YOUTUBE_RESTRICTED';
    err.publicMessage = 'YouTube download failed. This video may be private, restricted, or unavailable. Please upload the file directly.';
  }
  return err;
}

function fetchAudio({ url, outDir, log, timeoutMs = Number(process.env.YOUTUBE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS }) {
  const validation = validateYoutubeUrl(url);
  if (!validation.ok) {
    return Promise.reject(new Error(`youtube_validation_failed: ${validation.reason}`));
  }
  const outputTemplate = path.join(outDir, '%(id)s.%(ext)s');
  const cookiesFile = resolveCookiesFile(outDir);
  const extractorArgs = process.env.YOUTUBE_EXTRACTOR_ARGS;
  const jsRuntimes = process.env.YOUTUBE_JS_RUNTIMES || 'node';
  const remoteComponents = process.env.YOUTUBE_REMOTE_COMPONENTS;

  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist',
      '--no-progress',
      '--restrict-filenames',
      '--extract-audio',
      '--audio-format', 'm4a',
      '--audio-quality', '0',
      '-o', outputTemplate,
      '--print', 'after_move:filepath',
      '--max-filesize', MAX_FILESIZE,
      '--match-filter', `duration <= ${MAX_VIDEO_SECONDS} & !is_live`,
    ];
    if (cookiesFile) args.push('--cookies', cookiesFile);
    if (extractorArgs) args.push('--extractor-args', extractorArgs);
    if (jsRuntimes) args.push('--js-runtimes', jsRuntimes);
    if (remoteComponents) args.push('--remote-components', remoteComponents);
    args.push(validation.url);

    // Its own process group, so the clock kills yt-dlp and the ffmpeg it runs: killing yt-dlp alone left its
    // child holding the output pipes, and the download ran on.
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (err) {
        if (log) log.warn({ err }, 'youtube_kill_failed');
      }
      const err = new Error(`yt-dlp timed out after ${timeoutMs} ms`);
      err.code = 'YOUTUBE_TIMEOUT';
      err.isPermanent = true;
      err.publicMessage = 'YouTube took too long to send this video. Please try again later or upload the audio file directly.';
      settle(reject, err);
    }, timeoutMs);
    child.stdout.on('data', (b) => { stdout = (stdout + b.toString()).slice(-STDERR_KEEP); });
    child.stderr.on('data', (b) => { stderr = (stderr + b.toString()).slice(-STDERR_KEEP); });
    child.on('error', (err) => settle(reject, err));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const err = classifyYtDlpError(`yt-dlp exited ${code}: ${stderr}`);
        return settle(reject, err);
      }
      const filepath = stdout.split('\n').map((s) => s.trim()).filter(Boolean).pop();
      if (!filepath) {
        // With the filters above, a clean exit with nothing downloaded is almost always one of them: yt-dlp
        // skips the video quietly (--print implies --quiet).
        const err = new Error('yt-dlp succeeded but reported no output path');
        err.code = 'YOUTUBE_SKIPPED';
        err.isPermanent = true;
        err.publicMessage = 'This video couldn\'t be downloaded: it may be longer than 4 hours, larger than 500 MB, or a live stream. Please upload the audio file directly.';
        return settle(reject, err);
      }
      if (log) log.info({ filepath }, 'youtube_fetch_ok');
      settle(resolve, filepath);
    });
  });
}

module.exports = {
  MAX_VIDEO_SECONDS,
  MAX_FILESIZE,
  validateYoutubeUrl,
  fetchAudio,
  resolveCookiesFile,
  classifyYtDlpError,
  ALLOWED_HOSTS,
};
