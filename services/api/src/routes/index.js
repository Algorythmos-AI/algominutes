// The one route table for AlgoMinutes' HTTP edge.
//
// Every endpoint the source split across Express server.ts AND the Firebase
// Functions handlers now lives here, under a single `/v1` prefix, behind one
// auth path and one CORS config (BUILD-PLAN §3.1). The ported handlers are
// mounted, not reimplemented — the `.cjs` files in this directory are the
// framework-agnostic handlers copied verbatim from `functions/`, with only
// their shared-lib import paths repointed at the workspace packages.

import { Router } from 'express';
import { getFirestore } from 'firebase-admin/firestore';

import { authMiddleware } from '../middleware/auth.js';
import { adminMiddleware } from '../middleware/admin.js';
import rateLimitModule from '@algominutes/ai/rate-limit.cjs';

// server.ts-derived routes (ESM).
import { updateNoteRoute } from './update-note.js';
import { deleteNoteRoute } from './delete-note.js';
import { setNoteSpeakersRoute } from './set-note-speakers.js';

// functions/index.js HTTP handlers, ported to services/api (ESM).
import { processIntelligenceRoute } from './process-intelligence.js';
import { regenerateSummaryRoute } from './regenerate-summary.js';
import { shareCreateRoute, shareRevokeRoute } from './shares.js';
import { noteFeedbackRoute } from './note-feedback.js';
import { clientErrorRoute } from './client-error.js';

// A7 async-UX + reliability and A9 entitlement routes (ESM).
import { createUploadSessionRoute, getUploadStatusRoute, completeUploadRoute } from './uploads.js';
import { registerPushTokenRoute } from './push-register.js';
import { entitlementRoute } from './entitlement.js';
import { trackEventRoute } from './events.js';
import { setRetentionRoute, acceptTermsRoute, supportRoute } from './compliance.js';
import { listDeadLettersRoute, resolveDeadLetterRoute } from './admin-dead-letters.js';

// Ported Functions handlers (framework-agnostic CJS; default-import interop).
import noteReadModule from './note-read.cjs';
import exportNoteModule from './export-note.cjs';
import searchAndChatModule from './search-and-chat.cjs';
import sharedNoteModule from './shared-note.cjs';
import { deleteAccountRoute } from './delete-account.js';
import pgQueryModule from '@algominutes/ai/pg-query.cjs';
import pgConfigModule from '@algominutes/ai/pg-config.cjs';
import { getPool } from '@algominutes/db';

const { handleNoteRead } = noteReadModule;
const { handleExportNote } = exportNoteModule;
const { handleSearch, handleChatStream } = searchAndChatModule;
const { handleSharedNote } = sharedNoteModule;
const { pool } = pgQueryModule;
const readPool = pool;
const { pingPool } = pgConfigModule;
const { userRateLimit } = rateLimitModule;

