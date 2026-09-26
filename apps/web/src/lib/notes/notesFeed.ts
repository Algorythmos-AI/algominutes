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

/** Parses docs into notes, newest first; the ids of any that don't match the contract come back separately. */
export function parseNotes(docs: Array<{ id: string; data: unknown }>): { notes: NoteDoc[]; invalid: string[] } {
  const notes: NoteDoc[] = [];
  const invalid: string[] = [];
  for (const d of docs) {
    const parsed = Note.safeParse({ ...(d.data as object), id: d.id });
    if (parsed.success) notes.push(parsed.data);
    else invalid.push(d.id);
  }
  return { notes: newestFirst(notes), invalid };
}

/** Newest first by createdAt (ISO strings sort as times); ties keep their order. */
export const newestFirst = (notes: NoteDoc[]): NoteDoc[] =>
  [...notes].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

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
              if (invalid.length) reportCrash('notes.invalidDocs', new Error(`${invalid.length} note doc(s) failed the contract`), { source: invalid.slice(0, 5).join(',') });
              onNotes(notes);
            },
            onError,
          );
        })
        .catch(onError);
      return () => {
        cancelled = true;
        stop?.();
      };
    },
  };
}
