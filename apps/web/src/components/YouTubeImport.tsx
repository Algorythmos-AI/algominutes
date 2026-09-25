import React, { useState } from 'react';
import { Youtube, AlertCircle } from 'lucide-react';
import type { User } from 'firebase/auth';
import { collection, doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { authedFetch } from '../lib/authedFetch';
import { markNoteError } from '../lib/noteStatus';
import type { Note } from '../types';
import { readErrorText } from '../lib/http';

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

interface YouTubeImportProps {
  user: User;
  onCreated: (note: Note) => void;
}

function isYoutubeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return ALLOWED_HOSTS.has(u.host);
  } catch (_err) {
    // silent-catch-ok: a string that isn't a URL isn't a YouTube URL
    return false;
  }
}

export default function YouTubeImport({ user, onCreated }: YouTubeImportProps) {
  const [url, setUrl] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const sourceUrl = url.trim();
    if (!isYoutubeUrl(sourceUrl)) {
      setError('Paste a youtube.com or youtu.be URL.');
      return;
    }
    if (!agree) {
      setError('Confirm you have rights to import this content.');
      return;
    }
    setBusy(true);
    let noteRefForError: ReturnType<typeof doc> | null = null;
    try {
      const wsId = `workspace_${user.uid}`;
      const noteRef = doc(collection(db, `workspaces/${wsId}/notes`));
      noteRefForError = noteRef;
      const noteId = noteRef.id;
      const note: Partial<Note> = {
        id: noteId,
        title: 'YouTube import',
        authorId: user.uid,
        workspaceId: wsId,
        status: 'queued',
        type: 'youtube',
        sourceUrl,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await setDoc(noteRef, note);
      onCreated(note as Note);

      const resp = await authedFetch('/api/process-audio', {
        noteId,
        workspaceId: wsId,
        type: 'youtube',
        sourceUrl,
      });
      if (!resp.ok) {
        const txt = await readErrorText(resp);
        console.error('youtube kickoff failed', resp.status, txt);
        const msg = 'Could not queue this URL. Please try again.';
        setError(msg);
        await markNoteError(noteRef, msg).catch((mirrorErr) => console.error('kickoff_error_mirror_failed', mirrorErr));
      } else {
        setUrl('');
      }
    } catch (kickoffErr) {
      console.error('youtube kickoff error', kickoffErr);
      const msg = 'Could not queue this URL. Please try again.';
      setError(msg);
      if (noteRefForError) {
        await markNoteError(noteRefForError, msg).catch((mirrorErr) => console.error('kickoff_error_mirror_failed', mirrorErr));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="owll-card"
      style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <div>
        <div style={{ fontSize: 16, fontWeight: 600, color: '#3A3635', display: 'flex', gap: 8, alignItems: 'center' }}>
          <Youtube size={18} color="#D04040" /> Import from YouTube
        </div>
        <div style={{ fontSize: 13, color: '#8C8684' }}>
          Paste a public YouTube link. We extract the audio and run the same pipeline.
        </div>
      </div>

      <input
        type="url"
        placeholder="https://www.youtube.com/watch?v=…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        style={{
          padding: '10px 12px',
          borderRadius: 10,
          border: '1px solid #E5E0DF',
          fontSize: 14,
          outline: 'none',
        }}
        autoComplete="off"
        spellCheck={false}
      />

      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: '#5A5552' }}>
        <input
          type="checkbox"
          checked={agree}
          onChange={(e) => setAgree(e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>
          I have the rights to import this video for personal use, and I'll comply with YouTube's terms of service.
        </span>
      </label>

      <button
        type="submit"
        disabled={busy}
        className="owll-btn-primary"
        style={{
          padding: '12px 16px',
          borderRadius: 12,
          fontWeight: 600,
          fontSize: 14,
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? 'Queuing…' : 'Import'}
      </button>

      {error && (
        <div style={{ display: 'flex', gap: 8, fontSize: 12, color: '#D04040' }}>
          <AlertCircle size={14} /> {error}
        </div>
      )}
    </form>
  );
}
