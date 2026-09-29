import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError } from '../../lib/api/errors';
import { reportCrash } from '../../lib/crashReport';
import { useApi } from '../ApiContext';

// Send the notetaker to a meeting from a pasted link (RELEASE.md PR 24; docs/plans/MEETINGS.md; docs/CONSENT.md
// §2.4). Offered only while the server's switch is on for this user (/v1/config notetaker.bot: beta testers
// allowlisted until the legal opinion). The create contract has no consent field, so this page enforces the
// affirmation: nothing is sent until it's ticked, every time.

/** CONSENT.md §2.4's affirmation, word for word (the same as recording in the browser, §2.2). */
export const NOTETAKER_AFFIRMATION =
  'I have permission from anyone whose voice may be captured. If others are present, I’ll let them know the meeting is being recorded.';

const MEET = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[/?#].*)?$/i;

/** A Google Meet link as someone would paste it (with or without https://), normalised; null if it isn't one. */
export function meetLinkOf(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s.replace(/^http:\/\//i, 'https://') : `https://${s}`;
  return MEET.test(withScheme) ? withScheme : null;
}

/** The words for a refusal: the server's own sentence when it sent one. */
function refusalText(err: unknown): string {
  if (!(err instanceof ApiError)) return "The notetaker wasn't sent. Check your connection and try again.";
  const body = (err.body ?? {}) as { error?: unknown; message?: unknown };
  if (err.status === 402) return typeof body.message === 'string' ? body.message : "You've used this month's notetaker minutes.";
  // Sentences, not codes (the api's notetaker routes answer in words).
  if (typeof body.error === 'string' && /\s/.test(body.error)) return body.error;
  return err.message;
}

type Available = 'checking' | 'on' | 'off';

export function NotetakerPage() {
  const { api } = useApi();
  const navigate = useNavigate();
  const [available, setAvailable] = useState<Available>('checking');
  const [link, setLink] = useState('');
  const [title, setTitle] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One request id per meeting sent: a retry after a dropped answer returns the same notetaker, never a second.
  const requestId = useRef<{ link: string; id: string } | null>(null);

  useEffect(() => {
    let live = true;
    api.appConfig().then(
      (c) => live && setAvailable(c.notetaker?.bot ? 'on' : 'off'),
      (err: unknown) => {
        if (!live) return;
        setAvailable('off');
        reportCrash('notetaker.appConfig', err);
      },
    );
    return () => {
      live = false;
    };
  }, [api]);

  const meetingUrl = meetLinkOf(link);
  const send = async () => {
    if (!meetingUrl || !agreed || busy) return;
    setBusy(true);
    setError(null);
    if (!requestId.current || requestId.current.link !== meetingUrl) requestId.current = { link: meetingUrl, id: crypto.randomUUID() };
    try {
      const bot = await api.createMeetingBot({ meetingUrl, requestId: requestId.current.id, ...(title.trim() ? { title: title.trim() } : {}) });
      navigate(`/notes/${encodeURIComponent(bot.noteId)}`);
    } catch (err) {
      const body = (err instanceof ApiError ? err.body : null) as { noteId?: unknown } | null;
      // Already on its way to this meeting: that note is the one to watch.
      if (err instanceof ApiError && err.status === 409 && typeof body?.noteId === 'string') {
        navigate(`/notes/${encodeURIComponent(body.noteId)}`);
        return;
      }
      setError(refusalText(err));
      if (!(err instanceof ApiError)) reportCrash('notetaker.create', err);
    } finally {
      setBusy(false);
    }
  };

  if (available === 'checking') return <p role="status" className="text-muted">Loading…</p>;
  if (available === 'off') {
    return (
      <section aria-labelledby="nt-title">
        <h1 id="nt-title" className="mb-2 text-3xl font-bold text-heading">Send the notetaker</h1>
        <p className="text-body">The notetaker isn’t available to you yet. <Link to="/">Back to your notes</Link></p>
      </section>
    );
  }

  return (
    <section aria-labelledby="nt-title" className="flex max-w-xl flex-col gap-5">
      <div>
        <p className="mb-2"><Link to="/">← Your notes</Link></p>
        <h1 id="nt-title" className="text-3xl font-bold text-heading">Send the notetaker</h1>
        <p className="mt-1 text-muted">
          It joins your Google Meet as your notetaker, posts a notice to everyone, and leaves a note with who said what.{' '}
          <a href="/notetaker" target="_blank" rel="noreferrer">How the notetaker works</a>
        </p>
      </div>
      {/* noValidate: the page checks the link itself (meetLinkOf), and a link pasted without https:// is fine,
          which the browser's own url check would refuse. */}
      <form noValidate className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label className="text-body">
          Meeting link
          <input
            name="meetingUrl" type="url" inputMode="url" autoComplete="off" placeholder="https://meet.google.com/abc-defg-hij"
            value={link} onChange={(e) => setLink(e.target.value)} aria-invalid={link.trim() !== '' && !meetingUrl}
            className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-heading"
          />
        </label>
        {link.trim() !== '' && !meetingUrl && <p className="text-danger">Paste a Google Meet link, like https://meet.google.com/abc-defg-hij.</p>}
        <label className="text-body">
          Title <span className="text-muted">(optional)</span>
          <input name="title" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-heading" />
        </label>
        <label className="flex items-start gap-3 text-body">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1" />
          <span>{NOTETAKER_AFFIRMATION}</span>
        </label>
        <p className="text-sm text-muted">The meeting’s audio is processed by Recall.ai in Tokyo, then deleted there once your note has it.</p>
        {error && <p role="alert" className="text-danger">{error}</p>}
        <button type="submit" disabled={!meetingUrl || !agreed || busy} className="rounded-xl bg-accent px-4 py-3 font-semibold text-white disabled:opacity-50">
          {busy ? 'Sending…' : 'Send the notetaker'}
        </button>
      </form>
    </section>
  );
}
