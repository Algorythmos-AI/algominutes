import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import type { z } from 'zod';
import type { SearchHit } from '@algominutes/contracts';
import type { ChatEvent } from '../../lib/api/client';
import { ApiError } from '../../lib/api/errors';
import { reportCrash } from '../../lib/crashReport';
import { displayTitle, formatClock } from '../../lib/notes/format';
import { useApi } from '../ApiContext';
import { useAuth } from '../auth/AuthContext';
import { useNotes } from '../notes/NotesContext';

type Hit = z.infer<typeof SearchHit>;
type Answer = { question: string; text: string; citations: Hit[]; status: 'streaming' | 'done' | 'stopped' | 'failed'; error?: string };

/** "[1] … [2]" in an answer → text and citation parts, so each [n] links to its source. */
export function splitCitations(text: string): Array<{ text: string } | { cite: number }> {
  const out: Array<{ text: string } | { cite: number }> = [];
  let last = 0;
  for (const m of text.matchAll(/\[(\d{1,2})\]/g)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index) });
    out.push({ cite: Number(m[1]) });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

type Mode = 'search' | 'ask';

/**
 * The page as the user left it, so opening a hit or a source and coming Back
 * finds the query, results and answers still there. In memory only (never
 * storage: it holds transcript text), for one user, and gone on reload.
 */
let kept: { uid: string; mode: Mode; query: string; hits: Hit[] | null; answers: Answer[] } | null = null;

/** Test hook: a fresh page. */
export function forgetSearchPage() {
  kept = null;
}

const hitLink = (h: Hit) => `/notes/${encodeURIComponent(h.noteId)}?t=${Math.max(0, Math.floor(h.startMs))}`;

