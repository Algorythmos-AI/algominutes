import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { SharedNoteSchema, safeParse } from '../lib/apiSchemas';
import type { SharedNoteData } from '../lib/apiSchemas';
import { apiUrl } from '../lib/apiUrl';

/**
 * Read-only view of a note opened through a share link.
 *
 * Rendered BEFORE the auth gate in App.tsx — the whole point is that the
 * reader is not signed in and never will be. It fetches by token and shows
 * whatever the server decides to return; every access decision is the
 * server's, so there is nothing here to bypass.
 *
 * Deliberately minimal: no audio player, no chat, no export. Anything richer
 * would need a second unauthenticated surface, and one is enough.
 */

// Derived from the schema rather than written twice. The hand-written copy said
// `lines: SharedLine[]` while claiming fields the server may omit — two
// descriptions of one payload is how they drift apart.

const page: CSSProperties = {
  minHeight: '100vh',
  background: '#030303',
  color: '#e7e7e7',
  fontFamily: 'Titillium Web, sans-serif',
  padding: '32px 20px 64px',
};
const shell: CSSProperties = { maxWidth: 760, margin: '0 auto' };
const card: CSSProperties = {
  background: '#101010',
  border: '1px solid #232323',
  borderRadius: 14,
  padding: 20,
  marginBottom: 16,
};
const heading: CSSProperties = {
  fontSize: 13,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: '#8b8b8b',
  marginBottom: 10,
};
const muted: CSSProperties = { color: '#8b8b8b', fontSize: 13 };

function formatTime(ms: number | null): string {
  if (ms === null || ms === undefined) return '';
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function SharedNote({ token }: { token: string }) {
  const [state, setState] = useState<'loading' | 'ok' | 'gone' | 'busy' | 'error'>('loading');
  const [data, setData] = useState<SharedNoteData | null>(null);

  // A10: a shared note must never be indexed. This page-level robots meta is the
  // host-agnostic control (Google honours it); robots.txt Disallow, the vercel.json
  // X-Robots-Tag header on /s/**, and the API's no-store + X-Robots-Tag on the data
  // response are the additional layers.
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(apiUrl('/api/shared-note'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;
        // 404 covers expired, revoked, deleted and never-existed — the server
        // does not distinguish them, and neither should this copy.
        if (resp.status === 404) return setState('gone');
        if (resp.status === 429) return setState('busy');
        if (!resp.ok) return setState('error');
        // Validated rather than cast. `data.summary.actionItems.length` in
        // render throws if the field is absent, and this page has no error
        // boundary of its own — it renders before the auth gate.
        const parsed = safeParse(SharedNoteSchema, await resp.json(), 'shared-note');
        if (!parsed) return setState('error');
        setData(parsed);
        setState('ok');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  if (state === 'loading') {
    return <div style={page}><div style={shell}><p style={muted}>Opening the note…</p></div></div>;
  }

  if (state === 'gone') {
    return (
      <div style={page}>
        <div style={shell}>
          <h1 style={{ fontSize: 22, marginBottom: 10 }}>This link isn&rsquo;t available</h1>
          <p style={muted}>
            It may have expired, been revoked by the person who shared it, or the note may
            have been deleted. Ask them for a new link.
          </p>
        </div>
      </div>
    );
  }

  if (state === 'busy') {
    return (
      <div style={page}>
        <div style={shell}>
          <h1 style={{ fontSize: 22, marginBottom: 10 }}>Too many requests</h1>
          <p style={muted}>This link has been opened a lot recently. Try again shortly.</p>
        </div>
      </div>
    );
  }

  if (state === 'error' || !data) {
    return (
      <div style={page}>
        <div style={shell}>
          <h1 style={{ fontSize: 22, marginBottom: 10 }}>Something went wrong</h1>
          <p style={muted}>The note couldn&rsquo;t be loaded. Try again in a moment.</p>
        </div>
      </div>
    );
  }

  const expires = new Date(data.expiresAt);

  return (
    <div style={page}>
      <div style={shell}>
        <p style={{ ...muted, marginBottom: 6 }}>Shared from AlgoMinutes</p>
        {/* Some notes have no title — a public page must not render a blank
            heading, so it falls back rather than showing nothing. */}
        <h1 style={{ fontSize: 26, marginBottom: 6 }}>{data.note.title || 'Untitled note'}</h1>
        <p style={{ ...muted, marginBottom: 24 }}>
          {new Date(data.note.createdAt).toLocaleDateString()} &middot; link expires{' '}
          {expires.toLocaleDateString()}
        </p>

        {data.summary && (
          <>
            <div style={card}>
              <div style={heading}>Summary</div>
              <p style={{ lineHeight: 1.6 }}>{data.summary.gist || 'No summary.'}</p>
            </div>
            {data.summary.actionItems.length > 0 && (
              <div style={card}>
                <div style={heading}>Action items</div>
                <ul style={{ paddingLeft: 18, lineHeight: 1.7 }}>
                  {data.summary.actionItems.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </div>
            )}
            {data.summary.keyDecisions.length > 0 && (
              <div style={card}>
                <div style={heading}>Key decisions</div>
                <ul style={{ paddingLeft: 18, lineHeight: 1.7 }}>
                  {data.summary.keyDecisions.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </div>
            )}
          </>
        )}

        {data.transcript && (
          <div style={card}>
            <div style={heading}>Transcript</div>
            {data.transcript.lines.map((l) => (
              <div key={l.id} style={{ marginBottom: 10 }}>
                <span style={{ ...muted, marginRight: 8 }}>{formatTime(l.startMs)}</span>
                {l.speakerName && (
                  <span style={{ color: '#cfcfcf', marginRight: 6 }}>{l.speakerName}</span>
                )}
                <span style={{ lineHeight: 1.6 }}>{l.text}</span>
              </div>
            ))}
            {data.transcript.truncated && (
              <p style={{ ...muted, marginTop: 12 }}>
                This transcript is longer than a shared page shows. Ask the sender for the
                full export.
              </p>
            )}
          </div>
        )}

        {/* Transcripts are scrubbed before storage and again on the way out,
            so a reader may see masked spans. Saying so prevents it reading as
            a transcription error. */}
        <p style={{ ...muted, marginTop: 24, lineHeight: 1.6 }}>
          Detected card numbers, IDs and contact details are masked. AlgoMinutes never stored
          the originals. This page is read-only and is not indexed by search engines.
        </p>
      </div>
    </div>
  );
}
