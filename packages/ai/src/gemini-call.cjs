'use strict';

// Gemini model-ladder call with deadline + transient retry.
// Reused by the transcoder fast path and the summarizer Cloud Run service.
//
// Calls the **Vertex AI** Gemini endpoint, not the public Generative
// Language API. The summarizer's failure to reach
// `generativelanguage.googleapis.com` from a Cloud Run revision (Phase 3
// audit bug 13) was the same root cause as bug 11 (embedder model 404):
// the public endpoint isn't reliably reachable through this VPC, but
// `*-aiplatform.googleapis.com` is. ADC from the bound service account
// (`algominutes-jobs-sa`) authenticates; no API key needed. The function's
// signature stays the same as the old @google/generative-ai version so
// callers don't change — `apiKey` is now ignored.

const { RETRY_DEADLINE_MS, isTransientError, sleep, backoffMs } = require('./intelligence.cjs');
const { activeLadder } = require('./models.cjs');

let _authClient = null;
let _projectId = null;

async function ensureAuth() {
  if (_authClient && _projectId) return { client: _authClient, projectId: _projectId };
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  _authClient = await auth.getClient();
  _projectId =
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    (await auth.getProjectId());
  return { client: _authClient, projectId: _projectId };
}

// A 404 from the model endpoint means this model is not served here: retired,
// or not available in this region. Another rung may be, so it isn't fatal to the
// ladder (previously it was: the call returned on the first 404, so a retired
// rung silently turned the ladder into a single model).
function isModelUnavailable(status) {
  return status === 404;
}

function extractText(data) {
  // Vertex AI generateContent returns:
  //   { candidates: [ { content: { parts: [{ text }] }, finishReason } ] }
  // Concatenate all text parts of the first candidate; later candidates
  // are alternatives we don't ask for.
  if (!data || !Array.isArray(data.candidates) || data.candidates.length === 0) return '';
  const c = data.candidates[0];
  if (!c.content || !Array.isArray(c.content.parts)) return '';
  return c.content.parts.map((p) => (p && p.text) || '').join('');
}

async function callGeminiWithLadder({
  apiKey: _ignoredApiKey,        // legacy compat; ADC is used now
  parts,
  deadlineMs = RETRY_DEADLINE_MS,
  log,
  modelLadder,                   // default: models.cjs activeLadder(), evaluated per call
  generationConfig,
  project,
  location,
  // Injection points for tests; production uses ADC, global fetch and real sleeps.
  tokenProvider,
  fetchImpl = globalThis.fetch,
  sleepFn = sleep,
}) {
  const ladder = modelLadder || activeLadder();
  let proj = project;
  let getToken = tokenProvider;
  if (!proj || !getToken) {
    const { client, projectId } = await ensureAuth();
    proj = proj || projectId;
    getToken = getToken || (async () => {
      const tokenResp = await client.getAccessToken();
      return tokenResp && tokenResp.token;
    });
  }
  const loc = location || process.env.AIPLATFORM_LOCATION || 'us-central1';
  if (!proj) {
    return { rawText: null, model: null, error: new Error('callGeminiWithLadder: project not resolvable') };
  }

  const config = generationConfig || { responseMimeType: 'application/json' };
  const deadline = Date.now() + deadlineMs;

  // The shared module's callers pass `parts` as either an array of
  // {text} / {inlineData} entries (legacy SDK shape). Vertex's REST API
  // expects them under `contents[0].parts`, with `role: 'user'`.
  const contents = [{ role: 'user', parts }];
  const body = { contents, generationConfig: config };

  let lastErr = null;
  for (const modelName of ladder) {
    const url = `https://${loc}-aiplatform.googleapis.com/v1/projects/${proj}/locations/${loc}/publishers/google/models/${modelName}:generateContent`;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (Date.now() > deadline) {
        lastErr = new Error('TIME_BUDGET');
        return { rawText: null, model: null, error: lastErr };
      }
      const startMs = Date.now();
      try {
        const token = await getToken();
        if (!token) throw new Error('callGeminiWithLadder: failed to mint ADC token');

        const resp = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          if (isModelUnavailable(resp.status)) {
            lastErr = new Error(`Vertex Gemini ${resp.status}: ${errText.slice(0, 300)}`);
            log.warn({ err: lastErr, model: modelName, location: loc }, 'gemini_model_unavailable');
            break; // next rung; retrying the same model can't help
          }
          // Match the existing isTransientError fingerprint by mapping
          // HTTP status to a synthetic message — we already detect 503,
          // 429, etc. via that helper.
          const synthetic = new Error(`Vertex Gemini ${resp.status}: ${errText.slice(0, 300)}`);
          throw synthetic;
        }

        const data = await resp.json();
        const rawText = extractText(data);
        const finishReason = (data && data.candidates && data.candidates[0] && data.candidates[0].finishReason) || null;
        if (!rawText || !rawText.trim() || rawText.trim() === '{}') {
          throw new Error('Empty Gemini response');
        }
        // MAX_TOKENS means structured output was cut off (thinking tokens count
        // toward maxOutputTokens). Callers salvage what they can; make it visible.
        if (finishReason === 'MAX_TOKENS') {
          log.warn({ model: modelName, finishReason }, 'gemini_output_truncated');
        }
        log.info({ model: modelName, attempt: attempt + 1, latencyMs: Date.now() - startMs, finishReason }, 'gemini_ok');
        return { rawText, model: modelName, finishReason, error: null };
      } catch (err) {
        lastErr = err;
        if (!isTransientError(err)) {
          log.error({ err, model: modelName }, 'gemini_non_retryable');
          return { rawText: null, model: null, error: err };
        }
        const backoff = backoffMs(attempt);
        log.warn({ err, model: modelName, attempt: attempt + 1, backoff }, 'gemini_transient');
        await sleepFn(backoff);
      }
    }
    log.warn({ model: modelName }, 'gemini_model_exhausted');
  }
  return { rawText: null, model: null, error: lastErr || new Error('All Gemini models overloaded') };
}

module.exports = { callGeminiWithLadder };
