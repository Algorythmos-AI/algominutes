// POST /v1/process-audio — synchronous transcribe + summarize.
//
// Ported from server.ts's /api/process-audio route (BUILD-PLAN §3.1: mount
// server.ts's existing routes into the one API service). Behaviour is
// preserved exactly; the ONLY structural change is that token verification is
// no longer inline — the shared auth middleware runs first and this handler
// reads `req.uid`. Shared helpers are imported from the workspace packages
// (@algominutes/ai intelligence + redaction, @algominutes/db notes-repo)
// instead of the repo-relative shims the source used.

import { GoogleGenAI } from '@google/genai';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

import intelligenceModule from '@algominutes/ai/intelligence.cjs';
import redactionModule from '@algominutes/ai/redaction.cjs';
import { markReady, markError } from '@algominutes/db/notes-repo';

const {
  MAX_AUDIO_BYTES,
  RETRY_DEADLINE_MS,
  MODEL_LADDER,
  resolveGeminiAudioMime,
  isValidId,
  publicErrorFor,
  isTransientError,
  buildPromptText,
  parseGeminiJson,
  sleep,
  backoffMs,
  enforceUsageBudget,
} = intelligenceModule;
const { redactTranscriptLines, redactSummaryOutput } = redactionModule;

// Lazy singletons. getFirestore() / getStorage() return process-wide instances
// once firebase-admin is initialized; the Gemini client is built once from the
// env key (absent key mirrors server.ts: a warn at first use, not a crash).
let _ai;
function getAi(log) {
  if (_ai !== undefined) return _ai;
  if (!process.env.GEMINI_API_KEY) {
    log.warn({}, 'gemini_api_key_missing');
    _ai = null;
  } else {
    _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return _ai;
}

let _bucket;
function getBucket(log) {
  if (_bucket !== undefined) return _bucket;
  try {
    _bucket = getStorage().bucket();
  } catch (err) {
    log.warn({ err }, 'storage_bucket_unavailable');
    _bucket = undefined;
  }
  return _bucket;
}

export async function processAudioRoute(req, res) {
  const log = req.log;
  // Auth is handled by the shared auth middleware; the verified uid is here.
  const callerUid = req.uid;

  // ── Validate body ───────────────────────────────────────────────
  const { noteId, workspaceId, type, storagePath, content, mimeType: clientMime } = req.body || {};
  if (!isValidId(noteId) || !isValidId(workspaceId) || !type) {
    return res.status(400).json({ error: 'Missing or invalid required fields' });
  }
  if (workspaceId !== `workspace_${callerUid}`) {
    return res.status(403).json({ error: 'Workspace mismatch' });
  }
  if (storagePath !== undefined) {
    if (
      typeof storagePath !== 'string' ||
      !storagePath.startsWith(`recordings/${workspaceId}/`) ||
      storagePath.includes('..') ||
      storagePath.length > 512
    ) {
      return res.status(400).json({ error: 'Invalid storagePath' });
    }
  }

  const reqLog = log.child({ uid: callerUid, noteId, workspaceId, source: type });
  const firestore = getFirestore();
  const storageBucket = getBucket(reqLog);
  const noteRef = firestore.doc(`workspaces/${workspaceId}/notes/${noteId}`);

  // ── Idempotency & ownership (cheap; do before rate limit so a
  //    403 doesn't burn a token) ────────────────────────────────
  let probedSize = 0;
  try {
    const snap = await noteRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Note not found' });
    const note = snap.data();
    if (!note || note.authorId !== callerUid) return res.status(403).json({ error: 'Not your note' });
    if (note.status === 'ready') return res.json({ success: true, noteId, cached: true });
  } catch (err) {
    reqLog.error({ err }, 'ownership_check_failed');
    return res.status(500).json({ error: 'Ownership check failed' });
  }

  // ── Probe audio size (drives bytes budget) ────────────────
  if (storagePath && storageBucket) {
    try {
      const file = storageBucket.file(storagePath);
      const [metadata] = await file.getMetadata();
      probedSize = Number(metadata.size || 0);
    } catch (err) {
      reqLog.error({ err, storagePath }, 'storage_metadata_failed');
      return res.status(404).json({ error: 'Audio not found' });
    }
    if (probedSize > MAX_AUDIO_BYTES) {
      const userMsg = publicErrorFor(new Error('TOO_LARGE'));
      await noteRef
        .set({ status: 'error', errorMessage: userMsg, updatedAt: new Date().toISOString() }, { merge: true })
        .catch((err) => reqLog.error({ err }, 'firestore_write_failed:too_large_mirror'));
      return res.status(413).json({ error: userMsg });
    }
  }

  // ── Usage budget (count + bytes, atomic) ──────────────────
  try {
    await enforceUsageBudget(firestore, callerUid, probedSize);
  } catch (err) {
    const userMsg = publicErrorFor(err);
    await noteRef
      .set({ status: 'error', errorMessage: userMsg, updatedAt: new Date().toISOString() }, { merge: true })
      .catch((mirrorErr) => reqLog.error({ err: mirrorErr }, 'firestore_write_failed:rate_limit_mirror'));
    reqLog.warn({ reason: err.message, bytes: probedSize }, 'usage_budget_exceeded');
    return res.status(429).json({ error: userMsg });
  }

  try {
    const ai = getAi(reqLog);
    if (!ai) throw new Error('GEMINI_API_KEY not configured on the server');

    const parts = [];

    if (storagePath && storageBucket) {
      const file = storageBucket.file(storagePath);
      const [audioBuffer] = await file.download();
      const base64Audio = audioBuffer.toString('base64');
      const mimeType = resolveGeminiAudioMime(clientMime, storagePath);
      parts.push({ inlineData: { mimeType, data: base64Audio } });
      reqLog.info({ bytes: audioBuffer.length, mimeType }, 'audio_loaded');
    }

    parts.push({ text: buildPromptText(type, content) });

    const deadline = Date.now() + RETRY_DEADLINE_MS;
    let rawText = null;
    let usedModel = null;
    let lastErr = null;
    outer: for (const modelName of MODEL_LADDER) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (Date.now() > deadline) {
          lastErr = new Error('TIME_BUDGET');
          break outer;
        }
        const startMs = Date.now();
        try {
          const aiResult = await ai.models.generateContent({
            model: modelName,
            contents: [{ role: 'user', parts }],
            config: { responseMimeType: 'application/json' },
          });
          rawText = (aiResult.text || '');
          if (!rawText || !rawText.trim() || rawText.trim() === '{}') {
            throw new Error('Empty Gemini response');
          }
          usedModel = modelName;
          reqLog.info({ model: modelName, attempt: attempt + 1, latencyMs: Date.now() - startMs }, 'gemini_ok');
          break outer;
        } catch (err) {
          lastErr = err;
          if (!isTransientError(err)) {
            reqLog.error({ err, model: modelName }, 'gemini_non_retryable');
            throw err;
          }
          const backoff = backoffMs(attempt);
          reqLog.warn({ err, model: modelName, attempt: attempt + 1, backoff }, 'gemini_transient');
          await sleep(backoff);
        }
      }
    }
    if (rawText === null) {
      throw lastErr || new Error('All Gemini models overloaded');
    }

    const processResult = parseGeminiJson(rawText);

    // Redact PII out of transcript before persisting / using for embeddings.
    const { lines: redactedTranscript, counts: redactionCounts } = redactTranscriptLines(processResult.transcript || []);
    if (Object.keys(redactionCounts).length) {
      reqLog.info({ redactionCounts }, 'transcript_redacted');
    }

    // Redact the summary OUTPUT too — spoken PII can surface in the model's
    // gist/action items/key decisions even when the transcript is scrubbed.
    const { summary: safeSummary, counts: summaryRedactionCounts } = redactSummaryOutput({
      gist: processResult.gist || '',
      actionItems: processResult.actionItems || [],
      keyDecisions: processResult.keyDecisions || [],
    });
    if (Object.keys(summaryRedactionCounts).length) {
      reqLog.info({ redactionCounts: summaryRedactionCounts }, 'summary_output_redacted');
    }

    const { pgWritten } = await markReady(
      firestore,
      {
        noteId,
        workspaceId,
        authorUid: callerUid,
        sourceType: type,
        storagePath,
        mimeType: clientMime,
        summary: safeSummary,
        transcript: redactedTranscript,
        model: usedModel,
      },
      reqLog,
    );

    reqLog.info({ model: usedModel, pgWritten }, 'note_ready');
    res.json({ success: true, noteId });
  } catch (error) {
    reqLog.error({ err: error }, 'processing_error');
    const userMsg = publicErrorFor(error);
    await markError(firestore, { noteId, workspaceId, errorMessage: userMsg }, reqLog).catch((mirrorErr) =>
      reqLog.error({ err: mirrorErr }, 'firestore_write_failed:error_mirror'),
    );
    const statusCode = error && error.code && Number.isInteger(error.code) ? error.code : 500;
    res.status(statusCode).json({ error: userMsg });
  }
}