const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Express 4 does not forward rejected promises to the error handler; this
// adapter does, so an unhandled throw becomes a JSON 500 instead of a hung
// socket — the same guarantee functions/index.js's withRequestLogging gave.
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function buildRouter() {
  const router = Router();

  // Every authenticated route: verify the token, then count the request against
  // the caller's per-user budget. One limiter, shared across routes, so the
  // budget is per user for the whole API, not per route.
  const authed = [authMiddleware, userRateLimit()];

  // ── health ── (no auth, no version gate — see app.js exempt list) ──────
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // ── readiness ── proves BOTH Postgres pools this service uses can reach the
  // database (the repo layer and the read-path pool). Used by the post-deploy
  // smoke; kept separate from /health so uptime probes never touch the DB.
  router.get('/health/ready', async (req, res) => {
    try {
      await Promise.all([pingPool(getPool()), pingPool(readPool())]);
      res.json({ status: 'ok', db: 'ok' });
    } catch (err) {
      req.log.error({ err }, 'readiness_db_unreachable');
      res.status(503).json({ status: 'degraded', db: 'unreachable' });
    }
  });


  // ── POST /v1/process ── functions/index.js processIntelligence (async) ──
  router.post('/process', authed, wrap(processIntelligenceRoute));

  // ── POST /v1/notes/read ── functions/note-read.cjs (also server.ts /api/note)
  router.post('/notes/read', authed, wrap(async (req, res) => {
    const result = await handleNoteRead({ uid: req.uid, body: req.body, log: req.log });
    return res.status(result.status).json(result.body);
  }));

  // ── POST /v1/notes/update ── server.ts /api/update-note (updateNote twin) ─
  router.post('/notes/update', authed, wrap(updateNoteRoute));

  // ── /v1/notes/delete ── the single deletion path (notes-repo deleteNote) ──
  router.post('/notes/delete', authed, wrap(deleteNoteRoute));

  // ── POST /v1/notes/:id/speakers ── name diarised speakers (ADR 0005) ────
  router.post('/notes/:id/speakers', authed, wrap(setNoteSpeakersRoute));

  // ── POST /v1/notes/regenerate-summary ── functions/index.js regenerateSummary
  router.post('/notes/regenerate-summary', authed, wrap(regenerateSummaryRoute));

  // ── POST /v1/notes/feedback ── functions/index.js noteFeedback ─────────
  router.post('/notes/feedback', authed, wrap(noteFeedbackRoute));

  // ── POST /v1/export ── functions/export-note.cjs (binary DOCX) ─────────
  router.post('/export', authed, wrap(async (req, res) => {
    const result = await handleExportNote({ uid: req.uid, body: req.body, log: req.log });
    if (!result.buffer) return res.status(result.status).json(result.body);
    res.setHeader('Content-Type', DOCX_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
    // Sensitive content: never cached by an intermediary.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(result.buffer);
  }));

  // ── POST /v1/search ── functions/search-and-chat.cjs handleSearch ──────
  router.post('/search', authed, wrap(async (req, res) => {
    const result = await handleSearch({
      uid: req.uid,
      body: req.body,
      // Vestigial at the call site — embedQuery authenticates via ADC — but
      // kept for parity with the source's signature.
      apiKey: process.env.GEMINI_API_KEY,
      log: req.log,
    });
    return res.status(result.status).json(result.body);
  }));

  // ── POST /v1/chat ── functions/search-and-chat.cjs handleChatStream (SSE) ─
  router.post('/chat', authed, wrap(async (req, res) => {
    await handleChatStream({
      uid: req.uid,
      body: req.body,
      apiKey: process.env.GEMINI_API_KEY,
      log: req.log,
      res,
    });
  }));

  // ── POST /v1/shares/create ── functions/index.js shareCreate ───────────
  router.post('/shares/create', authed, wrap(shareCreateRoute));

  // ── POST /v1/shares/revoke ── functions/index.js shareRevoke ───────────
  router.post('/shares/revoke', authed, wrap(shareRevokeRoute));

  // ── POST /v1/shares/read ── functions/shared-note.cjs (PUBLIC, no auth) ─
  //
  // The only unauthenticated surface: the share token IS the credential. No
  // auth middleware, no client-version gate (see app.js exempt list). Headers
  // and rate-limit semantics are preserved verbatim from functions/index.js's
  // sharedNote wrapper.
  router.post('/shares/read', wrap(async (req, res) => {
    // Never cached: a revoked link must stop working immediately, and a CDN
    // copy would outlive the revocation.
    res.set('Cache-Control', 'no-store, private');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Referrer-Policy', 'no-referrer');

    const { token } = req.body || {};
    // The RIGHTMOST X-Forwarded-For entry, not the leftmost — the one Google's
    // load balancer appends and a client cannot forge. Taking [0] would let a
    // caller rotate a header to reset the rate-limit counter.
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',').map((p) => p.trim()).filter(Boolean);
    const ip = forwarded.length ? forwarded[forwarded.length - 1] : (req.ip || null);
    const result = await handleSharedNote({
      token,
      ip,
      userAgent: req.headers['user-agent'],
      db: getFirestore(),
      log: req.log,
    });
    return res.status(result.status).json(result.body);
  }));

  // ── /v1/account/delete ── the single deletion path (delete-account.js) ──
  //
  // Self-authenticating (verifyIdToken) and self-managing its method
  // envelope, so it is mounted without authMiddleware; the client IP limit
  // (app.js) covers it. It accepts POST and DELETE, as before.
  const deleteAccountHandler = wrap((req, res) => deleteAccountRoute(req, res));
  router.post('/account/delete', deleteAccountHandler);
  router.delete('/account/delete', deleteAccountHandler);

  // ── POST /v1/client-error ── functions/index.js clientError ────────────
  //
  // PUBLIC crash beacon: no auth, and exempt from the client-version gate
  // (see app.js) so a crashing client can always report. Nothing touches
  // Postgres; every field is length-capped before it reaches the log.
  router.post('/client-error', wrap(async (req, res) => clientErrorRoute(req, res)));

  // ── A7.2 resumable uploads ── services/api/src/routes/uploads.js ────────
  router.post('/uploads', authed, wrap(createUploadSessionRoute));
  router.get('/uploads/:uploadId', authed, wrap(getUploadStatusRoute));
  router.post('/uploads/:uploadId/complete', authed, wrap(completeUploadRoute));

  // ── A7.3 POST /v1/push/register ── push-register.js ─────────────────────
  router.post('/push/register', authed, wrap(registerPushTokenRoute));

  // ── A9.1 GET /v1/entitlement ── entitlement.js ──────────────────────────
  router.get('/entitlement', authed, wrap(entitlementRoute));
  // ── A9.6 POST /v1/events ── events.js ──────────────────────────────────
  router.post('/events', authed, wrap(trackEventRoute));
  // ── A10 compliance ── compliance.js ────────────────────────────────────
  router.post('/account/retention', authed, wrap(setRetentionRoute));
  router.post('/account/accept-terms', authed, wrap(acceptTermsRoute));
  router.post('/support', authed, wrap(supportRoute));

  // ── A7.4 dead-letter admin view ── admin-dead-letters.js ────────────────
  // Operator-only: authMiddleware sets req.uid, adminMiddleware gates on the
  // ADMIN_UIDS allowlist (see middleware/admin.js).
  router.get('/admin/dead-letters', authed, adminMiddleware, wrap(listDeadLettersRoute));
  router.post('/admin/dead-letters/:id/resolve', authed, adminMiddleware, wrap(resolveDeadLetterRoute));

  return router;
}
