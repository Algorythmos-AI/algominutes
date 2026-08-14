'use strict';

// Speech-to-Text v2 wrapper. Calls batchRecognize with the `long` model
// + speaker diarization (min 1, max 8 — the model auto-determines the
// actual count) + word time offsets. Operations resolve via the polling
// task; we never block the request waiting for STT to finish.

let _client = null;
function getClient() {
  if (_client) return _client;
  const { v2 } = require('@google-cloud/speech');
  _client = new v2.SpeechClient();
  return _client;
}

function buildConfig({ recognizer, languageCodes, diarization = true }) {
  // Bug 18 (2026-05-08): the `long` model returns
  //   "3 INVALID_ARGUMENT: Diarization is not currently supported"
  // when `features.diarizationConfig` is set. STT v2 only supports
  // diarization on `chirp_2` (and only in some regions). Since we use
  // the system recognizer `projects/.../recognizers/_` which forces
  // `model=long`, we must omit diarizationConfig in that path or every
  // chunked-path note (>10min audio) fails with INVALID_ARGUMENT before
  // any transcript_lines are written. Bug 17 already documented that
  // the live corpus has speaker_tag = NULL across all rows, so removing
  // diarization here matches observed behavior — wordsToLines coalesces
  // null-tagged words into multi-word lines, and Bug 15 closure
  // (avg_text_len > 30) holds.
  //
  // To restore diarization in future: provision a custom recognizer
  // with `model=chirp_2` in a region that supports diarization, set
  // STT_RECOGNIZER to that path, and the `if (!isSystemRecognizer)`
  // branch below will add diarizationConfig back.
  //
  // Original Bug 15 lesson kept here for context: STT v2's
  // WordInfo.speaker_label populates only when diarizationConfig is
  // set AND the model supports it. With model=long, neither holds,
  // so we don't ask.
  //
  // Keep the explicit `diarization` flag for custom recognizers: if a
  // non-system recognizer unexpectedly rejects diarization, startLongRunning()
  // retries once without it instead of failing the note.
  const isSystemRecognizer = !recognizer || recognizer.endsWith('/_');
  const features = {
    enableAutomaticPunctuation: true,
    enableWordTimeOffsets: true,
  };
  if (diarization && !isSystemRecognizer) {
    features.diarizationConfig = {
      minSpeakerCount: 1,
      maxSpeakerCount: 8,
    };
  }

  const config = {
    autoDecodingConfig: {},
    features,
  };
  if (isSystemRecognizer) {
    config.model = 'long';
    config.languageCodes = languageCodes && languageCodes.length ? languageCodes : ['en-US'];
  }
  return config;
}

async function startLongRunning({ recognizer, gcsUri, languageCodes, log, client = getClient() }) {
  const request = buildBatchRecognizeRequest({ recognizer, gcsUri, languageCodes, diarization: true });
  try {
    const [operation] = await client.batchRecognize(request);
    return operation.name;
  } catch (err) {
    if (!isUnsupportedDiarizationError(err)) throw err;

    if (log) log.warn({ err, gcsUri }, 'stt_diarization_unsupported_retrying_without_it');
    const retryRequest = buildBatchRecognizeRequest({
      recognizer,
      gcsUri,
      languageCodes,
      diarization: false,
    });
    const [operation] = await client.batchRecognize(retryRequest);
    return operation.name;
  }
}

function buildBatchRecognizeRequest({ recognizer, gcsUri, languageCodes, diarization }) {
  const config = buildConfig({ recognizer, languageCodes, diarization });
  // STT v2 batchRecognize requires an explicit output destination —
  // either inline (response embedded in the operation) or GCS. Inline
  // is simpler and matches what flattenWords() expects below.
  return {
    recognizer: recognizer || defaultSystemRecognizer(),
    config,
    files: [{ uri: gcsUri }],
    recognitionOutputConfig: {
      inlineResponseConfig: {},
    },
  };
}

function defaultSystemRecognizer() {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT
    || process.env.GCLOUD_PROJECT
    || process.env.GCP_PROJECT
    || process.env.TASKS_PROJECT;
  return `projects/${projectId || '-'}/locations/global/recognizers/_`;
}

