import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { newestFirst, type NoteDoc, type NotesFeed } from '../../lib/notes/notesFeed';
import type { NewNote } from '../../lib/notes/noteCache';
import { reportCrash } from '../../lib/crashReport';
import { STUCK_BUDGETS_MS } from '../../lib/noteWatchdog';
import { abandonedUploads, endedUpload } from '../../lib/uploads/ownUploads';
import { useAuth } from '../auth/AuthContext';

type FeedState = { status: 'loading' } | { status: 'ready'; notes: NoteDoc[] } | { status: 'error' };

/** The web's two note-doc writes (lib/notes/noteCache.ts), injected so tests can fake them. */
export interface NoteWriter {
  createNoteDoc(n: NewNote): Promise<void>;
  markNoteFailed(uid: string, noteId: string, message: string): Promise<void>;
}

interface NotesValue {
  writer: NoteWriter | null;
  state: FeedState;
  /** The notes the list shows: the feed, less any the user just deleted. */
  visible: NoteDoc[];
  /** Hides a note at once (a delete in flight); `unhide` puts it back if the server refused. */
  hide(id: string): void;
  unhide(id: string): void;
}

const NotesContext = createContext<NotesValue | null>(null);

// The workspace bootstrap runs once per uid per page load: StrictMode and a
// re-subscription would otherwise race two creates, and the second is refused.
const bootstrapped = new Set<string>();
/** Backoff for a listener that errored: 2s, 4s, 8s … up to a minute, as iOS retries. */
export const retryDelayMs = (attempt: number) => Math.min(60_000, 2000 * 2 ** attempt);

/**
 * The signed-in user's notes, live. `bootstrap` runs once per user first (the
 * workspace doc, as iOS does at sign-in); its failure is non-fatal.
 */
export function NotesProvider({ feed, bootstrap, writer = null, children }: { feed: NotesFeed; bootstrap?: (uid: string) => Promise<void>; writer?: NoteWriter | null; children: ReactNode }) {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  // Tagged with the uid it belongs to: a different (or no) user reads as loading, with no reset in the effect.
  const [tagged, setTagged] = useState<{ uid: string; state: FeedState } | null>(null);
  const state = useMemo<FeedState>(() => (tagged && tagged.uid === uid ? tagged.state : { status: 'loading' }), [tagged, uid]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!uid) return;
    if (bootstrap && !bootstrapped.has(uid)) {
      bootstrapped.add(uid);
      bootstrap(uid).catch((err) => reportCrash('notes.bootstrap', err));
    }
    let stop: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let closed = false;
    const connect = () => {
      stop = feed.subscribe(
        uid,
        (notes) => {
          attempt = 0;
          setTagged({ uid, state: { status: 'ready', notes: newestFirst(notes) } });
        },
        (err) => {
          reportCrash('notes.feed', err);
          // Keep showing the last notes if there were any; say so only when there's nothing to show.
          setTagged((t) => (t && t.uid === uid && t.state.status === 'ready' ? t : { uid, state: { status: 'error' } }));
          stop?.();
          if (!closed) timer = setTimeout(connect, retryDelayMs(attempt++));
        },
      );
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      stop?.();
    };
  }, [feed, bootstrap, uid]);

  // An upload this browser started and left behind (its tab was closed) leaves its note 'processing'
  // with no server run to fail it: once it's past the client's window, it's marked failed.
  useEffect(() => {
    if (!uid || !writer || state.status !== 'ready') return;
    const byId = new Map(state.notes.map((n) => [n.id, n]));
    for (const id of abandonedUploads()) {
      const n = byId.get(id);
      if (!n || n.status !== 'processing') {
        endedUpload(id);
        continue;
      }
      if (Date.now() - new Date(n.updatedAt).getTime() < STUCK_BUDGETS_MS.processing) continue;
      endedUpload(id);
      writer.markNoteFailed(uid, id, 'The upload didn’t finish. Import the recording again.').catch((err) => reportCrash('notes.abandonedUpload', err));
    }
  }, [uid, writer, state]);

  const hide = useCallback((id: string) => setHidden((h) => new Set(h).add(id)), []);
  const unhide = useCallback(
    (id: string) =>
      setHidden((h) => {
        const next = new Set(h);
        next.delete(id);
        return next;
      }),
    [],
  );
  const value = useMemo<NotesValue>(
    () => ({ writer, state, visible: state.status === 'ready' ? state.notes.filter((n) => !hidden.has(n.id)) : [], hide, unhide }),
    [writer, state, hidden, hide, unhide],
  );
  return <NotesContext.Provider value={value}>{children}</NotesContext.Provider>;
}

export function useNotes(): NotesValue {
  const v = useContext(NotesContext);
  if (!v) throw new Error('useNotes outside NotesProvider');
  return v;
}
