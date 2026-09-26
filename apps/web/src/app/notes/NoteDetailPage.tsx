import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { NoteReadResponse, TranscriptLine } from '@algominutes/contracts';
import { ApiError } from '../../lib/api/errors';
import { reportCrash } from '../../lib/crashReport';
import { displayTitle, formatClock, formatDate, formatDuration, statusOf } from '../../lib/notes/format';
import { workspaceIdFor } from '../../lib/notes/workspace';
import { isSlow } from '../../lib/noteWatchdog';
import { useApi } from '../ApiContext';
import { useAuth } from '../auth/AuthContext';
import { useNotice } from '../Notice';
import { useNow } from '../useNow';
import { Modal } from '../Modal';
import type { NoteDoc } from '../../lib/notes/notesFeed';
import { useNotes } from './NotesContext';
import { NoteTools } from './NoteTools';

type Load = { status: 'loading' } | { status: 'ready'; data: NoteReadResponse } | { status: 'gone' } | { status: 'error'; message: string };

export function NoteDetailPage() {
  const { noteId = '' } = useParams();
  // Keyed on the note, so moving to another note starts from a clean slate.
  return <NoteDetail key={noteId} noteId={noteId} />;
}

function NoteDetail({ noteId }: { noteId: string }) {
  const { user } = useAuth();
  const { api } = useApi();
  const { state, visible, hide, unhide } = useNotes();
  const notice = useNotice();
  const navigate = useNavigate();
  const workspaceId = user ? workspaceIdFor(user.uid) : '';
  // A search hit or a chat citation links here at its moment (?t=<ms>).
  const [params] = useSearchParams();
  const startAt = Number(params.get('t'));
  const jumpTo = Number.isFinite(startAt) && startAt > 0 ? startAt : null;
  // `visible`: a note being deleted is already gone from here, as from the list.
  const live = visible.find((n) => n.id === noteId);
  const ready = live?.status === 'ready';
  // A scanned note is complete on the device and lives only in Firestore (as on iOS): nothing to read from the api.
  const firestoreOnly = live?.type === 'scan_text';

  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Bumped after an edit: the page re-reads the note, keeping what it shows until the answer arrives.
  const [version, setVersion] = useState(0);
  const [renaming, setRenaming] = useState<{ tag: number; name: string } | null>(null);

  // Each first-page read is a generation: a "show more" answer from an older one is dropped.
  const generation = useRef(0);

  // The note's content comes from the api (Postgres), once it's ready.
  useEffect(() => {
    if (!ready || firestoreOnly || !workspaceId) return;
    let cancelled = false;
    api
      .readNote({ noteId, workspaceId })
      .then((data) => {
        if (cancelled) return;
        generation.current += 1;
        setLoad({ status: 'ready', data });
        setLines(data.transcript.lines);
        setCursor(data.transcript.nextCursor);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.kind === 'not_found') setLoad({ status: 'gone' });
        else setLoad({ status: 'error', message: err instanceof ApiError ? err.message : "This note couldn't be loaded." });
      });
    return () => {
      cancelled = true;
    };
  }, [api, noteId, workspaceId, ready, firestoreOnly, version]);

  const loadMore = async () => {
    if (!cursor) return;
    const gen = generation.current;
    setMoreBusy(true);
    try {
      const page = await api.readNotePage({ noteId, workspaceId, cursor });
      if (gen !== generation.current) return; // the note was re-read meanwhile; its first page replaced these
      setLines((l) => [...l, ...page.transcript.lines]);
      setCursor(page.transcript.nextCursor);
    } catch (err) {
      notice.show(err instanceof ApiError ? err.message : "The rest of the transcript couldn't be loaded.");
    } finally {
      setMoreBusy(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    hide(noteId);
    navigate('/');
    try {
      await api.deleteNote({ noteId, workspaceId });
      notice.show('Note deleted.');
    } catch (err) {
      // Already gone (a retry, or deleted elsewhere) is what was asked for.
      if (err instanceof ApiError && err.kind === 'not_found') {
        notice.show('Note deleted.');
        return;
      }
      unhide(noteId);
      notice.show(err instanceof ApiError ? `The note wasn't deleted. ${err.message}` : "The note wasn't deleted. Try again.");
      reportCrash('notes.delete', err);
    }
  };

  const renameSpeaker = async (tag: number, name: string) => {
    setRenaming(null);
    try {
      await api.setSpeakers(noteId, { workspaceId, speakerTag: tag, name });
      setLines((ls) => ls.map((l) => (l.speakerTag === tag ? { ...l, speaker: name } : l)));
      notice.show('Speaker renamed.');
    } catch (err) {
      notice.show(err instanceof ApiError ? `The speaker wasn't renamed. ${err.message}` : "The speaker wasn't renamed.");
    }
  };

  const [audioRef, audio] = useAudio(noteId, workspaceId);
  const now = useNow();

  if (state.status === 'loading') return <p role="status" className="text-muted">Loading…</p>;
  if (state.status === 'error') {
    return <p role="alert" className="text-body">Your notes couldn't be loaded. Check your connection; this page retries on its own.</p>;
  }
  if (!live) {
    return (
      <section aria-labelledby="nd-title">
        <h1 id="nd-title" className="mb-2 text-3xl font-bold text-heading">This note isn't available</h1>
        <p className="text-muted">It may have been deleted. <Link to="/">Back to your notes</Link></p>
      </section>
    );
  }

  const s = statusOf(live.status);
  const meta = [formatDate(live.createdAt), formatDuration(live.duration)].filter(Boolean).join(' · ');
  const data = load.status === 'ready' ? load.data : null;
  // Read from the doc when the api has no copy: a scanned note, or an older note that never reached Postgres.
  const fromDoc = ready && (firestoreOnly || load.status === 'gone');

  return (
    <article aria-labelledby="nd-title" className="flex flex-col gap-8">
      <header>
        <p className="mb-2"><Link to="/">← Your notes</Link></p>
        <h1 id="nd-title" className="text-3xl font-bold text-heading">{displayTitle(data?.note.title ?? live.title)}</h1>
        {meta && <p className="mt-1 text-muted">{meta}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          {ready && live.storagePath && (
            <button type="button" className="rounded-lg border border-border px-3 py-2" onClick={() => void audio.start()} disabled={audio.busy}>
              {audio.src ? 'Playing below' : 'Play recording'}
            </button>
          )}
          {ready && live.storagePath && jumpTo != null && (
            <button type="button" className="rounded-lg border border-accent px-3 py-2 text-heading" onClick={() => void audio.seek(jumpTo)} disabled={audio.busy}>
              Play from {formatClock(jumpTo)}
            </button>
          )}
          <button type="button" className="rounded-lg border border-danger/60 px-3 py-2 text-danger" onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        </div>
        {ready && data && (
          <div className="mt-2">
            <NoteTools noteId={noteId} workspaceId={workspaceId} title={displayTitle(data.note.title ?? live.title)} summary={data.summary} reload={() => setVersion((v) => v + 1)} />
          </div>
        )}
        {audio.src && (
          <audio ref={audioRef} src={audio.src} controls autoPlay={audio.autoPlay} className="mt-4 w-full" onError={() => void audio.onError()}>
            Your browser can't play this recording.
          </audio>
        )}
        {audio.error && <p role="alert" className="mt-2 text-danger">{audio.error}</p>}
      </header>

      {s.kind === 'working' && (
        <p role="status" className="rounded-2xl border border-border bg-card p-4 text-body">
          {isSlow(live, now)
            ? 'This is taking longer than usual. It will finish on its own, or show an error if it can’t.'
            : `${s.label}${live.progress && live.progress.total > 1 ? ` (${live.progress.done} of ${live.progress.total} parts)` : ''}… You can leave this page; it updates on its own.`}
        </p>
      )}
      {s.kind === 'failed' && (
        <p role="alert" className="rounded-2xl border border-danger/40 bg-danger/10 p-4 text-body">
          {live.errorMessage || 'This recording couldn’t be processed.'} It didn’t use any of your minutes.
        </p>
      )}

      {ready && !fromDoc && load.status === 'loading' && <p role="status" className="text-muted">Loading the summary…</p>}
      {load.status === 'error' && <p role="alert" className="text-body">{load.message}</p>}
      {fromDoc && <DocView note={live} />}

      {data?.summary && (
        <>
          <section aria-labelledby="sum-title">
            <h2 id="sum-title" className="mb-2 text-xl font-bold text-heading">Summary</h2>
            <p className="whitespace-pre-line text-body">{data.summary.gist}</p>
          </section>
          {data.summary.actionItems.length > 0 && (
            <section aria-labelledby="ai-title">
              <h2 id="ai-title" className="mb-2 text-xl font-bold text-heading">Action items</h2>
              <ul className="list-disc pl-6 text-body">
                {data.summary.actionItems.map((a) => (
                  <li key={String(a.id)}>
                    {a.text}
                    {a.assigneeName && <span className="text-muted"> ({a.assigneeName})</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.summary.keyDecisions.length > 0 && (
            <section aria-labelledby="kd-title">
              <h2 id="kd-title" className="mb-2 text-xl font-bold text-heading">Key decisions</h2>
              <ul className="list-disc pl-6 text-body">
                {data.summary.keyDecisions.map((d) => <li key={String(d.id)}>{d.text}</li>)}
              </ul>
            </section>
          )}
          {data.summary.chapters.length > 0 && (
            <section aria-labelledby="ch-title">
              <h2 id="ch-title" className="mb-2 text-xl font-bold text-heading">Chapters</h2>
              <ol className="flex flex-col gap-2">
                {data.summary.chapters.map((c) => (
                  <li key={c.startMs}>
                    <button type="button" className="text-left" onClick={() => void audio.seek(c.startMs)}>
                      <span className="font-mono text-muted">{formatClock(c.startMs)}</span> <span className="font-semibold text-heading">{c.title}</span>
                    </button>
                    <p className="text-sm text-body">{c.summary}</p>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </>
      )}

      {data && (
        <section aria-labelledby="tr-title">
          <h2 id="tr-title" className="mb-2 text-xl font-bold text-heading">Transcript</h2>
          {lines.length === 0 ? (
            <p className="text-muted">No transcript.</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {lines.map((l) => (
                <li key={l.id} className="text-body">
                  <button type="button" className="font-mono text-sm text-muted" onClick={() => void audio.seek(l.startMs)} aria-label={`Play from ${formatClock(l.startMs)}`}>
                    {formatClock(l.startMs)}
                  </button>{' '}
                  {l.speaker && l.speakerTag != null ? (
                    <button type="button" className="font-semibold text-heading" title="Rename this speaker" onClick={() => setRenaming({ tag: l.speakerTag!, name: l.speaker! })}>
                      {l.speaker}:
                    </button>
                  ) : (
                    l.speaker && <span className="font-semibold text-heading">{l.speaker}:</span>
                  )}{' '}
                  {l.text}
                </li>
              ))}
            </ol>
          )}
          {cursor && (
            <button type="button" className="mt-4 rounded-lg border border-border px-3 py-2" disabled={moreBusy} onClick={() => void loadMore()}>
              {moreBusy ? 'Loading…' : 'Show more of the transcript'}
            </button>
          )}
          {data.redaction?.applied && <p className="mt-4 text-sm text-muted">Card numbers and similar identifiers are hidden in transcripts.</p>}
        </section>
      )}

      {renaming && (
        <Modal title="Rename speaker" onClose={() => setRenaming(null)} initialFocus="input">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = String(new FormData(e.currentTarget).get('name') ?? '').trim();
              if (name) void renameSpeaker(renaming.tag, name);
            }}
          >
            <p className="mb-3 text-body">Every line by “{renaming.name}” in this note takes the new name.</p>
            <label className="block text-body">
              Name
              <input name="name" defaultValue={renaming.name} maxLength={80} className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-heading" />
            </label>
            <div className="mt-4 flex gap-2">
              <button type="submit" className="rounded-xl bg-accent px-4 py-2 font-semibold text-white">Save</button>
              <button type="button" className="px-4 py-2 text-muted" onClick={() => setRenaming(null)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}

      {confirmDelete && (
        <Modal title="Delete this note?" onClose={() => setConfirmDelete(false)} initialFocus="[data-cancel]">
          <p className="mb-4 text-body">Its recording, transcript and summary are deleted for good.</p>
          <div className="flex flex-col gap-2">
            <button type="button" className="rounded-xl bg-danger px-4 py-3 font-semibold text-white" onClick={() => void remove()}>Delete note</button>
            <button type="button" data-cancel className="py-2 text-muted" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        </Modal>
      )}
    </article>
  );
}

/** A note the api has no copy of, shown from its Firestore doc, as iOS shows it. */
function DocView({ note }: { note: NoteDoc }) {
  const sum = note.summary;
  return (
    <>
      {sum?.gist && (
        <section aria-labelledby="dsum-title">
          <h2 id="dsum-title" className="mb-2 text-xl font-bold text-heading">Summary</h2>
          <p className="whitespace-pre-line text-body">{sum.gist}</p>
        </section>
      )}
      {!!sum?.actionItems.length && (
        <section aria-labelledby="dai-title">
          <h2 id="dai-title" className="mb-2 text-xl font-bold text-heading">Action items</h2>
          <ul className="list-disc pl-6 text-body">{sum.actionItems.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </section>
      )}
      {!!sum?.keyDecisions.length && (
        <section aria-labelledby="dkd-title">
          <h2 id="dkd-title" className="mb-2 text-xl font-bold text-heading">Key decisions</h2>
          <ul className="list-disc pl-6 text-body">{sum.keyDecisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </section>
      )}
      {note.rawText && (
        <section aria-labelledby="dtext-title">
          <h2 id="dtext-title" className="mb-2 text-xl font-bold text-heading">Text</h2>
          <p className="whitespace-pre-line text-body">{note.rawText}</p>
        </section>
      )}
      {!!note.transcript?.length && (
        <section aria-labelledby="dtr-title">
          <h2 id="dtr-title" className="mb-2 text-xl font-bold text-heading">Transcript</h2>
          <ol className="flex flex-col gap-3">
            {note.transcript.map((l, i) => (
              <li key={i} className="text-body">
                <span className="font-mono text-sm text-muted">{l.time}</span> {l.speaker && <span className="font-semibold text-heading">{l.speaker}:</span>} {l.text}
              </li>
            ))}
          </ol>
          {note.transcriptTruncated && <p className="mt-3 text-sm text-muted">Only the start of the transcript is shown here.</p>}
        </section>
      )}
    </>
  );
}

/**
 * The recording, from a short-lived signed URL (/v1/notes/audio-url). When it
 * expires mid-listen the player errors; one fresh URL is fetched and playback
 * resumes where it was.
 */
function useAudio(noteId: string, workspaceId: string) {
  const { api } = useApi();
  const ref = useRef<HTMLAudioElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [autoPlay, setAutoPlay] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One refetch per URL: reset once the new URL plays, so a long listen survives every expiry.
  const refreshed = useRef(false);
  const inFlight = useRef(false);
  const pendingSeek = useRef<number | null>(null);

  const fetchUrl = useCallback(async () => {
    const { url } = await api.noteAudioUrl({ noteId, workspaceId });
    return url;
  }, [api, noteId, workspaceId]);

  const start = useCallback(async () => {
    if (src || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      setSrc(await fetchUrl());
    } catch (err) {
      pendingSeek.current = null; // a later Play starts from the beginning, not an old chapter
      setError(err instanceof ApiError ? err.message : "The recording couldn't be loaded.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [src, fetchUrl]);

  const seek = useCallback(
    async (ms: number) => {
      if (!src) {
        pendingSeek.current = ms / 1000;
        await start();
        return;
      }
      if (ref.current) {
        ref.current.currentTime = ms / 1000;
        void ref.current.play().catch((err) => reportCrash('audio.play', err));
      }
    },
    [src, start],
  );

  // Apply a seek asked for before this URL loaded; and once it plays, it may be refreshed again later.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      if (pendingSeek.current == null) return;
      el.currentTime = pendingSeek.current;
      pendingSeek.current = null;
    };
    const playing = () => {
      refreshed.current = false;
    };
    el.addEventListener('loadedmetadata', apply);
    el.addEventListener('playing', playing);
    return () => {
      el.removeEventListener('loadedmetadata', apply);
      el.removeEventListener('playing', playing);
    };
  }, [src]);

  const onError = useCallback(async () => {
    if (refreshed.current) {
      setError("The recording couldn't be played.");
      return;
    }
    refreshed.current = true;
    const el = ref.current;
    pendingSeek.current = el?.currentTime ?? 0;
    // Resume only if it was playing: a paused listen stays paused on the fresh URL.
    setAutoPlay(el ? !el.paused : true);
    try {
      setSrc(await fetchUrl());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The recording couldn't be played.");
    }
  }, [fetchUrl]);

  return [ref, { src, autoPlay, busy, error, start, seek, onError }] as const;
}
