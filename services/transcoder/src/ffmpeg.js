'use strict';

// Thin ffmpeg/ffprobe wrappers. Probes duration; transcodes input to
// mono 16 kHz FLAC; produces N chunk files with 30s overlap.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function runChild(cmd, args, { stdoutSink } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => {
      const s = b.toString();
      if (stdoutSink) stdoutSink(s);
      else stdout += s;
    });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error(`${cmd} exited ${code}: ${stderr.slice(0, 500)}`);
        err.code = code;
        reject(err);
      }
    });
  });
}

async function probeDuration(localPath) {
  let ffprobeError = null;
  let fallbackError = null;

  try {
    const { stdout } = await runChild('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      localPath,
    ]);
    const dur = Number(String(stdout).trim());
    if (Number.isFinite(dur) && dur > 0) {
      return dur;
    }
  } catch (err) {
    ffprobeError = err;
  }

  // Fallback for WebM (MediaRecorder) files without duration header:
  // Decode the audio quickly and parse the final time=00:00:00.00
  try {
    const { stderr } = await runChild('ffmpeg', ['-i', localPath, '-f', 'null', '-']);
    // Look for the last 'time=XX:XX:XX.XX' in stderr
    const matches = [...stderr.matchAll(/time=(\d{2,}):(\d{2}):(\d{2}\.\d+)/g)];
    if (matches.length > 0) {
      const lastMatch = matches[matches.length - 1];
      const h = Number(lastMatch[1]);
      const m = Number(lastMatch[2]);
      const s = Number(lastMatch[3]);
      const dur = h * 3600 + m * 60 + s;
      if (Number.isFinite(dur) && dur > 0) {
        return dur;
      }
    }
  } catch (err) {
    fallbackError = err;
  }

  const err = new Error(`could not determine duration for ${localPath}`);
  err.cause = fallbackError || ffprobeError;
  throw err;
}

async function transcodeToFlac(inputPath, outputPath) {
  await runChild('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'flac',
    outputPath,
  ]);
  return outputPath;
}

async function extractChunk({ inputPath, startSec, endSec, outputPath }) {
  const duration = endSec - startSec;
  await runChild('ffmpeg', [
    '-y',
    '-ss', String(startSec),
    '-t', String(duration),
    '-i', inputPath,
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'flac',
    outputPath,
  ]);
  return outputPath;
}

function ensureTempDir(noteId) {
  const dir = path.join('/tmp', `wassup-${noteId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTempDir(noteId) {
  const dir = path.join('/tmp', `wassup-${noteId}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  probeDuration,
  transcodeToFlac,
  extractChunk,
  ensureTempDir,
  cleanupTempDir,
};
