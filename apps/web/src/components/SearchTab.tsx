import React, { useState } from 'react';
import { Search, FileText, ChevronLeft } from 'lucide-react';
import { auth } from '../firebase';
import { authedFetch } from '../lib/authedFetch';
import { SearchResponseSchema, safeParse } from '../lib/apiSchemas';
import type { Note } from '../types';

interface SearchHit {
  noteId: string;
  noteTitle: string | null;
  chunkText: string;
  startMs: number;
  endMs: number;
  score: number;
  source: 'vector' | 'keyword' | 'fused';
}

interface SearchTabProps {
  onOpenNote: (noteId: string) => void;
  notes: Note[];
  onBack?: () => void;
}

const fmtTime = (ms: number) => {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
};

export default function SearchTab({ onOpenNote, notes, onBack }: SearchTabProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noteTitleFor = (id: string, fallback: string | null) =>
    notes.find((n) => n.id === id)?.title ?? fallback ?? 'Untitled note';

  const runSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!query.trim() || loading) return;
    if (!auth.currentUser) {
      setError('Please sign in.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const resp = await authedFetch('/api/search', { query: query.trim(), k: 12 });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        setError(data.error || `Search failed (${resp.status})`);
        setHits([]);
        return;
      }
      // Validated, not cast. `Array.isArray(data.hits)` was the only guard, so
      // a hit whose chunkText came back null threw inside render — at
      // `hit.chunkText.length` — and the root error boundary replaced the whole
      // app, including an in-progress recording.
      const parsed = safeParse(SearchResponseSchema, await resp.json(), 'search');
      if (!parsed) {
        setError('Search returned something unexpected. Please try again.');
        setHits([]);
        return;
      }
      setHits(parsed.hits);
    } catch (err: any) {
      // A user-initiated abort is not an error worth showing.
      if (err?.name === 'AbortError') return;
      setError(
        err?.name === 'TimeoutError'
          ? 'Search took too long. Please try again.'
          : err?.message || 'Search failed',
      );
      setHits([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="px-6 pt-12 pb-6 relative z-10">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to home"
          className="flex items-center gap-1 mb-3 -ml-2 px-2 py-1 rounded-md cursor-pointer"
          style={{ color: '#FFFFFF', background: 'transparent', border: 'none', fontFamily: 'Rajdhani, sans-serif', fontSize: '0.9rem', fontWeight: 600 }}
        >
          <ChevronLeft size={20} />
          Back
        </button>
      )}
      <h2
        style={{
          fontFamily: 'Rajdhani, sans-serif',
          fontWeight: 700,
          fontSize: '1.35rem',
          color: '#FFFFFF',
          marginBottom: '1.25rem',
        }}
      >
        Search your meetings
      </h2>

      <form onSubmit={runSearch} className="owll-card p-3 flex items-center gap-2 mb-5">
        <Search size={18} color="#FFFFFF" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Ask "What did we decide about pricing?"'
          className="flex-1 bg-transparent outline-none"
          style={{ color: '#FFFFFF', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.95rem' }}
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="px-3 py-1.5 rounded-lg text-xs font-bold disabled:opacity-50"
          style={{
            fontFamily: 'Rajdhani, sans-serif',
            background: 'rgba(255,255,255,0.15)',
            border: '1px solid rgba(255,255,255,0.45)',
            color: '#FFFFFF',
          }}
        >
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {error && (
        <div
          className="owll-card p-4 mb-4"
          style={{ borderColor: 'rgba(239,68,68,0.4)', color: '#EF4444', fontSize: '0.85rem' }}
        >
          {error}
        </div>
      )}

      {hits.length === 0 && !loading && !error && (
        <p style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.9rem' }}>
          Search across every meeting in your workspace. Results are timestamped — click a hit to jump straight to the moment in the recording.
        </p>
      )}

      <div className="space-y-3">
        {hits.map((hit, i) => (
          <button
            key={`${hit.noteId}-${hit.startMs}-${i}`}
            onClick={() => onOpenNote(hit.noteId)}
            className="w-full owll-card p-4 text-left"
          >
            <div className="flex items-center gap-2 mb-1">
              <FileText size={14} color="#FFFFFF" />
              <span
                style={{
                  fontFamily: 'Rajdhani, sans-serif',
                  fontWeight: 700,
                  fontSize: '0.85rem',
                  color: '#FFFFFF',
                }}
              >
                {noteTitleFor(hit.noteId, hit.noteTitle)}
              </span>
              <span
                style={{
                  marginLeft: 'auto',
                  color: '#8C8684',
                  fontSize: '0.7rem',
                  fontFamily: 'Titillium Web, sans-serif',
                }}
              >
                {fmtTime(hit.startMs)} · {hit.source}
              </span>
            </div>
            <p
              style={{
                color: '#E5E0DF',
                fontSize: '0.85rem',
                lineHeight: 1.5,
                fontFamily: 'Titillium Web, sans-serif',
              }}
            >
              {hit.chunkText.length > 240 ? `${hit.chunkText.slice(0, 240)}…` : hit.chunkText}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}
