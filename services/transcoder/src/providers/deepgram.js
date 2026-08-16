'use strict';

// Deepgram whole-file transcription provider (FAILOVER SEAM).
//
// ⚠️ COST: at ~A$0.0096/min Deepgram runs ~A$14.40 for a 1,500-min Pro cap,
// which EXCEEDS Pro net revenue (~A$12.75). Only AssemblyAI survives at the cap
// (docs/DECISIONS.md "Diarisation"). Deepgram exists so a provider swap is a
// client change, not a pipeline change — it is not the default and must not be
// switched on for the Pro tier without a pricing change.
//
// Deepgram's prerecorded API is SYNCHRONOUS: the transcription result is
// returned inline in the POST response, there is no job id to poll. So this
// provider declares mode:'inline' and exposes transcribeInline(), which the
// handler runs during kickoff while the audio is still on local disk. Its
// output is the same neutral line shape AssemblyAI produces, so everything
// downstream is provider-agnostic.
//
// RESIDENCY / RETENTION: US processing. We set mip_opt_out=true on every request
// so Deepgram excludes it from the Model Improvement Program; opted-out data is
// "retained only for the duration necessary to process the request" (Deepgram
// MIP docs). An EU endpoint (api.eu.deepgram.com) exists as a residency seam.

const fs = require('node:fs');
const { Readable } = require('node:stream');

const { speakerLabelToTag, wordsToLines, secToMs } = require('./neutral');

const NAME = 'deepgram';
const MODE = 'inline';
const DEFAULT_BASE = 'https://api.deepgram.com/v1';

function baseUrl(env) {
  return (env && env.DEEPGRAM_BASE_URL) || DEFAULT_BASE;
}

function buildQuery({ languageCodes, env }) {
  const params = new URLSearchParams();
  params.set('model', (env && env.DEEPGRAM_MODEL) || 'nova-3');
  params.set('diarize', 'true'); // whole-file, globally-consistent speaker tags
  params.set('punctuate', 'true');
  params.set('utterances', 'true'); // speaker-grouped turns → clean line boundaries
  params.set('smart_format', 'true');
  // Exclude from model training (opt-out ⇒ process-then-delete). Non-negotiable
  // for the residency posture — see header + DECISIONS.
  params.set('mip_opt_out', 'true');
  const codes = (languageCodes || []).filter(Boolean);
  if (codes.length === 1) params.set('language', codes[0]);
  else params.set('detect_language', 'true');
  return params.toString();
}

// Transcribe a whole local file synchronously and return neutral lines.
// Deepgram accepts raw audio bytes in the request body; we stream the file so a
// multi-hour recording never lands fully in memory.
async function transcribeInline({ audioPath, audioUrl, apiKey, env, languageCodes, contentType, fetchImpl, log }) {
  if (!apiKey) throw new Error('deepgram_api_key_missing');
  const doFetch = fetchImpl || globalThis.fetch;
  const url = `${baseUrl(env)}/listen?${buildQuery({ languageCodes, env })}`;

  let fetchOpts;
  if (audioUrl) {
    fetchOpts = {
      method: 'POST',
      headers: { authorization: `Token ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url: audioUrl }),
    };
  } else {
    const nodeStream = fs.createReadStream(audioPath);
    fetchOpts = {
      method: 'POST',
      headers: {
        authorization: `Token ${apiKey}`,
        'content-type': contentType || 'audio/flac',
      },
      body: Readable.toWeb(nodeStream),
      duplex: 'half',
    };
  }

  const res = await doFetch(url, fetchOpts);
  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(`deepgram_listen_failed status=${res.status} ${detail}`);
  }
  const json = await res.json();
  const lines = mapResponse(json);
  if (log) log.info({ provider: NAME, lines: lines.length }, 'deepgram_transcribed');
  return lines;
}

// Map a Deepgram prerecorded response to neutral lines. Deepgram start/end are
// in SECONDS. Prefer results.utterances (already speaker-grouped); fall back to
// grouping the diarised words in channels[0].alternatives[0].
function mapResponse(json) {
  const results = json && json.results;
  if (!results) return [];
  if (Array.isArray(results.utterances) && results.utterances.length) {
    return results.utterances.map((u) => ({
      speakerTag: speakerLabelToTag(u.speaker),
      startMs: secToMs(u.start),
      endMs: secToMs(u.end),
      text: (u.transcript || '').trim(),
      confidence: typeof u.confidence === 'number' ? u.confidence : null,
    })).filter((l) => l.text.length > 0);
  }
  const alt = results.channels
    && results.channels[0]
    && results.channels[0].alternatives
    && results.channels[0].alternatives[0];
  const words = alt && Array.isArray(alt.words) ? alt.words.map((w) => ({
    speakerTag: speakerLabelToTag(w.speaker),
    startMs: secToMs(w.start),
    endMs: secToMs(w.end),
    text: w.punctuated_word || w.word || '',
    confidence: typeof w.confidence === 'number' ? w.confidence : null,
  })) : [];
  return wordsToLines(words);
}

async function safeText(res) {
  try { return (await res.text()).slice(0, 300); }
  catch { return ''; }
}

module.exports = { NAME, MODE, transcribeInline, mapResponse, buildQuery };
