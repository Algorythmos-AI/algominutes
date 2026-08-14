'use strict';

// Pure routing: duration → fast vs chunked. Pulled out so the
// transcoder-routing test suite can verify the threshold without
// booting ffprobe.

const FAST_PATH_MAX_SEC = 600;

function routeForDuration(durationSec) {
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    return 'fast';
  }
  return durationSec <= FAST_PATH_MAX_SEC ? 'fast' : 'chunked';
}

// 10-minute chunks with 30s overlap on each side. The overlap is the
// raw material the dedup module uses to stitch chunk boundaries.
function planChunks(durationSec, chunkSec = FAST_PATH_MAX_SEC, overlapSec = 30) {
  const chunks = [];
  let idx = 0;
  let start = 0;
  while (start < durationSec) {
    const end = Math.min(start + chunkSec + overlapSec, durationSec);
    chunks.push({ idx, startSec: start, endSec: end });
    start += chunkSec;
    idx += 1;
  }
  return chunks;
}

module.exports = { routeForDuration, planChunks, FAST_PATH_MAX_SEC };
