import { useCallback, useEffect, useState } from 'react';
import { type DeadLetterEntry } from '@algominutes/contracts';
import { useApi } from '../ApiContext';
import { Modal } from '../Modal';
import { ApiError } from '../../lib/api/errors';
import { reportCrash } from '../../lib/crashReport';

type Load = { state: 'loading' } | { state: 'refused' } | { state: 'failed'; message: string } | { state: 'loaded'; entries: DeadLetterEntry[] };

/**
 * The operators' dead-letter view (SLO 5: every dead letter reviewed within one working day;
 * docs/runbooks/production-incident.md §5.5). Every task out of attempts, and every note the sweep gave up on, is a
 * row: follow its traceId to the cause, then mark it resolved. Resolving only marks the row; it replays nothing.
 * The api's ADMIN_UIDS is the guard (403 for anyone else); the page isn't linked from the app's navigation.
 */
export function DeadLettersPage() {
  const { api } = useApi();
  const [includeResolved, setIncludeResolved] = useState(false);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [confirming, setConfirming] = useState<DeadLetterEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchEntries = useCallback(async () => {
    try {
      const { deadLetters } = await api.deadLetters({ includeResolved });
      setLoad({ state: 'loaded', entries: deadLetters });
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) return setLoad({ state: 'refused' });
      setLoad({ state: 'failed', message: err instanceof ApiError ? err.message : 'The dead letters could not be loaded.' });
      if (!(err instanceof ApiError)) reportCrash('admin.deadLetters', err);
    }
  }, [api, includeResolved]);

  useEffect(() => {
    void fetchEntries();
  }, [fetchEntries]);

  const resolve = async (entry: DeadLetterEntry) => {
    setBusy(true);
    setError(null);
    try {
      await api.resolveDeadLetter(entry.id);
      setConfirming(null);
      await fetchEntries();
    } catch (err) {
      setError(err instanceof ApiError ? `Not resolved. ${err.message}` : 'Not resolved. Try again.');
      if (!(err instanceof ApiError)) reportCrash('admin.resolveDeadLetter', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="dead-letters-title" className="flex flex-col">
      <h1 id="dead-letters-title" className="text-3xl font-bold text-heading">Dead letters</h1>
      <p className="mt-1 text-body">
        Work that ran out of attempts, and notes the sweep gave up on. Follow each one's trace to the cause, then mark it
        resolved. Resolving replays nothing.
      </p>
      <label className="mt-4 flex items-center gap-2 text-body">
        <input type="checkbox" checked={includeResolved} onChange={(e) => setIncludeResolved(e.target.checked)} />
        Show resolved
      </label>

      {load.state === 'loading' && <p role="status" className="mt-6 text-muted">Loading…</p>}
      {load.state === 'refused' && <p role="alert" className="mt-6 text-body">This page is for AlgoMinutes operators.</p>}
      {load.state === 'failed' && <p role="alert" className="mt-6 text-danger">{load.message}</p>}
      {load.state === 'loaded' && load.entries.length === 0 && (
        <p className="mt-6 text-body">Nothing is waiting{includeResolved ? '.' : ' to be reviewed.'}</p>
      )}
      {load.state === 'loaded' && load.entries.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-2xl border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="text-muted">
              <tr>
                <th className="p-3">When</th>
                <th className="p-3">Queue</th>
                <th className="p-3">Reason</th>
                <th className="p-3">Attempts</th>
                <th className="p-3">Note</th>
                <th className="p-3">Logs</th>
                <th className="p-3"><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {load.entries.map((e) => (
                <tr key={e.id} className="border-t border-border align-top">
                  <td className="p-3 whitespace-nowrap text-body">{new Date(e.createdAt).toLocaleString()}</td>
                  <td className="p-3 text-heading">{e.queue}</td>
                  <td className="p-3 text-body">{e.reason ?? e.error ?? ''}</td>
                  <td className="p-3 text-body">{e.attempts ?? ''}</td>
                  <td className="p-3 font-mono text-xs text-body">{e.noteId ?? ''}</td>
                  <td className="p-3 font-mono text-xs text-body">{e.traceId ? `jsonPayload.traceId="${e.traceId}"` : ''}</td>
                  <td className="p-3 whitespace-nowrap">
                    {e.resolvedAt ? (
                      <span className="text-muted">Resolved</span>
                    ) : (
                      <button type="button" className="rounded-lg border border-border px-3 py-1 text-heading" onClick={() => { setError(null); setConfirming(e); }}>
                        Mark resolved
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirming && (
        <Modal title="Mark this dead letter resolved?" onClose={() => !busy && setConfirming(null)}>
          <p className="text-body">
            Resolving replays nothing: it only marks the row. Resolve it once its cause is explained and its note is
            failed (the user can Try again) or ready.
          </p>
          {error && <p role="alert" className="mt-3 text-danger">{error}</p>}
          <div className="mt-4 flex gap-2">
            <button type="button" disabled={busy} className="rounded-xl bg-heading px-4 py-2 font-semibold text-bg" onClick={() => void resolve(confirming)}>
              Mark resolved
            </button>
            <button type="button" disabled={busy} className="rounded-xl border border-border px-4 py-2 text-heading" onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
