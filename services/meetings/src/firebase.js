// firebase-admin for services/meetings: the notetaker's note mirror (Firestore),
// written only through the repo layer. ADC on Cloud Run. Idempotent.
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export function firestore() {
  if (!getApps().length) {
    const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || undefined;
    initializeApp(projectId ? { projectId } : {});
  }
  return getFirestore();
}
