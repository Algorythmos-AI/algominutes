'use strict';

// AssemblyAI whole-file transcription provider (PRIMARY engine).
//
// One async job transcribes a multi-hour recording and returns text + word
// timings + GLOBAL speaker diarisation — the exact combination Google STT v1
// gives only expensively and Chirp 3 cannot give at all (DIARISATION-PLAN §1,§5).
//
// Flow (submit → poll, to fit the transcoder's existing Cloud-Task poll loop):
//   submit(): upload the local audio bytes to /v2/upload, then POST /v2/transcript
//             with speaker_labels — returns a transcript id.
//   poll():   GET /v2/transcript/{id}; when status=completed, map utterances to
//             neutral lines. When status=error, surface a terminal error.
//   deleteRemote(): DELETE /v2/transcript/{id} once the transcript is safely in
//             Postgres, so audio/text does not linger on the vendor beyond need.
//
// RESIDENCY / RETENTION (see docs/DECISIONS.md "Diarisation" + docs/BLOCKERS.md):
//   Audio is processed in the US. AssemblyAI's async default deletes audio after
//   72h (TTL configurable to 1h) BUT trains on customer data BY DEFAULT — opt-out
//   is account-level and requires a PAID plan (free tier cannot opt out). Two
//   defences are wired here: (1) we request deletion of each transcript right
//   after persisting it (deleteRemote), and (2) the account-level model-training
//   opt-out + executed DPA are hard preconditions tracked in BLOCKERS. Do not
//   point ASSEMBLYAI_API_KEY at a free-tier key.

const fs = require('node:fs');
const { Readable } = require('node:stream');

const { speakerLabelToTag, wordsToLines } = require('./neutral');

const NAME = 'assemblyai';
const DEFAULT_BASE = 'https://api.assemblyai.com/v2';

function baseUrl(env) {
  // EU endpoint (Dublin) exists if residency ever needs to move off US; US is
  // the decided default. Kept as a seam, not a runtime toggle we advertise.
  return (env && env.ASSEMBLYAI_BASE_URL) || DEFAULT_BASE;
}

// AssemblyAI expects a single BCP-47-ish language_code. When we carry several
// candidate codes (en-US,en-GB,en-AU) we cannot pick one, so let the engine
// auto-detect rather than forcing en-US onto en-AU audio.
function languageParams(languageCodes) {
  const codes = (languageCodes || []).filter(Boolean);
  if (codes.length === 1) return { language_code: codes[0] };
  return { language_detection: true };
}

async function uploadAudio({ audioPath, apiKey, env, fetchImpl, log }) {
  const doFetch = fetchImpl || globalThis.fetch;
  // Stream the file rather than reading multi-hour audio fully into memory.
  const nodeStream = fs.createReadStream(audioPath);
  const body = Readable.toWeb(nodeStream);
  const res = await doFetch(`${baseUrl(env)}/upload`, {
    method: 'POST',
    headers: { authorization: apiKey, 'content-type': 'application/octet-stream' },
    body,
    duplex: 'half',
  });
  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(`assemblyai_upload_failed status=${res.status} ${detail}`);
  }
  const json = await res.json();
  if (!json || !json.upload_url) throw new Error('assemblyai_upload_no_url');
  if (log) log.info({ provider: NAME }, 'assemblyai_upload_ok');
  return json.upload_url;
}

// Returns a bare transcript id. The handler stores it prefixed as
// `assemblyai:<id>` so a later poll routes to this provider without re-reading
// env (defends against STT_PROVIDER changing mid-flight).
async function submit({ audioPath, audioUrl, apiKey, env, languageCodes, fetchImpl, log }) {
  if (!apiKey) throw new Error('assemblyai_api_key_missing');
  const doFetch = fetchImpl || globalThis.fetch;
  const uploadUrl = audioUrl || await uploadAudio({ audioPath, apiKey, env, fetchImpl, log });

  const reqBody = {
    audio_url: uploadUrl,
    speaker_labels: true, // whole-file, globally-consistent diarisation
    punctuate: true,
    format_text: true,
    ...languageParams(languageCodes),
  };
  const res = await doFetch(`${baseUrl(env)}/transcript`, {
    method: 'POST',
    headers: { authorization: apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(reqBody),
  });
  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(`assemblyai_submit_failed status=${res.status} ${detail}`);
  }
  const json = await res.json();
  if (!json || !json.id) throw new Error('assemblyai_submit_no_id');
  if (log) log.info({ provider: NAME, jobId: json.id, status: json.status }, 'assemblyai_submitted');
  return json.id;
}

