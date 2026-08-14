// One-time firebase-admin initialization for the API service.
//
// functions/index.js called a bare `initializeApp()` (ADC on Cloud
// Functions); server.ts read firebase-applet-config.json for projectId /
// storageBucket. On Cloud Run we use Application Default Credentials and take
// project / bucket from the environment, falling back to ADC discovery when
// unset. Idempotent: safe to call more than once.

import { initializeApp, getApps } from 'firebase-admin/app';

let _initialized = false;

export function initFirebase() {
  if (_initialized || getApps().length > 0) {
    _initialized = true;
    return;
  }
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || undefined;
  const storageBucket = process.env.STORAGE_BUCKET || undefined;
  const opts = {};
  if (projectId) opts.projectId = projectId;
  if (storageBucket) opts.storageBucket = storageBucket;
  initializeApp(opts);
  _initialized = true;
}
