import React, { useRef, useState } from 'react';
import { Upload, X, AlertCircle } from 'lucide-react';
import type { User } from 'firebase/auth';
import { collection, doc, setDoc } from 'firebase/firestore';
import { ref, uploadBytesResumable } from 'firebase/storage';
import { db, storage } from '../firebase';
import { authedFetch } from '../lib/authedFetch';
import { markNoteError } from '../lib/noteStatus';
import type { Note } from '../types';

const SOFT_WARN_BYTES = 100 * 1024 * 1024;
const HARD_LIMIT_BYTES = 500 * 1024 * 1024;
// No bytes for this long means the transfer is dead rather than slow. Generous,
// because a laptop changing networks goes quiet for a while and still recovers.
const STALL_MS = 120_000;
const STALL_CHECK_MS = 15_000;

interface ImportPanelProps {
  user: User;
  onCreated: (note: Note) => void;
  onCancel: () => void;
}

export default function ImportPanel({ user, onCreated, onCancel }: ImportPanelProps) {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  // Set while an upload is in flight so the user can stop a large one they
  // started by mistake. There was previously no way to abort.
  const [cancelUpload, setCancelUpload] = useState<(() => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handlePick = () => {
    setError(null);
    setWarn(null);
    fileInputRef.current?.click();
  };

  const onFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    if (file.size === 0) {
      setError('That file is empty. Please choose a different one.');
      return;
    }
    if (file.size >= HARD_LIMIT_BYTES) {
      setError(`That file is ${(file.size / 1024 / 1024).toFixed(0)} MB. The current limit is 500 MB.`);
      return;
    }
    if (file.size >= SOFT_WARN_BYTES) {
      setWarn(`Heads up — ${(file.size / 1024 / 1024).toFixed(0)} MB will take a while to upload and process.`);
    }

    const wsId = `workspace_${user.uid}`;
    const noteRef = doc(collection(db, `workspaces/${wsId}/notes`));
    const noteId = noteRef.id;
    const ext = filenameExt(file.name) || mimeExt(file.type) || 'bin';
    const storagePath = `imports/${wsId}/${noteId}.${ext}`;

    const note: Partial<Note> = {
      id: noteId,
      title: file.name.replace(/\.[^.]+$/, '') || 'Imported audio',
      authorId: user.uid,
      workspaceId: wsId,
      status: 'queued',
      type: 'import_audio',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      storagePath,
      mimeType: file.type || 'audio/mpeg',
    };
    await setDoc(noteRef, note);
    onCreated(note as Note);

    const sRef = ref(storage, storagePath);
    const markKickoffError = async (message: string) => {
      setError(message);
      try {
        await markNoteError(noteRef, message);
      } catch (mirrorErr) {
        console.error('kickoff_error_mirror_failed', mirrorErr);
      }
    };
    const uploadTask = uploadBytesResumable(sRef, file, { contentType: file.type || 'audio/mpeg' });
    setCancelUpload(() => () => uploadTask.cancel());

    // Stall watchdog. The recording path has had one; this one did not, so a
    // 400 MB import that stopped moving at 60% on hospital wifi sat there
    // indefinitely — and because the note is already written as `queued`, it
    // stayed queued forever too, with no cancel and no error.
    //
    // Keyed on bytes moving rather than elapsed time: a legitimately slow
    // upload of a large file must not be killed for being slow.
    let lastMovedAt = Date.now();
    let lastBytes = 0;
    const stallCheck = setInterval(() => {
      if (Date.now() - lastMovedAt >= STALL_MS) {
        clearInterval(stallCheck);
        uploadTask.cancel();
      }
    }, STALL_CHECK_MS);
    const stopWatching = () => { clearInterval(stallCheck); setCancelUpload(null); };

    uploadTask.on(
      'state_changed',
      (snap) => {
        if (snap.bytesTransferred !== lastBytes) {
          lastBytes = snap.bytesTransferred;
          lastMovedAt = Date.now();
        }
        // totalBytes is 0 for an empty file, which rendered "NaN%" and a
        // NaN-width progress bar.
        setProgress(snap.totalBytes > 0
          ? Math.round((snap.bytesTransferred / snap.totalBytes) * 100)
          : 0);
      },
      (uploadErr) => {
        stopWatching();
        console.error('import upload failed', uploadErr);
        setProgress(null);
        const code = (uploadErr as { code?: string })?.code;
        // storage/unauthorized is the generic rules rejection — an expired
        // token or a wrong content type produce it too — so it was wrong to
        // report every one of them as a size problem. Only claim that when the
        // file actually is over the limit.
        const msg = code === 'storage/canceled'
          ? 'Upload stopped because the connection dropped. Please try again.'
          : code === 'storage/unauthorized' && file.size >= HARD_LIMIT_BYTES
            ? 'That file is too large. The current limit is 500 MB.'
            : 'Upload failed. Please check your connection and try again.';
        setError(msg);
        setDoc(noteRef, { status: 'error', errorMessage: msg, updatedAt: new Date().toISOString() }, { merge: true })
          .catch((mirrorErr) => console.error('upload_error_mirror_failed', mirrorErr));
      },
      async () => {
        stopWatching();
        setProgress(null);
        try {
          const resp = await authedFetch('/api/process-audio', {
            noteId,
            workspaceId: wsId,
            type: 'import_audio',
            storagePath,
            mimeType: file.type || 'audio/mpeg',
          });
          if (!resp.ok) {
            const txt = await resp.text().catch(() => '');
            console.error('process-audio kickoff failed', resp.status, txt);
            await markKickoffError('Could not queue your file. Please try again.');
          }
        } catch (kickoffErr) {
          console.error('kickoff fetch error', kickoffErr);
          await markKickoffError('Could not queue your file. Please try again.');
        }
      },
    );
  };

  return (
    <div className="owll-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#3A3635' }}>Import audio</div>
          <div style={{ fontSize: 13, color: '#8C8684' }}>mp3, m4a, wav, flac. Up to 500 MB.</div>
        </div>
        <button
          onClick={onCancel}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#8C8684' }}
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,video/*"
        style={{ display: 'none' }}
        onChange={onFileSelected}
      />

      <button
        onClick={handlePick}
        className="owll-btn-primary"
        style={{
          padding: '12px 16px',
          borderRadius: 12,
          fontWeight: 600,
          fontSize: 14,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        <Upload size={16} /> Choose file
      </button>

      {progress !== null && (
        <div>
          <div style={{ fontSize: 12, color: '#8C8684', marginBottom: 4 }}>Uploading… {progress}%</div>
          <div style={{ height: 6, background: '#EDE9E8', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${progress}%`, height: '100%', background: '#FFFFFF' }} />
          </div>
          {cancelUpload && (
            <button
              onClick={() => cancelUpload()}
              style={{
                marginTop: 8, background: 'transparent', border: 'none', padding: 0,
                cursor: 'pointer', color: '#8C8684', fontSize: 12, textDecoration: 'underline',
              }}
            >
              Cancel upload
            </button>
          )}
        </div>
      )}

      {warn && (
        <div style={{ display: 'flex', gap: 8, fontSize: 12, color: '#8C5E00' }}>
          <AlertCircle size={14} /> {warn}
        </div>
      )}
      {error && (
        <div style={{ display: 'flex', gap: 8, fontSize: 12, color: '#D04040' }}>
          <AlertCircle size={14} /> {error}
        </div>
      )}
    </div>
  );
}

function filenameExt(name: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

function mimeExt(mime: string): string {
  if (!mime) return '';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('flac')) return 'flac';
  if (mime.includes('webm')) return 'webm';
  return '';
}
