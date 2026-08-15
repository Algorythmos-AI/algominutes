// One-time firebase-admin initialization for the billing service.
//
// The authed client endpoints (purchase verify, checkout, portal) verify the
// caller's Firebase ID token — the SAME pattern as services/api/src/firebase.js
// — so entitlement is keyed to a server-resolved uid, never a client claim. On
// Cloud Run we use Application Default Credentials and take project from the
// environment, falling back to ADC discovery when unset. Idempotent.

import { initializeApp, getApps } from 'firebase-admin/app';

let _initialized = false;

export function initFirebase() {
  if (_initialized || getApps().length > 0) {
    _initialized = true;
    return;
  }
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || undefined;
  const opts = {};
  if (projectId) opts.projectId = projectId;
  initializeApp(opts);
  _initialized = true;
}
