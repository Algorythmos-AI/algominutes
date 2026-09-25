import { describe, it, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs, runTransaction, deleteField,
} from 'firebase/firestore';

// infra/firebase/firestore.rules against the Firestore emulator. Runs in CI
// (job firestore-rules: firebase emulators:exec). Every write the iOS app makes
// must pass; everything else must be refused.
let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-algominutes',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '../../infra/firebase/firestore.rules'), 'utf8') },
  });
});
beforeEach(async () => {
  await env.clearFirestore();
});
afterAll(async () => {
  await env.cleanup();
});

const alice = () => env.authenticatedContext('alice').firestore();
const bob = () => env.authenticatedContext('bob').firestore();
const anon = () => env.unauthenticatedContext().firestore();
const NOTE = 'workspaces/workspace_alice/notes/n1';

const recordingNote = (over: Record<string, unknown> = {}) => ({
  title: 'Session_2026-09-25', status: 'processing', type: 'recording', mimeType: 'audio/mp4', duration: 120,
  workspaceId: 'workspace_alice', authorId: 'alice', createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z',
  ...over,
});

// A doc the server wrote (Admin SDK, rules bypassed).
async function serverNote(data: Record<string, unknown>) {
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), NOTE), data); });
}

describe('workspaces/{ws}', () => {
  it('the owner bootstraps and reads their workspace at sign-in', async () => {
    const ref = doc(alice(), 'workspaces/workspace_alice');
    await assertSucceeds(setDoc(ref, { name: 'My Workspace', ownerId: 'alice', members: ['alice'] }));
    await assertSucceeds(getDoc(ref));
  });

  it("no one creates or reads another user's workspace, or adds members, or edits it later", async () => {
    await assertFails(setDoc(doc(bob(), 'workspaces/workspace_alice'), { name: 'x', ownerId: 'bob', members: ['bob'] }));
    await assertFails(setDoc(doc(alice(), 'workspaces/workspace_alice'), { name: 'x', ownerId: 'alice', members: ['alice', 'bob'] }));
    await assertFails(getDoc(doc(bob(), 'workspaces/workspace_alice')));
    await assertFails(getDoc(doc(anon(), 'workspaces/workspace_alice')));
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'workspaces/workspace_alice'), { name: 'My Workspace', ownerId: 'alice', members: ['alice'] });
    });
    await assertFails(updateDoc(doc(alice(), 'workspaces/workspace_alice'), { members: ['alice', 'bob'] }));
    await assertFails(deleteDoc(doc(alice(), 'workspaces/workspace_alice')));
  });
});

describe('workspaces/{ws}/notes/{noteId}: what the app does', () => {
  it('creates a recording, an import, a YouTube note and a scanned-text note', async () => {
    await assertSucceeds(setDoc(doc(alice(), NOTE), recordingNote()));
    await assertSucceeds(setDoc(doc(alice(), 'workspaces/workspace_alice/notes/y1'), {
      title: 'YouTube import', status: 'queued', type: 'youtube', sourceUrl: 'https://youtu.be/x',
      workspaceId: 'workspace_alice', authorId: 'alice', createdAt: 't', updatedAt: 't',
    }));
    await assertSucceeds(setDoc(doc(alice(), 'workspaces/workspace_alice/notes/s1'), {
      title: 'Scan', status: 'ready', type: 'scan_text', duration: 0, rawText: 'hello', wordCount: 1, transcriptTruncated: false,
      transcript: [{ speaker: 'Speaker', text: 'hello', time: '00:00' }], summary: { gist: 'hello', actionItems: [], keyDecisions: [] },
      workspaceId: 'workspace_alice', authorId: 'alice', createdAt: 't', updatedAt: 't',
    }));
  });

  it('records the upload path, retries, lets the watchdog give up, and retitles', async () => {
    await serverNote(recordingNote({ status: 'transcribing' }));
    const db = alice(); // one client, as in the app (a transaction needs refs from its own instance)
    const ref = doc(db, NOTE);
    await assertSucceeds(updateDoc(ref, { storagePath: 'recordings/workspace_alice/n1.m4a', updatedAt: 't2' }));
    await assertSucceeds(updateDoc(ref, { status: 'queued', errorMessage: null, retryAttempt: 2, storagePath: 'recordings/workspace_alice/n1.m4a', updatedAt: 't3' }));
    await assertSucceeds(runTransaction(db, async (tx) => {
      await tx.get(ref);
      tx.update(ref, { status: 'error', errorMessage: 'Processing took too long. Please try again.', diagnosticCode: 'CLIENT_TIMEOUT', updatedAt: 't4' });
    }));
    await assertSucceeds(updateDoc(ref, { title: 'Quarterly planning', updatedAt: 't5' }));
  });

  it("lists only the author's own notes (the app's authorId query)", async () => {
    await serverNote(recordingNote());
    await assertSucceeds(getDocs(query(collection(alice(), 'workspaces/workspace_alice/notes'), where('authorId', '==', 'alice'))));
    await assertSucceeds(getDoc(doc(alice(), NOTE)));
  });
});

