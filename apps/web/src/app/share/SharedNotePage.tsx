import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import type { SharedNoteResponse } from '@algominutes/contracts';
import { ApiError } from '../../lib/api/errors';
import { displayTitle, formatClock, formatDate } from '../../lib/notes/format';
import { useApi } from '../ApiContext';
import { SITE_URL } from '../site';

type Load = { status: 'loading' } | { status: 'ready'; data: SharedNoteResponse } | { status: 'gone' } | { status: 'error' };

/**
 * A note someone shared (/v1/shares/read, public: no sign-in). Built but off,
 * as on iOS (SHARE_LINKS_ENABLED=NO): nothing links here until sharing is
 * turned on, and the public site serves /s/<token> meanwhile. A share that
 * expired, was revoked or never existed reads the same way, so a guess
 * learns nothing.
 */
export function SharedNotePage() {
  const { token = '' } = useParams();
  const { api } = useApi();
  const [load, setLoad] = useState<Load>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api.readShare({ token }).then(
      (data) => !cancelled && setLoad({ status: 'ready', data }),
      (err: unknown) => !cancelled && setLoad({ status: err instanceof ApiError && (err.kind === 'not_found' || err.kind === 'bad_request') ? 'gone' : 'error' }),
    );
    return () => {
      cancelled = true;
    };
  }, [api, token]);

  const shell = (children: React.ReactNode) => (
    <main id="main" className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
      <p className="text-sm text-muted">Shared from <a href={SITE_URL}>AlgoMinutes</a></p>
      {children}
    </main>
  );

  if (load.status === 'loading') return shell(<p role="status" className="text-muted">Loading…</p>);
  if (load.status === 'gone') {
    return shell(
      <section aria-labelledby="sh-title">
        <h1 id="sh-title" className="text-3xl font-bold text-heading">This shared note isn't available</h1>
        <p className="mt-2 text-muted">The link may have expired or been turned off by the person who shared it.</p>
      </section>,
    );
  }
  if (load.status === 'error') return shell(<p role="alert" className="text-body">This shared note couldn't be loaded. Try again in a moment.</p>);

  const { note, summary, transcript, expiresAt } = load.data;
  return shell(
    <article aria-labelledby="sh-title" className="flex flex-col gap-6">
      <header>
        <h1 id="sh-title" className="text-3xl font-bold text-heading">{displayTitle(note.title)}</h1>
        <p className="mt-1 text-muted">{formatDate(note.createdAt)} · shared until {formatDate(expiresAt)}</p>
      </header>
      {summary?.gist && (
        <section aria-labelledby="sh-sum">
          <h2 id="sh-sum" className="mb-2 text-xl font-bold text-heading">Summary</h2>
          <p className="whitespace-pre-line text-body">{summary.gist}</p>
        </section>
      )}
      {!!summary?.actionItems.length && (
        <section aria-labelledby="sh-ai">
          <h2 id="sh-ai" className="mb-2 text-xl font-bold text-heading">Action items</h2>
          <ul className="list-disc pl-6 text-body">{summary.actionItems.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </section>
      )}
      {!!summary?.keyDecisions.length && (
        <section aria-labelledby="sh-kd">
          <h2 id="sh-kd" className="mb-2 text-xl font-bold text-heading">Key decisions</h2>
          <ul className="list-disc pl-6 text-body">{summary.keyDecisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </section>
      )}
      {transcript && transcript.lines.length > 0 && (
        <section aria-labelledby="sh-tr">
          <h2 id="sh-tr" className="mb-2 text-xl font-bold text-heading">Transcript</h2>
          <ol className="flex flex-col gap-3">
            {transcript.lines.map((l) => (
              <li key={l.id} className="text-body">
                {l.startMs != null && <span className="font-mono text-sm text-muted">{formatClock(l.startMs)}</span>} {l.speakerName && <span className="font-semibold text-heading">{l.speakerName}:</span>} {l.text}
              </li>
            ))}
          </ol>
          {transcript.truncated && <p className="mt-3 text-sm text-muted">Only part of the transcript was shared.</p>}
        </section>
      )}
    </article>,
  );
}
