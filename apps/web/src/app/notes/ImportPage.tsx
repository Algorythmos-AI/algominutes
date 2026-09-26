import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { importAudio, importProblem, probeDuration } from '../../lib/uploads/importAudio';
import { endedUpload, startedUpload } from '../../lib/uploads/ownUploads';
import { useApi } from '../ApiContext';
import { useAuth } from '../auth/AuthContext';
import { useNotes } from './NotesContext';

type Phase = { kind: 'idle' } | { kind: 'uploading'; name: string; fraction: number; sent: boolean } | { kind: 'failed'; message: string; noteId: string | null };

/** Import a recording: pick or drop an audio file; it uploads, then processes like one made in the app. */
export function ImportPage({ deps }: { deps?: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; probe?: (f: File) => Promise<number | null> } }) {
  const { api } = useApi();
  const { user } = useAuth();
  const { writer } = useNotes();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const uploading = phase.kind === 'uploading';

  // Leaving the page cancels the upload; and nothing navigates once the user has gone elsewhere.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);

  // While uploading: closing the tab asks first, and a file dropped outside the box doesn't open in the tab.
  useEffect(() => {
    if (!uploading) return;
    const beforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    const stray = (e: DragEvent) => e.preventDefault();
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('dragover', stray);
    window.addEventListener('drop', stray);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('dragover', stray);
      window.removeEventListener('drop', stray);
    };
  }, [uploading]);

  const start = async (file: File) => {
    if (!user || !writer) {
      setPhase({ kind: 'failed', message: 'Importing isn’t available right now. Reload the page and try again.', noteId: null });
      return;
    }
    const problem = importProblem(file);
    if (problem) {
      setPhase({ kind: 'failed', message: problem, noteId: null });
      return;
    }
    abort.current = new AbortController();
    setPhase({ kind: 'uploading', name: file.name, fraction: 0, sent: false });
    const result = await importAudio(file, {
      api,
      uid: user.uid,
      createNoteDoc: (n) => writer.createNoteDoc(n),
      markNoteFailed: (noteId, message) => writer.markNoteFailed(user.uid, noteId, message),
      probeDuration: deps?.probe ?? probeDuration,
      fetchImpl: deps?.fetchImpl,
      sleep: deps?.sleep,
      signal: abort.current.signal,
      track: { start: (id) => startedUpload(id), end: (id) => endedUpload(id) },
      onProgress: (fraction) => mounted.current && setPhase((p) => (p.kind === 'uploading' ? { ...p, fraction } : p)),
      onUploaded: () => mounted.current && setPhase((p) => (p.kind === 'uploading' ? { ...p, fraction: 1, sent: true } : p)),
    });
    abort.current = null;
    if (!mounted.current) return;
    if (result.ok) navigate(`/notes/${encodeURIComponent(result.noteId)}`);
    else setPhase({ kind: 'failed', message: result.message, noteId: result.noteId });
  };

  const pct = phase.kind === 'uploading' ? Math.round(phase.fraction * 100) : 0;
  return (
    <section aria-labelledby="imp-title" className="flex max-w-xl flex-col gap-4">
      <p><Link to="/">← Your notes</Link></p>
      <h1 id="imp-title" className="text-3xl font-bold text-heading">Import a recording</h1>
      <p className="text-body">
        Choose an audio file of a meeting (up to 500 MB). It's transcribed and summarised like a recording made in the app.
        Only import recordings everyone in them agreed to.
      </p>

      {phase.kind === 'uploading' ? (
        <div role="status" className="rounded-2xl border border-border bg-card p-4">
          <p className="text-heading">Uploading {phase.name}… {pct}%</p>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-bg" aria-hidden="true">
            <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          {phase.sent ? (
            <p className="mt-2 text-sm text-muted">Uploaded. Starting to process it…</p>
          ) : (
            <>
              <p className="mt-2 text-sm text-muted">Keep this page open until it's uploaded.</p>
              <button type="button" className="mt-3 rounded-lg border border-border px-3 py-2" onClick={() => abort.current?.abort()}>Cancel</button>
            </>
          )}
        </div>
      ) : (
        <label
          className={`flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed p-8 text-center ${dragging ? 'border-accent bg-accent/10' : 'border-border'}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) void start(f); }}
        >
          <span className="font-semibold text-heading">Choose a file, or drop it here</span>
          <span className="text-sm text-muted">M4A, MP3, WAV, FLAC, OGG, Opus or WebM audio</span>
          <input type="file" accept=".m4a,.mp4,.aac,.mp3,.wav,.flac,.ogg,.oga,.opus,.webm,audio/mp4,audio/mpeg,audio/wav,audio/flac,audio/ogg,audio/webm" className="sr-only" aria-label="Audio file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void start(f); e.target.value = ''; }} />
        </label>
      )}

      {phase.kind === 'failed' && (
        <p role="alert" className="rounded-2xl border border-danger/40 bg-danger/10 p-4 text-body">
          {phase.message}
          {phase.noteId && <> <Link to={`/notes/${encodeURIComponent(phase.noteId)}`}>Open the note</Link></>}
        </p>
      )}
    </section>
  );
}
