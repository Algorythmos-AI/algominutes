'use strict';

// Ported from services/transcoder/src/youtube.js.
//
// The transcoder's youtube.js downloads AUDIO (yt-dlp --extract-audio) to feed
// STT. The EXTRACTOR is a text service, so it instead pulls the video's
// captions/transcript with yt-dlp (--write-subs/--write-auto-subs
// --skip-download) and parses them to plain text. Reused verbatim from the
// source: the host allowlist (validateYoutubeUrl), cookie resolution
// (resolveCookiesFile) and the yt-dlp error classifier (classifyYtDlpError) —
// the security posture (strict YouTube-only host allowlist, no string-prefix
// shenanigans) is identical and deliberately unchanged.
//
// TODO(extractor): a video with NO captions (manual or auto) cannot become
// text here without speech-to-text. That path already exists — it is the
// transcoder (audio -> chunks -> STT v2). Rather than duplicate STT, this
// endpoint returns a permanent 422 telling the caller to route captionless
// videos through the audio pipeline. Wiring "extractor asks transcoder to do
// the audio path" is an async orchestration decision left for A7 (the pipeline
// wiring phase); it must not be a synchronous service-to-service call (§3.3).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  } catch (err) {
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
  err.status = 422; // permanent -> the extractor surfaces it as 422 (see index.js)
  if (/sign in to confirm|not a bot|use --cookies|cookies-from-browser/i.test(text)) {
    err.code = 'YOUTUBE_COOKIES_REQUIRED';
    err.publicMessage = 'YouTube requires verification for this video right now. Please upload the audio file directly or try another public video.';
    return err;
  }
  if (/precondition check failed|HTTP Error 400: Bad Request/i.test(text)) {
    err.code = 'YOUTUBE_PRECONDITION_FAILED';
    err.publicMessage = 'YouTube refused this request. Please upload the file directly or try another public video.';
    return err;
  }
  if (/signature solving failed|n challenge solving failed|supported JavaScript runtime|challenge solver/i.test(text)) {
    err.code = 'YOUTUBE_EJS_REQUIRED';
    err.publicMessage = 'YouTube extraction failed because the service could not solve YouTube\'s playback challenge. Please try again shortly.';
    return err;
  }
  if (/private video|members-only|copyright|unavailable|not available|age-restricted/i.test(text)) {
    err.code = 'YOUTUBE_RESTRICTED';
    err.publicMessage = 'YouTube extraction failed. This video may be private, restricted, or unavailable. Please upload the file directly.';
  }
  return err;
}

function badRequest(reason) {
  const err = new Error(`youtube_validation_failed: ${reason}`);
  err.status = 400;
  err.isPermanent = true;
  err.publicMessage = 'That is not a valid YouTube URL.';
  return err;
}

function noCaptions() {
  const err = new Error('youtube_no_captions');
  err.status = 422;
  err.isPermanent = true;
  err.code = 'YOUTUBE_NO_CAPTIONS';
  err.publicMessage = 'This video has no captions to extract. To transcribe it, route it through the audio pipeline instead.';
  return err;
}

const SUB_EXTS = ['.json3', '.srv3', '.vtt', '.srt'];

// Fetch captions/transcript for a YouTube URL and return plain text.
function fetchTranscript({ url, log }) {
  const validation = validateYoutubeUrl(url);
  if (!validation.ok) return Promise.reject(badRequest(validation.reason));

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-yt-'));
  const outputTemplate = path.join(outDir, '%(id)s.%(ext)s');
  const cookiesFile = resolveCookiesFile(outDir);
  const extractorArgs = process.env.YOUTUBE_EXTRACTOR_ARGS;
  const jsRuntimes = process.env.YOUTUBE_JS_RUNTIMES || 'node';
  const remoteComponents = process.env.YOUTUBE_REMOTE_COMPONENTS;
  const subLangs = process.env.YOUTUBE_SUB_LANGS || 'en.*,en';

  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist',
      '--no-progress',
      '--restrict-filenames',
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs', subLangs,
      '--sub-format', 'json3/srv3/vtt/best',
      '-o', outputTemplate,
    ];
    if (cookiesFile) args.push('--cookies', cookiesFile);
    if (extractorArgs) args.push('--extractor-args', extractorArgs);
    if (jsRuntimes) args.push('--js-runtimes', jsRuntimes);
    if (remoteComponents) args.push('--remote-components', remoteComponents);
    args.push(validation.url);

    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => { cleanupDir(outDir, log); reject(err); });
    child.on('close', (code) => {
      try {
        if (code !== 0) {
          throw classifyYtDlpError(`yt-dlp exited ${code}: ${stderr}`);
        }
        const subFile = findSubtitleFile(outDir);
        if (!subFile) throw noCaptions();
        const raw = fs.readFileSync(subFile, 'utf8');
        const text = parseSubtitles(subFile, raw);
        if (!text.trim()) throw noCaptions();
        if (log) log.info({ subFile: path.basename(subFile), chars: text.length }, 'youtube_transcript_ok');
        resolve({ text, meta: { source: 'captions', file: path.basename(subFile) } });
      } catch (err) {
        reject(err);
      } finally {
        cleanupDir(outDir, log);
      }
    });
  });
}

function findSubtitleFile(dir) {
  const files = fs.readdirSync(dir);
  for (const ext of SUB_EXTS) {
    const hit = files.find((f) => f.toLowerCase().endsWith(ext));
    if (hit) return path.join(dir, hit);
  }
  return null;
}

function cleanupDir(dir, log) {
  // Best-effort temp cleanup; surfaced, never a silent catch.
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (err) { if (log) log.warn({ err, dir }, 'youtube_tmp_cleanup_failed'); }
}

function parseSubtitles(file, raw) {
  const lower = file.toLowerCase();
  if (lower.endsWith('.json3') || lower.endsWith('.srv3')) return parseJson3(raw);
  return parseVtt(raw); // .vtt / .srt share enough structure for this cue parser
}

// YouTube timedtext json3: { events: [ { segs: [ { utf8 }, ... ] }, ... ] }
function parseJson3(raw) {
  let doc;
  try { doc = JSON.parse(raw); }
  catch { return ''; }
  const lines = [];
  for (const ev of doc.events || []) {
    if (!ev.segs) continue;
    const line = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
  }
  return dedupeConsecutive(lines).join('\n');
}

// Strip WebVTT/SRT timing + markup down to spoken text.
function parseVtt(raw) {
  const out = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === 'WEBVTT') continue;
    if (/^\d+$/.test(line)) continue;                 // SRT cue index
    if (line.includes('-->')) continue;                // timing line
    if (/^(NOTE|Kind:|Language:)/i.test(line)) continue;
    const clean = line.replace(/<[^>]*>/g, '').trim(); // inline <c>/<00:00:00> tags
    if (clean) out.push(clean);
  }
  return dedupeConsecutive(out).join('\n');
}

// Auto-captions repeat each line as it "rolls up"; collapse adjacent dupes.
function dedupeConsecutive(lines) {
  const out = [];
  for (const l of lines) {
    if (out.length === 0 || out[out.length - 1] !== l) out.push(l);
  }
  return out;
}

module.exports = {
  extractYoutube: fetchTranscript,
  fetchTranscript,
  validateYoutubeUrl,
  resolveCookiesFile,
  classifyYtDlpError,
  parseSubtitles,
  ALLOWED_HOSTS,
};
