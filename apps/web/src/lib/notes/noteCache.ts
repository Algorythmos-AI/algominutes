// The web app's only Firestore writes, both allowed by infra/firebase/firestore.rules
// and both the same as iOS:
//   - the workspace doc, created once at sign-in (AuthService.ensureWorkspaceDoc);
//   - (plan W5) a new note's doc, created before its kickoff.
// Every other change to a note goes through the /v1 api, which writes Postgres
// first and then this cache (CLAUDE.md). scripts/check-no-direct-firestore.sh
// allows apps/web to write Firestore here and nowhere else.
import type { Firestore } from 'firebase/firestore';
import { workspaceIdFor } from './workspace';

/** Creates workspaces/workspace_<uid> when it's missing. Non-fatal: the api checks the workspace on every call. */
export async function ensureWorkspace(db: Firestore, uid: string): Promise<void> {
  // Imported here, not at the top: Firestore loads after sign-in (firebase.ts firestore()).
  const { doc, getDoc, setDoc } = await import('firebase/firestore');
  const ref = doc(db, 'workspaces', workspaceIdFor(uid));
  const snap = await getDoc(ref);
  if (snap.exists()) return;
  await setDoc(ref, { name: 'My Workspace', ownerId: uid, members: [uid] });
}

export interface NewNote {
  noteId: string;
  uid: string;
  title: string;
  type: 'import_audio' | 'recording';
  mimeType: string;
  storagePath: string;
  duration?: number;
}

/**
 * A new note's doc, before its kickoff, as iOS writes it: status 'processing'
 * (the client owns it until the kickoff; the server owns it after), with the
 * storage path the api minted. The rules admit exactly these keys.
 */
export async function createNoteDoc(db: Firestore, n: NewNote): Promise<void> {
  const { doc, setDoc } = await import('firebase/firestore');
  const now = new Date().toISOString();
  const workspaceId = workspaceIdFor(n.uid);
  await setDoc(doc(db, 'workspaces', workspaceId, 'notes', n.noteId), {
    title: n.title,
    status: 'processing',
    type: n.type,
    mimeType: n.mimeType,
    storagePath: n.storagePath,
    ...(n.duration ? { duration: n.duration } : {}),
    workspaceId,
    authorId: n.uid,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Marks the client's own note failed (its upload died, or its kickoff was
 * refused before the server took it). The rules admit status 'error' with a
 * message; only the server marks progress or 'ready'.
 */
export async function markNoteFailed(db: Firestore, uid: string, noteId: string, errorMessage: string): Promise<void> {
  const { doc, updateDoc } = await import('firebase/firestore');
  await updateDoc(doc(db, 'workspaces', workspaceIdFor(uid), 'notes', noteId), {
    status: 'error',
    errorMessage,
    updatedAt: new Date().toISOString(),
  });
}
