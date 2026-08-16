'use strict';

// STT provider seam. One place decides which engine transcribes the long path,
// and returns a uniform provider handle so handler.js never branches on vendor
// names — only on `mode`. This is the seam DIARISATION-PLAN §5 calls for:
// "put the new engine behind the existing STT_*-style seam ... map to a neutral
// internal transcript shape ... so a swap between providers is a client change,
// not a pipeline change."
//
// STT_PROVIDER selects the engine:
//   - 'google'     (DEFAULT) → legacy per-chunk STT v2 path (services/.../stt.js),
//                    untouched. Kept as the shadow-eval baseline and the (a1)
//                    fallback until AssemblyAI clears the shadow eval and cutover.
//   - 'assemblyai' → whole-file async diarisation, PRIMARY post-cutover. mode:'poll'.
//   - 'deepgram'   → whole-file failover seam. mode:'inline' (synchronous API).
//
// Modes:
//   'chunked' → handler runs the legacy per-chunk pipeline (google).
//   'poll'    → handler uploads/submits once, then polls a job id to completion.
//   'inline'  → handler transcribes synchronously while audio is local, no poll.
//
// Whole-file providers give GLOBALLY-consistent speaker tags in one pass, which
// is why the chunk-boundary speaker problem disappears (plan §3). The Gemini
// fast-path for short clips is NOT routed through here and stays untouched.

const assemblyai = require('./providers/assemblyai');
const deepgram = require('./providers/deepgram');

const GOOGLE = 'google';
const ASSEMBLYAI = 'assemblyai';
const DEEPGRAM = 'deepgram';

function providerName(env) {
  const raw = ((env && env.STT_PROVIDER) || GOOGLE).trim().toLowerCase();
  if (raw === ASSEMBLYAI || raw === DEEPGRAM || raw === GOOGLE) return raw;
  // Unknown value fails safe to the legacy Google path rather than silently
  // sending audio to a vendor the operator did not name.
  return GOOGLE;
}

// Returns a provider handle, or null for 'google' (handler uses the legacy
// chunked path + the existing `stt` module in that case).
function getProvider(env, { fetchImpl } = {}) {
  const name = providerName(env);
  if (name === GOOGLE) return null;

  if (name === ASSEMBLYAI) {
    const apiKey = env && env.ASSEMBLYAI_API_KEY;
    return {
      name: ASSEMBLYAI,
      mode: 'poll',
      async submit({ audioPath, audioUrl, languageCodes, log }) {
        return assemblyai.submit({ audioPath, audioUrl, apiKey, env, languageCodes, fetchImpl, log });
      },
      async poll({ jobId, log }) {
        return assemblyai.poll({ jobId, apiKey, env, fetchImpl, log });
      },
      async deleteRemote({ jobId, log }) {
        return assemblyai.deleteRemote({ jobId, apiKey, env, fetchImpl, log });
      },
    };
  }

  // deepgram
  const apiKey = env && env.DEEPGRAM_API_KEY;
  return {
    name: DEEPGRAM,
    mode: 'inline',
    async transcribeInline({ audioPath, audioUrl, languageCodes, contentType, log }) {
      return deepgram.transcribeInline({ audioPath, audioUrl, apiKey, env, languageCodes, contentType, fetchImpl, log });
    },
  };
}

// The stt_operation_id column stores a whole-file provider's job id prefixed
// with the provider name (`assemblyai:<id>`) so a later poll routes to the right
// provider even if STT_PROVIDER changed between submit and poll. Google's opaque
// LRO names have no prefix and are handled by the legacy path.
function encodeOperationId(name, jobId) {
  return `${name}:${jobId}`;
}

function decodeOperationId(stored) {
  if (typeof stored !== 'string') return { provider: null, jobId: stored };
  const i = stored.indexOf(':');
  if (i <= 0) return { provider: null, jobId: stored };
  const provider = stored.slice(0, i);
  if (provider === ASSEMBLYAI || provider === DEEPGRAM) {
    return { provider, jobId: stored.slice(i + 1) };
  }
  return { provider: null, jobId: stored };
}

module.exports = {
  getProvider,
  providerName,
  encodeOperationId,
  decodeOperationId,
  GOOGLE,
  ASSEMBLYAI,
  DEEPGRAM,
};
