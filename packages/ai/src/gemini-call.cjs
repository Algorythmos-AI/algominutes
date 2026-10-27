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
const { vertexRefusal } = require('./vertex-refusal.cjs');
const { activeLadder, thinkingConfigFor } = require('./models.cjs');

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

// A quota refusal (429 RESOURCE_EXHAUSTED) is Vertex's shared capacity saying "not now", not an outage. Asked
// again 2–4 s later it refused again for minutes (production, 2026-10-27: four task attempts, 19 minutes for a
// 23 s note). So it gets more attempts on the rung, further apart: 2, 4, 8, 16 s plus up to 1 s of jitter, about
// 30 s in all, and never past the ladder's budget. Other transient errors keep 3 quick attempts.
const ATTEMPTS = 3;
const RATE_LIMITED_ATTEMPTS = 5;
const isRateLimited = (err) => /\b429\b|RESOURCE_EXHAUSTED/.test((err && err.message) || '');
const rateLimitBackoffMs = (attempt) => Math.min(2_000 * 2 ** attempt, 16_000) + Math.floor(Math.random() * 1_000);

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
  // How long one attempt may take before it's cut and asked again (plan rev 12 S3). Unset, an attempt may use
  // the whole remaining budget, as before: the summarizer, whose long transcripts take long, leaves it unset.
  // A hung call on a short clip used to spend the whole 240 s budget and fail the task (BLOCKERS 2026-10-06).
  attemptTimeoutMs,
  log,
  modelLadder,                   // default: models.cjs activeLadder(), evaluated per call
  generationConfig,
  // Cap the model's thinking: { budget, level } (models.cjs thinkingConfigFor picks the field each rung takes).
  // Pass this, not a thinkingConfig in generationConfig: one fixed field is refused by one rung or the other.
  thinking,
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
  // Built per rung: the thinking cap's field differs by model family.
  const bodyFor = (modelName, withThinking) => ({
    contents,
    generationConfig: thinking && withThinking ? { ...config, thinkingConfig: thinkingConfigFor(modelName, thinking) } : config,
  });

  let lastErr = null;
  for (const modelName of ladder) {
    const url = `https://${loc}-aiplatform.googleapis.com/v1/projects/${proj}/locations/${loc}/publishers/google/models/${modelName}:generateContent`;
    // Dropped for this rung if Vertex refuses the cap itself: an answer with uncapped thinking beats no answer.
    let withThinking = true;
    let attempts = ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (Date.now() > deadline) {
        lastErr = new Error('TIME_BUDGET');
        return { rawText: null, model: null, error: lastErr };
      }
      const startMs = Date.now();
      // This attempt's own cap, when it's tighter than what's left of the budget: then a timeout is this
      // attempt's, and another one fits.
      const leftMs = Math.max(1, deadline - startMs);
      const cutByAttempt = Number.isFinite(attemptTimeoutMs) && attemptTimeoutMs > 0 && attemptTimeoutMs < leftMs;
      const attemptMs = cutByAttempt ? attemptTimeoutMs : leftMs;
      try {
        const token = await getToken();
        if (!token) throw new Error('callGeminiWithLadder: failed to mint ADC token');

        // The budget was only checked between attempts, so one hung call could
        // hold a worker until Cloud Run's request timeout. Each attempt is now
        // aborted when the ladder's budget runs out; the signal also covers
        // reading the body.
        const resp = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(bodyFor(modelName, withThinking)),
          signal: AbortSignal.timeout(attemptMs),
        });

        if (!resp.ok) {
          const errText = await resp.text().catch((err) => {
            log.warn({ err, model: modelName }, 'gemini_error_body_unreadable');
            return '';
          });
          if (isModelUnavailable(resp.status)) {
            lastErr = vertexRefusal('Vertex Gemini', resp.status, errText);
            log.warn({ err: lastErr, model: modelName, location: loc }, 'gemini_model_unavailable');
            break; // next rung; retrying the same model can't help
          }
          // A 400 while a thinking cap was sent: Vertex's backends don't agree on which field a model takes
          // (2026-10-01). Ask once more without the cap, on the same rung, without spending an attempt's backoff.
          if (resp.status === 400 && thinking && withThinking) {
            withThinking = false;
            log.warn({ err: vertexRefusal('Vertex Gemini', resp.status, errText), model: modelName }, 'gemini_thinking_cap_refused');
            attempt -= 1;
            continue;
          }
          // Match the existing isTransientError fingerprint by mapping
          // HTTP status to a synthetic message — we already detect 503,
          // 429, etc. via that helper.
          throw vertexRefusal('Vertex Gemini', resp.status, errText);
        }

        // A body that isn't JSON would throw a SyntaxError quoting its first characters: say so without them.
        const data = await resp.json().catch((err) => {
          if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw err;
          throw new Error(`Vertex Gemini ${resp.status} unparseable body`);
        });
        const rawText = extractText(data);
        const finishReason = (data && data.candidates && data.candidates[0] && data.candidates[0].finishReason) || null;
        if (!rawText || !rawText.trim() || rawText.trim() === '{}') {
          throw new Error('Empty Gemini response');
        }
        // What the answer used: a truncation's cause (thinking that ate the budget, or a long answer) is in these.
        const usage = (data && data.usageMetadata) || {};
        const tokens = {
          promptTokens: usage.promptTokenCount ?? null,
          outputTokens: usage.candidatesTokenCount ?? null,
          thoughtsTokens: usage.thoughtsTokenCount ?? null,
        };
        // MAX_TOKENS means structured output was cut off (thinking tokens count
        // toward maxOutputTokens). Callers salvage what they can; make it visible.
        if (finishReason === 'MAX_TOKENS') {
          log.warn({ model: modelName, finishReason, ...tokens }, 'gemini_output_truncated');
        }
        log.info({ model: modelName, attempt: attempt + 1, latencyMs: Date.now() - startMs, finishReason, ...tokens }, 'gemini_ok');
        return { rawText, model: modelName, finishReason, error: null };
      } catch (err) {
        if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
          // Cut at this attempt's own cap, with budget left: ask again, as for a transient error (no backoff:
          // the wait was the hang itself). The next attempt, or the next rung, gets what's left.
          if (cutByAttempt && Date.now() < deadline) {
            // Named TIME_BUDGET too: if every attempt is cut, the caller sees the same "took too long" as a
            // budget that ran out (intelligence.cjs publicErrorFor matches /TIME_BUDGET/).
            lastErr = new Error('TIME_BUDGET (attempt cut at its cap)');
            log.warn({ model: modelName, attempt: attempt + 1, latencyMs: Date.now() - startMs, attemptTimeoutMs }, 'gemini_attempt_timeout');
            continue;
          }
          // Out of budget mid-call: the same outcome as running out between
          // attempts. The caller fails the task and Cloud Tasks retries it.
          log.warn({ model: modelName, attempt: attempt + 1, latencyMs: Date.now() - startMs }, 'gemini_timeout');
          return { rawText: null, model: null, error: new Error('TIME_BUDGET') };
        }
        lastErr = err;
        if (!isTransientError(err)) {
          log.error({ err, model: modelName }, 'gemini_non_retryable');
          return { rawText: null, model: null, error: err };
        }
        const rateLimited = isRateLimited(err);
        if (rateLimited) attempts = RATE_LIMITED_ATTEMPTS;
        const backoff = rateLimited ? rateLimitBackoffMs(attempt) : backoffMs(attempt);
        log.warn({ err, model: modelName, attempt: attempt + 1, backoff }, 'gemini_transient');
        // A quota refusal, told apart from an outage (503): the case for more quota or provisioned throughput
        // (plan rev 12 S2). It's still a gemini_transient, retried with the longer backoff above.
        if (rateLimited) {
          log.warn({ model: modelName, attempt: attempt + 1, location: loc }, 'gemini_rate_limited');
        }
        if (attempt + 1 >= attempts) break;
        // A wait that would end past the budget can't be followed by an attempt: the next rung gets what's left.
        if (Date.now() + backoff > deadline) break;
        await sleepFn(backoff);
      }
    }
    log.warn({ model: modelName }, 'gemini_model_exhausted');
  }
  return { rawText: null, model: null, error: lastErr || new Error('All Gemini models overloaded') };
}

module.exports = { callGeminiWithLadder };
