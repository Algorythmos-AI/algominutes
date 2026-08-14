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

// server.ts-derived routes (ESM).
import { processAudioRoute } from './process-audio.js';
import { updateNoteRoute } from './update-note.js';

// Ported Functions handlers (framework-agnostic CJS; default-import interop).
import noteReadModule from './note-read.cjs';
import exportNoteModule from './export-note.cjs';
import searchAndChatModule from './search-and-chat.cjs';
import sharedNoteModule from './shared-note.cjs';
import deleteAccountModule from './delete-account.cjs';
import pgQueryModule from '@algominutes/db/pg-query.cjs';

const { handleNoteRead } = noteReadModule;
const { handleExportNote } = exportNoteModule;
const { handleSearch, handleChatStream } = searchAndChatModule;
const { handleSharedNote } = sharedNoteModule;
const { handleDeleteAccount } = deleteAccountModule;
const { pool } = pgQueryModule;

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

  // ── health ── (no auth, no version gate — see app.js exempt list) ──────
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // ── POST /v1/process-audio ── server.ts /api/process-audio ─────────────
  router.post('/process-audio', authMiddleware, wrap(processAudioRoute));

  // ── POST /v1/notes/read ── functions/note-read.cjs (also server.ts /api/note)
  router.post('/notes/read', authMiddleware, wrap(async (req, res) => {
    const result = await handleNoteRead({ uid: req.uid, body: req.body, log: req.log });
    return res.status(result.status).json(result.body);
  }));

  // ── POST /v1/notes/update ── server.ts /api/update-note (updateNote twin) ─
  router.post('/notes/update', authMiddleware, wrap(updateNoteRoute));

  // ── POST /v1/export ── functions/export-note.cjs (binary DOCX) ─────────
  router.post('/export', authMiddleware, wrap(async (req, res) => {
    const result = await handleExportNote({ uid: req.uid, body: req.body, log: req.log });
    if (!result.buffer) return res.status(result.status).json(result.body);
    res.setHeader('Content-Type', DOCX_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
    // Clinical content: never cached by an intermediary.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(result.buffer);
  }));

  // ── POST /v1/search ── functions/search-and-chat.cjs handleSearch ──────
  router.post('/search', authMiddleware, wrap(async (req, res) => {
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
  router.post('/chat', authMiddleware, wrap(async (req, res) => {
    await handleChatStream({
      uid: req.uid,
      body: req.body,
      apiKey: process.env.GEMINI_API_KEY,
      log: req.log,
      res,
    });
  }));

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

  // ── /v1/account/delete ── functions/delete-account.cjs ─────────────────
  //
  // Self-authenticating (same verifyIdToken primitive) and self-managing its
  // method envelope, so it is mounted raw rather than behind authMiddleware.
  // CORS is applied globally, so the handler is handed a no-op applyCors. It
  // accepts POST and DELETE, exactly as the source did.
  const deleteAccountHandler = wrap(async (req, res) => {
    await handleDeleteAccount({
      req,
      res,
      pgPool: pool,
      applyCors: () => {},
      traceId: req.traceId,
      log: req.log,
    });
  });
  router.post('/account/delete', deleteAccountHandler);
  router.delete('/account/delete', deleteAccountHandler);

  return router;
}
