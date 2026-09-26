import { Link } from 'react-router';
import { displayTitle, formatDate, formatDuration, statusOf } from '../../lib/notes/format';
import { isSlow } from '../../lib/noteWatchdog';
import { useNow } from '../useNow';
import { useNotes } from './NotesContext';

const BADGE: Record<string, string> = {
  ready: 'bg-success/15 text-success',
  working: 'bg-accent/15 text-heading',
  failed: 'bg-danger/15 text-danger',
};

export function NotesPage() {
  const { state, visible } = useNotes();
  const now = useNow();
  return (
    <section aria-labelledby="notes-title">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 id="notes-title" className="text-3xl font-bold text-heading">Your notes</h1>
        <Link to="/import" className="rounded-xl bg-accent px-4 py-2 font-semibold text-white no-underline">Import a recording</Link>
      </div>
      {state.status === 'loading' && <p role="status" className="text-muted">Loading your notes…</p>}
      {state.status === 'error' && (
        <p role="alert" className="text-body">Your notes couldn't be loaded. Check your connection and reload the page.</p>
      )}
      {state.status === 'ready' && visible.length === 0 && (
        <div className="rounded-2xl border border-border bg-card p-6">
          <p className="text-heading font-semibold">No notes yet</p>
          <p className="mt-1 text-muted">Record a meeting in the AlgoMinutes app and its summary appears here. Or import a recording here.</p>
        </div>
      )}
      {visible.length > 0 && (
        <ul className="flex flex-col gap-3">
          {visible.map((n) => {
            const s = statusOf(n.status);
            const slow = s.kind === 'working' && isSlow(n, now);
            const meta = [formatDate(n.createdAt), formatDuration(n.duration)].filter(Boolean).join(' · ');
            return (
              <li key={n.id}>
                <Link to={`/notes/${encodeURIComponent(n.id)}`} className="block rounded-2xl border border-border bg-card p-4 no-underline hover:bg-card-hover">
                  <div className="flex items-start justify-between gap-3">
                    <span className="font-semibold text-heading">{displayTitle(n.title)}</span>
                    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${BADGE[s.kind]}`}>{slow ? 'Taking longer than usual' : s.label}</span>
                  </div>
                  {meta && <p className="mt-1 text-sm text-muted">{meta}</p>}
                  {n.status === 'ready' && n.summary?.gist && <p className="mt-2 line-clamp-2 text-body">{n.summary.gist}</p>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
