import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate } from 'react-router';
import { maxRecordingSecondsForPlan, type PlanId } from '@algominutes/contracts';
import { reportCrash } from '../../lib/crashReport';
import { formatClock, formatDate } from '../../lib/notes/format';
import { extensionFor, pickMimeType, startRecording, type ActiveRecording } from '../../lib/recorder/recorder';
import type { RecordingMeta, RecordingStore } from '../../lib/recorder/store';
import { importAudio } from '../../lib/uploads/importAudio';
import { endedUpload, startedUpload } from '../../lib/uploads/ownUploads';
import { useApi } from '../ApiContext';
import { useAuth } from '../auth/AuthContext';
import { Modal } from '../Modal';
import { useNotes } from '../notes/NotesContext';
import { recorderEnv } from './env';

export interface RecorderEnv {
  store: RecordingStore;
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
  Recorder?: typeof MediaRecorder;
  isTypeSupported?: (t: string) => boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

type Phase =
  | { kind: 'consent' }
  | { kind: 'starting' }
  | { kind: 'denied' }
  | { kind: 'unsupported' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'saving'; fraction: number }
  | { kind: 'failed'; message: string };

const WARN_BEFORE_CAP_S = 5 * 60;

/** Holds the screen awake while recording (a sleeping laptop stops the microphone), where the browser can. */
function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const acquire = () =>
      navigator.wakeLock.request('screen').then(
        (l) => {
          lock = l;
        },
        (err: unknown) => reportCrash('record.wakeLock', err),
      );
    void acquire();
    // A lock is released when the tab is hidden; take it again on return.
    const onVisible = () => document.visibilityState === 'visible' && void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch((err: unknown) => reportCrash('record.wakeLockRelease', err));
    };
  }, [active]);
}

