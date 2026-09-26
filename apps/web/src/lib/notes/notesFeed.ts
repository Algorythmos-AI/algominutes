// The live note list: a read-only Firestore listener on the user's own notes
// (the rules admit `authorId == uid`), newest first. Each doc is checked
// against the contracts' Note schema; one that doesn't match is left out and
// reported, rather than breaking the whole list.
import type { Firestore } from 'firebase/firestore';
import { Note } from '@algominutes/contracts';
import type { z } from 'zod';
import { reportCrash } from '../crashReport';
import { workspaceIdFor } from './workspace';

export type NoteDoc = z.infer<typeof Note>;

/**
 * A doc as the contract reads it, leniently, as iOS does: a null field is an
 * absent one (the sweep's mirror repair writes errorMessage: null), and a
 * missing title is an empty one. Status and type must still be real values.
 */
function lenient(id: string, data: unknown): unknown {
  const out: Record<string, unknown> = { title: '' };
  for (const [k, v] of Object.entries((data as Record<string, unknown>) ?? {})) if (v !== null && v !== undefined) out[k] = v;
  out.id = id;
  return out;
}

/** Parses docs into notes, newest first; the ids of any that still don't match the contract come back separately. */
export function parseNotes(docs: Array<{ id: string; data: unknown }>): { notes: NoteDoc[]; invalid: string[] } {
  const notes: NoteDoc[] = [];
  const invalid: string[] = [];
  for (const d of docs) {
    const parsed = Note.safeParse(lenient(d.id, d.data));
    if (parsed.success) notes.push(parsed.data);
    else invalid.push(d.id);
  }
  return { notes: newestFirst(notes), invalid };
}

/** Newest first by createdAt (ISO strings sort as times); ties keep their order. */
export const newestFirst = (notes: NoteDoc[]): NoteDoc[] =>
  [...notes].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

// Each bad doc is reported once per page load, not on every snapshot.
const reported = new Set<string>();

export interface NotesFeed {
  subscribe(uid: string, onNotes: (notes: NoteDoc[]) => void, onError: (err: unknown) => void): () => void;
}

/** The live feed, on Firestore loaded on first use (`getDb`). */
export function firestoreNotesFeed(getDb: () => Promise<Firestore>): NotesFeed {
  return {
    subscribe: (uid, onNotes, onError) => {
      let stop: (() => void) | null = null;
      let cancelled = false;
      Promise.all([getDb(), import('firebase/firestore')])
        .then(([db, { collection, onSnapshot, query, where }]) => {
          if (cancelled) return;
          stop = onSnapshot(
            query(collection(db, 'workspaces', workspaceIdFor(uid), 'notes'), where('authorId', '==', uid)),
            (snap) => {
              const { notes, invalid } = parseNotes(snap.docs.map((d) => ({ id: d.id, data: d.data() })));
              const fresh = invalid.filter((id) => !reported.has(id));
              if (fresh.length) {
                fresh.forEach((id) => reported.add(id));
                reportCrash('notes.invalidDocs', new Error(`${fresh.length} note doc(s) failed the contract`), { source: fresh.slice(0, 5).join(',') });
              }
              onNotes(notes);
            },
            onError,
          );
        })
        .catch((err) => {
          if (!cancelled) onError(err);
        });
      return () => {
        cancelled = true;
        stop?.();
      };
    },
  };
}
