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