/** Record a meeting in the browser: consent first, as on iOS; the audio is kept safe as it's made, then uploaded. */
export function RecordPage({ env = recorderEnv() }: { env?: RecorderEnv }) {
  const { user } = useAuth();
  const { api } = useApi();
  const { writer } = useNotes();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>({ kind: 'consent' });
  const [agreed, setAgreed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [capSeconds, setCapSeconds] = useState(() => maxRecordingSecondsForPlan());
  const active = useRef<ActiveRecording | null>(null);
  const recording = phase.kind === 'recording';

  useWakeLock(recording);
  // Leaving the page inside the app while recording would leave the microphone on with no Stop: ask first.
  const blocker = useBlocker(recording);

  // The plan's per-recording cap (the default until the plan is known).
  useEffect(() => {
    api.entitlement().then(
      (e) => setCapSeconds(maxRecordingSecondsForPlan(e.plan as PlanId)),
      (err: unknown) => reportCrash('record.entitlement', err),
    );
  }, [api]);

  // The clock, and a guard before the tab closes mid-recording.
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    const beforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      clearInterval(t);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [recording]);

  const upload = useCallback(
    async (meta: RecordingMeta) => {
      if (!user || !writer) return;
      const blob = await env.store.blob(meta.id);
      if (!blob || blob.size === 0) {
        await env.store.remove(meta.id);
        setPhase({ kind: 'failed', message: 'That recording has no audio.' });
        return;
      }
      setPhase({ kind: 'saving', fraction: 0 });
      const file = new File([blob], `recording.${extensionFor(meta.mimeType)}`, { type: meta.mimeType });
      const result = await importAudio(file, {
        api,
        uid: user.uid,
        recording: { title: `Recording ${formatDate(new Date(meta.startedAt).toISOString())}` },
        createNoteDoc: (n) => writer.createNoteDoc(n),
        markNoteFailed: (noteId, message) => writer.markNoteFailed(user.uid, noteId, message),
        probeDuration: async () => (meta.seconds > 0 ? meta.seconds : null),
        track: { start: startedUpload, end: endedUpload },
        fetchImpl: env.fetchImpl,
        sleep: env.sleep,
        onProgress: (fraction) => setPhase((p) => (p.kind === 'saving' ? { ...p, fraction } : p)),
      });
      if (result.ok) {
        // Uploaded and handed to the server: this browser's copy goes, as iOS removes its own.
        await env.store.remove(meta.id);
        navigate(`/notes/${encodeURIComponent(result.noteId)}`);
      } else {
        setPhase({ kind: 'failed', message: `${result.message} Your recording is still saved in this browser.` });
      }
    },
    [api, env, navigate, user, writer],
  );

  const stop = useCallback(async () => {
    const rec = active.current;
    if (!rec || !user) return;
    active.current = null;
    await rec.stop();
    const meta = (await env.store.list(user.uid)).find((r) => r.id === rec.id);
    if (meta) await upload(meta);
  }, [env.store, upload, user]);

  // The cap: stop on its own at the plan's limit.
  const elapsed = recording ? Math.max(0, (now - phase.startedAt) / 1000) : 0;
  useEffect(() => {
    if (recording && elapsed >= capSeconds) void stop();
  }, [recording, elapsed, capSeconds, stop]);

  const start = async () => {
    if (!user) return;
    const mimeType = pickMimeType(env.isTypeSupported);
    if (!mimeType || !env.getUserMedia) {
      setPhase({ kind: 'unsupported' });
      return;
    }
    setPhase({ kind: 'starting' });
    let stream: MediaStream;
    try {
      stream = await env.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      setPhase({ kind: (err as { name?: string })?.name === 'NotAllowedError' ? 'denied' : 'unsupported' });
      return;
    }
    // Keep what's recorded even when storage runs short (best effort; the browser may say no).
    void navigator.storage?.persist?.().catch((err: unknown) => reportCrash('record.persist', err));
    try {
      active.current = await startRecording({
        id: `rec${crypto.randomUUID().replace(/-/g, '')}`,
        uid: user.uid,
        stream,
        store: env.store,
        mimeType,
        Recorder: env.Recorder,
        onStoreError: (err) => {
          reportCrash('record.store', err);
          void stop();
        },
      });
      setNow(Date.now());
      setPhase({ kind: 'recording', startedAt: Date.now() });
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      reportCrash('record.start', err);
      setPhase({ kind: 'failed', message: 'Recording couldn’t start. Reload the page and try again.' });
    }
  };

  const left = capSeconds - elapsed;
  return (
    <section aria-labelledby="rec-title" className="flex max-w-xl flex-col gap-4">
      <p><Link to="/">← Your notes</Link></p>
      <h1 id="rec-title" className="text-3xl font-bold text-heading">Record a meeting</h1>
      <RecoveredRecordings env={env} busy={recording || phase.kind === 'saving'} onUpload={upload} />

      {phase.kind === 'consent' && (
        <div className="rounded-2xl border border-border bg-card p-5">
          <h2 className="mb-2 text-xl font-bold text-heading">Before you record</h2>
          <p className="text-body">
            AlgoMinutes records audio from this device for as long as you're recording. The audio is uploaded, then transcribed and summarised by Google Cloud's speech and AI services, and kept in your account until you delete it.
          </p>
          <label className="mt-4 flex gap-2 text-body">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            I have permission from anyone whose voice may be captured. If others are present, I'll let them know the meeting is being recorded.
          </label>
          <button type="button" disabled={!agreed} onClick={() => void start()} className="mt-4 rounded-xl bg-accent px-5 py-3 font-semibold text-white disabled:opacity-50">
            {agreed ? 'Start recording' : 'Tick the box to start'}
          </button>
          <p className="mt-3 text-sm text-muted">Your browser will ask to use the microphone.</p>
        </div>
      )}

      {phase.kind === 'starting' && <p role="status" className="text-muted">Starting the microphone…</p>}
      {phase.kind === 'denied' && (
        <p role="alert" className="rounded-2xl border border-border bg-card p-4 text-body">
          AlgoMinutes can’t use the microphone. Allow it for this site in your browser’s settings (the icon beside the address), then reload the page.
        </p>
      )}
      {phase.kind === 'unsupported' && (
        <p role="alert" className="rounded-2xl border border-border bg-card p-4 text-body">
          This browser can’t record here. Try a current version of Chrome, Edge, Firefox or Safari, or record in the AlgoMinutes app.
        </p>
      )}

      {recording && (
        <div role="status" className="rounded-2xl border border-danger/50 bg-card p-5 text-center">
          <p className="text-sm font-semibold tracking-wide text-danger">● RECORDING</p>
          <p className="mt-2 font-mono text-5xl text-heading" aria-label={`Recorded ${formatClock(elapsed * 1000)}`}>{formatClock(elapsed * 1000)}</p>
          {left <= WARN_BEFORE_CAP_S && <p className="mt-2 text-body">{formatClock(left * 1000)} left: recording stops on its own at {formatClock(capSeconds * 1000)}.</p>}
          <p className="mt-2 text-sm text-muted">Keep this tab open. Everything recorded is saved in this browser as you go.</p>
          <button type="button" onClick={() => void stop()} className="mt-4 rounded-xl bg-danger px-6 py-3 font-semibold text-white">Stop and save</button>
        </div>
      )}

      {blocker.state === 'blocked' && (
        <Modal title="You’re recording" onClose={() => blocker.reset()} initialFocus="[data-keep]">
          <p className="text-body">Stop and save the recording before you leave this page?</p>
          <div className="mt-4 flex flex-col gap-2">
            <button type="button" className="rounded-xl bg-danger px-4 py-3 font-semibold text-white" onClick={() => { blocker.reset(); void stop(); }}>Stop and save</button>
            <button type="button" data-keep className="py-2 text-muted" onClick={() => blocker.reset()}>Keep recording</button>
          </div>
        </Modal>
      )}

      {phase.kind === 'saving' && (
        <p role="status" className="rounded-2xl border border-border bg-card p-4 text-heading">Uploading your recording… {Math.round(phase.fraction * 100)}%</p>
      )}
      {phase.kind === 'failed' && <p role="alert" className="rounded-2xl border border-danger/40 bg-danger/10 p-4 text-body">{phase.message}</p>}
    </section>
  );
}