function isUnsupportedDiarizationError(err) {
  const haystack = [
    err && err.message,
    err && err.details,
    err && err.code,
  ].filter(Boolean).join(' ');
  return /unsupported fields|diarization/i.test(haystack)
    && /invalid[_ ]argument|3|unsupported fields/i.test(haystack);
}

async function checkOperation(operationName) {
  const client = getClient();
  // `checkBatchRecognizeProgress` returns a single LROperation instance,
  // NOT a tuple. The previous `const [op] = await ...` destructure threw
  // "(intermediate value) is not iterable" on every poll, exhausting
  // Cloud Tasks retries and stalling chunked notes in `transcribing`.
  // Use the underlying operationsClient.getOperation() for a stable
  // shape: it returns the standard gax tuple [op, request, options]
  // where `op` is the proto with done/error/response/metadata fields.
  const operationsClient = client.operationsClient;
  const [op] = await operationsClient.getOperation({ name: operationName });
  // Decode the embedded response when done — it's a google.protobuf.Any
  // wrapping a BatchRecognizeResponse. The gax client sets `op.response`
  // to a {type_url, value} pair; we deserialize via the operation's
  // descriptor on the speech client.
  let result = null;
  if (op.done && op.response && op.response.value) {
    try {
      const proto = require('@google-cloud/speech/build/protos/protos').google
        .cloud.speech.v2.BatchRecognizeResponse;
      result = proto.decode(op.response.value);
    } catch (decodeErr) {
      // Fall back to raw — flattenWords will get nothing and the chunk
      // ends up with 0 lines but the pipeline doesn't crash.
      result = null;
    }
  }
  return {
    done: op.done === true,
    error: op.error || null,
    result,
    metadata: op.metadata || null,
  };
}

// Flatten batchRecognize response into word objects ready for
// transcript_lines. Each word: { startMs, endMs, text, confidence,
// speakerTag }.
function flattenWords(result) {
  const out = [];
  if (!result || !result.results) return out;
  // result.results is keyed by file URI; we sent one file per chunk so
  // any value is fine.
  const fileResults = Object.values(result.results)[0];
  if (!fileResults || !fileResults.transcript || !fileResults.transcript.results) return out;
  for (const r of fileResults.transcript.results) {
    const alt = r.alternatives && r.alternatives[0];
    if (!alt || !alt.words) continue;
    for (const w of alt.words) {
      out.push({
        startMs: durToMs(w.startOffset),
        endMs: durToMs(w.endOffset),
        text: w.word || '',
        confidence: typeof w.confidence === 'number' ? w.confidence : null,
        speakerTag: typeof w.speakerLabel === 'string'
          ? Number(w.speakerLabel.replace(/[^0-9]/g, '')) || null
          : (w.speakerTag || null),
      });
    }
  }
  return out;
}

function durToMs(d) {
  if (!d) return 0;
  const sec = Number(d.seconds) || 0;
  const nanos = Number(d.nanos) || 0;
  return sec * 1000 + Math.floor(nanos / 1_000_000);
}

// Group consecutive same-speaker words into transcript lines.
// Each line gets startMs/endMs from the first/last word.
function wordsToLines(words) {
  if (!words.length) return [];
  const lines = [];
  let current = null;
  for (const w of words) {
    if (!current || current.speakerTag !== w.speakerTag || w.startMs - current.endMs > 1500) {
      if (current) lines.push(current);
      current = {
        speakerTag: w.speakerTag || 0,
        startMs: w.startMs,
        endMs: w.endMs,
        text: w.text,
        confidence: w.confidence,
      };
    } else {
      current.endMs = w.endMs;
      current.text = current.text + (current.text.endsWith(' ') ? '' : ' ') + w.text;
      if (Number.isFinite(w.confidence)) {
        current.confidence = current.confidence == null
          ? w.confidence
          : (current.confidence + w.confidence) / 2;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

module.exports = {
  startLongRunning,
  checkOperation,
  flattenWords,
  wordsToLines,
  buildConfig,
  buildBatchRecognizeRequest,
  defaultSystemRecognizer,
  isUnsupportedDiarizationError,
};