/** Search every note, or ask them a question: parity with iOS's search and chat. */
export function SearchPage() {
  const { api } = useApi();
  const { user } = useAuth();
  const { visible } = useNotes();
  const uid = user?.uid ?? '';
  const [restored] = useState(() => (kept && kept.uid === uid ? kept : null));
  const [mode, setMode] = useState<Mode>(restored?.mode ?? 'search');
  const [query, setQuery] = useState(restored?.query ?? '');
  const [hits, setHits] = useState<Hit[] | null>(restored?.hits ?? null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // An answer still streaming when the page was left was stopped by leaving it.
  const [answers, setAnswers] = useState<Answer[]>(() => (restored?.answers ?? []).map((a) => (a.status === 'streaming' ? { ...a, status: 'stopped' } : a)));
  const [announce, setAnnounce] = useState('');
  const stop = useRef<AbortController | null>(null);

  useEffect(() => {
    kept = { uid, mode, query, hits, answers };
  }, [uid, mode, query, hits, answers]);
  // Leaving the page ends its answer: nothing keeps streaming (and costing) behind another page.
  useEffect(() => () => stop.current?.abort(), []);

  const titleOf = (h: Hit) => displayTitle(visible.find((n) => n.id === h.noteId)?.title ?? h.noteTitle);

  const search = async (q: string) => {
    setSearching(true);
    setSearchError(null);
    try {
      setHits((await api.search({ query: q, k: 12 })).hits);
    } catch (err) {
      setSearchError(err instanceof ApiError ? err.message : 'Search didn’t work. Try again.');
    } finally {
      setSearching(false);
    }
  };

  const ask = async (question: string) => {
    stop.current?.abort();
    const controller = new AbortController();
    stop.current = controller;
    const idx = answers.length;
    setAnswers((a) => [...a, { question, text: '', citations: [], status: 'streaming' }]);
    setAnnounce('');
    const patch = (fn: (a: Answer) => Answer) => setAnswers((list) => list.map((a, i) => (i === idx ? fn(a) : a)));
    try {
      for await (const ev of api.chat({ query: question }, controller.signal) as AsyncGenerator<ChatEvent>) {
        if (ev.type === 'citations') patch((a) => ({ ...a, citations: ev.hits }));
        else if (ev.type === 'text') patch((a) => ({ ...a, text: a.text + ev.text }));
        else if (ev.type === 'done') {
          patch((a) => ({ ...a, status: 'done' }));
          setAnnounce('Answer ready.');
        }
        else if (ev.type === 'error') {
          const error = ev.error === 'timeout' ? 'The answer took too long.' : 'The answer was cut short.';
          patch((a) => ({ ...a, status: 'failed', error }));
        }
      }
      // Stopped by the user: the stream ends quietly.
      patch((a) => (a.status === 'streaming' ? { ...a, status: controller.signal.aborted ? 'stopped' : 'done' } : a));
      if (controller.signal.aborted) setAnnounce('The answer was stopped.');
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'cancelled') {
        patch((a) => ({ ...a, status: 'stopped' }));
        setAnnounce('The answer was stopped.');
        return;
      }
      patch((a) => ({ ...a, status: 'failed', error: err instanceof ApiError ? err.message : 'The answer didn’t come through.' }));
      if (!(err instanceof ApiError)) reportCrash('chat.stream', err);
    } finally {
      if (stop.current === controller) stop.current = null;
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    if (mode === 'search') void search(q);
    else {
      setQuery('');
      void ask(q);
    }
  };

  const streaming = answers.some((a) => a.status === 'streaming');
  const tab = (m: Mode, label: string) => (
    <button
      type="button"
      role="tab"
      id={`tab-${m}`}
      aria-selected={mode === m}
      aria-controls={`panel-${m}`}
      tabIndex={mode === m ? 0 : -1}
      className={`rounded-lg px-3 py-2 ${mode === m ? 'bg-card text-heading' : 'text-body'}`}
      onClick={() => setMode(m)}
    >
      {label}
    </button>
  );
  // The tablist pattern: arrows move between the two tabs (and select them).
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next: Mode = mode === 'search' ? 'ask' : 'search';
    setMode(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  return (
    <section aria-labelledby="search-title" className="flex flex-col gap-6">
      <h1 id="search-title" className="text-3xl font-bold text-heading">Search</h1>
      <div role="tablist" aria-label="Search or ask" className="flex gap-1" onKeyDown={onTabKey}>
        {tab('search', 'Search transcripts')}
        {tab('ask', 'Ask your notes')}
      </div>

      <form onSubmit={submit} className="flex gap-2">
        <label className="sr-only" htmlFor="q">{mode === 'search' ? 'Search your notes' : 'Ask a question about your notes'}</label>
        <input
          id="q"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={mode === 'search' ? 'Search every transcript' : 'What did we decide about the launch?'}
          className="min-w-0 flex-1 rounded-xl border border-border bg-bg px-4 py-3 text-heading"
        />
        {mode === 'ask' && streaming ? (
          <button type="button" className="rounded-xl border border-border px-4 py-3" onClick={() => stop.current?.abort()}>Stop</button>
        ) : (
          <button type="submit" disabled={!query.trim() || searching} className="rounded-xl bg-accent px-4 py-3 font-semibold text-white disabled:opacity-60">
            {mode === 'search' ? 'Search' : 'Ask'}
          </button>
        )}
      </form>

      {mode === 'search' && (
        <div id="panel-search" role="tabpanel" aria-labelledby="tab-search" aria-live="polite">
          {searching && <p role="status" className="text-muted">Searching…</p>}
          {searchError && <p role="alert" className="text-body">{searchError}</p>}
          {hits && !searching && hits.length === 0 && <p className="text-muted">Nothing found. Try other words.</p>}
          {hits && hits.length > 0 && (
            <ul className="flex flex-col gap-3">
              {hits.map((h, i) => (
                <li key={`${h.noteId}-${h.startMs}-${i}`}>
                  <Link to={hitLink(h)} className="block rounded-2xl border border-border bg-card p-4 no-underline hover:bg-card-hover">
                    <span className="font-semibold text-heading">{titleOf(h)}</span> <span className="font-mono text-sm text-muted">{formatClock(h.startMs)}</span>
                    <p className="mt-1 text-body">{h.chunkText}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Announced once an answer ends, not on every word as it streams (a failure is its own alert). */}
      <p role="status" className="sr-only">{mode === 'ask' ? announce : ''}</p>
      {mode === 'ask' && (
        <div id="panel-ask" role="tabpanel" aria-labelledby="tab-ask">
        <ol className="flex flex-col gap-6">
          {answers.map((a, i) => (
            <li key={i} className="flex flex-col gap-2">
              <p className="self-end rounded-2xl bg-accent/20 px-4 py-2 text-heading">{a.question}</p>
              <div className="rounded-2xl border border-border bg-card p-4 text-body">
                {a.text ? (
                  <p className="whitespace-pre-line">
                    {splitCitations(a.text).map((part, j) => {
                      if ('text' in part) return <span key={j}>{part.text}</span>;
                      const h = a.citations[part.cite - 1];
                      return h ? (
                        <Link key={j} to={hitLink(h)} className="mx-0.5 rounded bg-accent/20 px-1 text-sm no-underline" aria-label={`Source ${part.cite}: ${titleOf(h)} at ${formatClock(h.startMs)}`}>
                          {part.cite}
                        </Link>
                      ) : (
                        <span key={j}>[{part.cite}]</span>
                      );
                    })}
                  </p>
                ) : (
                  a.status === 'streaming' && <p role="status" className="text-muted">Thinking…</p>
                )}
                {a.status === 'stopped' && <p className="mt-2 text-sm text-muted">Stopped.</p>}
                {a.status === 'failed' && (
                  <p role="alert" className="mt-2 text-sm">
                    {a.error}{' '}
                    <button type="button" className="underline" onClick={() => void ask(a.question)}>Try again</button>
                  </p>
                )}
                {a.citations.length > 0 && (
                  <div className="mt-3 border-t border-border pt-3">
                    <p className="text-xs font-semibold tracking-wide text-muted">SOURCES</p>
                    <ol className="mt-1 flex flex-col gap-1 text-sm">
                      {a.citations.map((h, j) => (
                        <li key={j}>
                          <Link to={hitLink(h)}>[{j + 1}] {titleOf(h)} · {formatClock(h.startMs)}</Link>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
        </div>
      )}
    </section>
  );
}
