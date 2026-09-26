import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { newestFirst, type NoteDoc, type NotesFeed } from '../../lib/notes/notesFeed';
import { reportCrash } from '../../lib/crashReport';
import { useAuth } from '../auth/AuthContext';

type FeedState = { status: 'loading' } | { status: 'ready'; notes: NoteDoc[] } | { status: 'error' };

interface NotesValue {
  state: FeedState;
  /** The notes the list shows: the feed, less any the user just deleted. */
  visible: NoteDoc[];
  /** Hides a note at once (a delete in flight); `unhide` puts it back if the server refused. */
  hide(id: string): void;
  unhide(id: string): void;
}

const NotesContext = createContext<NotesValue | null>(null);

/**
 * The signed-in user's notes, live. `bootstrap` runs once per user first (the
 * workspace doc, as iOS does at sign-in); its failure is non-fatal.
 */
export function NotesProvider({ feed, bootstrap, children }: { feed: NotesFeed; bootstrap?: (uid: string) => Promise<void>; children: ReactNode }) {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  // Tagged with the uid it belongs to: a different (or no) user reads as loading, with no reset in the effect.
  const [tagged, setTagged] = useState<{ uid: string; state: FeedState } | null>(null);
  const state = useMemo<FeedState>(() => (tagged && tagged.uid === uid ? tagged.state : { status: 'loading' }), [tagged, uid]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!uid) return;
    bootstrap?.(uid).catch((err) => reportCrash('notes.bootstrap', err));
    return feed.subscribe(
      uid,
      (notes) => setTagged({ uid, state: { status: 'ready', notes: newestFirst(notes) } }),
      (err) => {
        reportCrash('notes.feed', err);
        setTagged({ uid, state: { status: 'error' } });
      },
    );
  }, [feed, bootstrap, uid]);

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
    () => ({ state, visible: state.status === 'ready' ? state.notes.filter((n) => !hidden.has(n.id)) : [], hide, unhide }),
    [state, hidden, hide, unhide],
  );
  return <NotesContext.Provider value={value}>{children}</NotesContext.Provider>;
}

export function useNotes(): NotesValue {
  const v = useContext(NotesContext);
  if (!v) throw new Error('useNotes outside NotesProvider');
  return v;
}
