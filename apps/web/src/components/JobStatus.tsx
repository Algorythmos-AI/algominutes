import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import type { Note, NoteStatus } from '../types';

interface JobStatusProps {
  workspaceId: string;
  noteId: string;
}

const LABEL: Record<string, string> = {
  recording: 'Recording',
  processing: 'Processing',
  queued: 'Queued',
  chunking: 'Chunking audio',
  transcribing: 'Transcribing',
  summarizing: 'Summarizing',
  ready: 'Ready',
  error: 'Error',
};

const COLOR: Record<string, string> = {
  recording: '#FFFFFF',
  processing: '#FFFFFF',
  queued: '#8C8684',
  chunking: '#FFFFFF',
  transcribing: '#FFFFFF',
  summarizing: '#FFFFFF',
  ready: '#2EA043',
  error: '#D04040',
};

export default function JobStatus({ workspaceId, noteId }: JobStatusProps) {
  const [note, setNote] = useState<Note | null>(null);
  const [listenerFailed, setListenerFailed] = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, `workspaces/${workspaceId}/notes/${noteId}`),
      (snap) => {
        if (!snap.exists()) {
          setNote(null);
          return;
        }
        setNote({ id: snap.id, ...(snap.data() as any) });
      },
      (err) => {
        console.error('JobStatus subscription failed', err);
        // Rendering null here meant the processing screen showed a bouncing bot
        // and "Working on it" with the live feed dead and no way to tell.
        setListenerFailed(true);
      },
    );
    return () => unsub();
  }, [workspaceId, noteId]);

  if (listenerFailed) {
    return (
      <span style={{ color: '#8C8684', fontSize: '0.75rem', fontFamily: 'Titillium Web, sans-serif' }}>
        Live updates unavailable — reload to see the current status.
      </span>
    );
  }

  if (!note) return null;

  const status: NoteStatus = note.status as NoteStatus;
  const label = LABEL[status] || status;
  const color = COLOR[status] || '#8C8684';
  const animating = status !== 'ready' && status !== 'error';
  const progress = note.progress;

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 999,
        background: 'rgba(255,255,255, 0.08)',
        border: `1px solid ${color}33`,
        fontSize: 13,
        fontWeight: 500,
        color: '#3A3635',
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          background: color,
          animation: animating ? 'pulse 1.4s ease-in-out infinite' : undefined,
        }}
      />
      <span>{label}</span>
      {status === 'transcribing' && progress && progress.total > 0 && (
        <span style={{ color: '#8C8684' }}>
          {progress.done}/{progress.total}
        </span>
      )}
      {status === 'error' && note.errorMessage && (
        <span style={{ color: '#D04040', marginLeft: 6 }}>{note.errorMessage}</span>
      )}
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
    </div>
  );
}