// Poll one transcript. Returns { done, error, lines }.
//   - queued/processing → { done:false }
//   - completed         → { done:true, lines:[neutral] }
//   - error             → { done:true, error }
async function poll({ jobId, apiKey, env, fetchImpl, log }) {
  if (!apiKey) throw new Error('assemblyai_api_key_missing');
  const doFetch = fetchImpl || globalThis.fetch;
  const res = await doFetch(`${baseUrl(env)}/transcript/${encodeURIComponent(jobId)}`, {
    headers: { authorization: apiKey },
  });
  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(`assemblyai_poll_failed status=${res.status} ${detail}`);
  }
  const json = await res.json();
  const status = json && json.status;
  if (status === 'error') {
    return { done: true, error: new Error(`assemblyai_transcript_error: ${json.error || 'unknown'}`), lines: [] };
  }
  if (status !== 'completed') {
    if (log) log.info({ provider: NAME, jobId, status }, 'assemblyai_poll_pending');
    return { done: false, error: null, lines: [] };
  }
  return { done: true, error: null, lines: mapCompleted(json) };
}

// Map a completed AssemblyAI response to neutral lines. AssemblyAI start/end are
// in MILLISECONDS already, so no unit conversion. Prefer `utterances` (already
// speaker-grouped turns) — they are the cleanest, boundary-correct source. Fall
// back to grouping `words` ourselves only if utterances are absent.
function mapCompleted(json) {
  if (Array.isArray(json.utterances) && json.utterances.length) {
    return json.utterances.map((u) => ({
      speakerTag: speakerLabelToTag(u.speaker),
      startMs: Number(u.start) || 0,
      endMs: Number(u.end) || 0,
      text: (u.text || '').trim(),
      confidence: typeof u.confidence === 'number' ? u.confidence : null,
    })).filter((l) => l.text.length > 0);
  }
  const words = Array.isArray(json.words) ? json.words.map((w) => ({
    speakerTag: speakerLabelToTag(w.speaker),
    startMs: Number(w.start) || 0,
    endMs: Number(w.end) || 0,
    text: w.text || '',
    confidence: typeof w.confidence === 'number' ? w.confidence : null,
  })) : [];
  return wordsToLines(words);
}

// Best-effort deletion of the remote transcript+audio after we have persisted
// it. Never throws — the transcript is already safe in Postgres by the time
// this runs, and the vendor's own TTL is the backstop. Mirrors the GCS
// deletePrefix contract in storage.js.
async function deleteRemote({ jobId, apiKey, env, fetchImpl, log }) {
  try {
    if (!apiKey || !jobId) return false;
    const doFetch = fetchImpl || globalThis.fetch;
    const res = await doFetch(`${baseUrl(env)}/transcript/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
      headers: { authorization: apiKey },
    });
    if (log) log.info({ provider: NAME, jobId, status: res.status }, 'assemblyai_transcript_deleted');
    return res.ok;
  } catch (err) {
    if (log) log.error({ err: { message: err && err.message }, jobId }, 'assemblyai_transcript_delete_failed');
    return false;
  }
}

async function safeText(res) {
  try { return (await res.text()).slice(0, 300); }
  // The reason travels in the error text this feeds (no logger in scope).
  catch (err) { return `<body unreadable: ${err.message}>`; }
}

module.exports = { NAME, submit, poll, deleteRemote, mapCompleted, languageParams, uploadAudio };