/** Recordings left on this browser (a closed tab, a failed upload): upload them, or discard them. */
function RecoveredRecordings({ env, busy, onUpload }: { env: RecorderEnv; busy: boolean; onUpload: (m: RecordingMeta) => Promise<void> }) {
  const { user } = useAuth();
  const [left, setLeft] = useState<RecordingMeta[]>([]);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!user || busy) return;
    let cancelled = false;
    env.store.list(user.uid).then(
      (l) => !cancelled && setLeft(l),
      (err: unknown) => reportCrash('record.listLeft', err),
    );
    return () => {
      cancelled = true;
    };
  }, [env.store, user, busy, version]);
  if (busy || left.length === 0) return null;
  return (
    <div className="rounded-2xl border border-warning/50 bg-warning/10 p-4">
      <p className="font-semibold text-heading">{left.length === 1 ? 'A recording wasn’t uploaded' : `${left.length} recordings weren’t uploaded`}</p>
      <ul className="mt-2 flex flex-col gap-2">
        {left.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 text-body">
            <span>{formatDate(new Date(r.startedAt).toISOString())} · {formatClock(r.seconds * 1000)}{r.stoppedAt ? '' : ' (cut off)'}</span>
            <button type="button" className="rounded-lg bg-accent px-3 py-1 text-sm font-semibold text-white" onClick={() => void onUpload(r)}>Upload it</button>
            <button type="button" className="rounded-lg border border-border px-3 py-1 text-sm" onClick={() => void env.store.remove(r.id).then(() => setVersion((v) => v + 1), (err: unknown) => reportCrash('record.discard', err))}>Discard</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