describe('workspaces/{ws}/notes/{noteId}: what is refused', () => {
  it("another user can't read, list, create in, or write to alice's notes", async () => {
    await serverNote(recordingNote());
    await assertFails(getDoc(doc(bob(), NOTE)));
    await assertFails(getDocs(query(collection(bob(), 'workspaces/workspace_alice/notes'), where('authorId', '==', 'alice'))));
    await assertFails(setDoc(doc(bob(), 'workspaces/workspace_alice/notes/n2'), recordingNote({ authorId: 'bob' })));
    await assertFails(updateDoc(doc(bob(), NOTE), { title: 'x' }));
    await assertFails(getDoc(doc(anon(), NOTE)));
  });

  it('a client never deletes a note doc (deletion is POST /v1/notes/delete)', async () => {
    await serverNote(recordingNote());
    await assertFails(deleteDoc(doc(alice(), NOTE)));
  });

  it("a client can't fake progress or a result: status 'ready', a summary, or a transcript", async () => {
    await serverNote(recordingNote({ status: 'transcribing' }));
    const ref = doc(alice(), NOTE);
    await assertFails(updateDoc(ref, { status: 'ready' }));
    await assertFails(updateDoc(ref, { status: 'summarizing' }));
    await assertFails(updateDoc(ref, { summary: { gist: 'forged' } }));
    await assertFails(updateDoc(ref, { transcriptPreview: [] }));
    await assertFails(updateDoc(ref, { authorId: 'bob' }));
    await assertFails(updateDoc(ref, { workspaceId: 'workspace_bob' }));
    await assertFails(updateDoc(ref, { title: deleteField() }));
  });

  it('create: no foreign author or workspace, no server-owned fields, no forged status', async () => {
    await assertFails(setDoc(doc(alice(), NOTE), recordingNote({ authorId: 'bob' })));
    await assertFails(setDoc(doc(alice(), NOTE), recordingNote({ workspaceId: 'workspace_bob' })));
    await assertFails(setDoc(doc(alice(), NOTE), recordingNote({ status: 'ready' })));
    await assertFails(setDoc(doc(alice(), NOTE), recordingNote({ transcriptPreview: [] })));
    await assertFails(setDoc(doc(alice(), NOTE), recordingNote({ status: 'ready', type: 'recording', summary: { gist: 'x' } })));
  });

  it("a storage path must be this note's own object in this workspace", async () => {
    await serverNote(recordingNote());
    const ref = doc(alice(), NOTE);
    await assertFails(updateDoc(ref, { storagePath: 'recordings/workspace_bob/n1.m4a' }));
    await assertFails(updateDoc(ref, { storagePath: 'recordings/workspace_alice/n2.m4a' }));
    await assertFails(updateDoc(ref, { storagePath: 'recordings/workspace_alice/n1.m4a/../../x' }));
    await assertFails(setDoc(doc(alice(), 'workspaces/workspace_alice/notes/n3'), recordingNote({ storagePath: 'imports/workspace_alice/n1.pdf' })));
  });

  it('nothing outside workspaces is reachable (rate limits, analytics, anything else)', async () => {
    await assertFails(getDoc(doc(alice(), 'rateLimits/alice')));
    await assertFails(setDoc(doc(alice(), 'rateLimits/alice'), { count: 0 }));
    await assertFails(setDoc(doc(alice(), 'analytics/x'), { event: 'x' }));
  });
});
