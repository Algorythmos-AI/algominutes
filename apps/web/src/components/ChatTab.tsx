import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, User as UserIcon, FileText, ChevronLeft, Square } from 'lucide-react';
import { auth } from '../firebase';
import { apiUrl } from '../lib/apiUrl';
import { tryHandleEditCommand } from '../lib/noteCommands';
import type { Note } from '../types';

/**
 * `crypto.randomUUID` is undefined outside a secure context — plain HTTP on a
 * LAN address, which is a plausible demo or staging setup. Calling it there
 * threw before the try block, so sending any message simply did nothing and the
 * rejection went unhandled. These ids are React keys, not secrets.
 */
function messageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return messageId();
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Just above the chat function's own 120s ceiling. */
const STREAM_STALL_MS = 130_000;

const TRUNCATED_NOTICE =
  '_This answer was cut off before it finished — the connection dropped. '
  + 'Please ask again._';

interface Citation {
  noteId: string;
  noteTitle: string | null;
  chunkText: string;
  startMs: number;
  endMs: number;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** The stream ended without the server's terminal frame. */
  truncated?: boolean;
  citations?: Citation[];
  // Set when this message confirms a client-side edit command; drives the
  // "View note" shortcut so the user can jump to the record they just changed.
  editedNoteId?: string;
}

interface ChatTabProps {
  onOpenNote: (noteId: string, startMs?: number) => void;
  notes: Note[];
  onBack?: () => void;
}

const fmtTime = (ms: number) => {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
};

export default function ChatTab({ onOpenNote, notes, onBack }: ChatTabProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // The AbortController was assigned and nulled but .abort() was never called
  // anywhere in this file, so leaving the tab left the stream open and a hung
  // request disabled the send button until a page reload.
  useEffect(() => () => abortRef.current?.abort(), []);

  const titleFor = (id: string, fallback: string | null) =>
    notes.find((n) => n.id === id)?.title ?? fallback ?? 'Untitled';

  const sendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = input.trim();
    if (!q || streaming) return;
    if (!auth.currentUser) return;
    const uid = auth.currentUser.uid;

    const userMsg: ChatMessage = { id: messageId(), role: 'user', content: q };
    setInput('');

    // 1) Try to interpret the message as a direct edit command (rename, add
    //    action item, etc). These write straight to Firestore and never hit
    //    the RAG backend. A null result means "not a command" → fall through.
    try {
      const cmd = await tryHandleEditCommand(uid, q, notes);
      if (cmd) {
        setMessages((prev) => [
          ...prev,
          userMsg,
          { id: messageId(), role: 'assistant', content: cmd.reply, editedNoteId: cmd.noteId },
        ]);
        return;
      }
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        userMsg,
        {
          id: messageId(),
          role: 'assistant',
          content: `Sorry, I couldn't make that change: ${err?.message || 'unknown error'}`,
        },
      ]);
      return;
    }

    // 2) Otherwise, stream an answer from the RAG backend.
    const assistantId = messageId();
    const assistantMsg: ChatMessage = { id: assistantId, role: 'assistant', content: '' };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const idToken = await auth.currentUser.getIdToken();
      const resp = await fetch(apiUrl('/api/chat'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ query: q }),
        signal: controller.signal,
      });

      if (!resp.ok || !resp.body) {
        const data = await resp.json().catch(() => ({}));
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: data.error || `Chat failed (${resp.status})` } : m,
          ),
        );
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let citations: Citation[] | undefined;
      let answer = '';
      // Whether the server's terminal `event: done` frame ever arrived. Without
      // this a dropped connection ended the loop on `done` from the reader and
      // rendered a half-sentence answer as though it were complete.
      let sawTerminalFrame = false;

      // No byte for this long means the stream is dead rather than thinking.
      // The function's own ceiling is 120s, so this sits just above it.
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      const armStallTimer = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => controller.abort(new DOMException('stalled', 'TimeoutError')), STREAM_STALL_MS);
      };
      armStallTimer();

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          armStallTimer();
          buffer += decoder.decode(value, { stream: true });
          // Split on both framings. The server writes LF today, but this parser
          // is a second copy of the one in functions/search-and-chat.cjs, which
          // was already fixed for CRLF — and any proxy in between can rewrite
          // it. Framing on LF alone would silently drop every text chunk while
          // citations still rendered.
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const eventMatch = frame.match(/^event: (\w+)/m);
            const dataMatch = frame.match(/^data: (.*)$/m);
            if (!dataMatch) continue;
            let data: any;
            try {
              data = JSON.parse(dataMatch[1]);
            } catch {
              continue;
            }
            const eventName = eventMatch ? eventMatch[1] : 'message';
            if (eventName === 'citations' && Array.isArray(data.hits)) {
              citations = data.hits;
            } else if (eventName === 'done') {
              sawTerminalFrame = true;
            } else if (eventName === 'error') {
              sawTerminalFrame = true;
              answer += `\n\n_Error: ${data.error || 'unknown'}_`;
            } else if (typeof data.text === 'string') {
              answer += data.text;
            }
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: answer, citations } : m)),
            );
          }
        }
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
      }

      // Say so rather than letting a truncated answer pass as a whole one.
      // For a meeting question a half-answer read as complete is worse than
      // a visible failure.
      if (!sawTerminalFrame) {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId
            ? { ...m, content: `${answer}${answer ? '\n\n' : ''}${TRUNCATED_NOTICE}`, citations, truncated: true }
            : m)),
        );
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content: `Error: ${err?.message || 'unknown'}` } : m)),
        );
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const renderWithCitations = (text: string, citations?: Citation[]) => {
    if (!citations || citations.length === 0) return <span>{text}</span>;
    const parts = text.split(/(\[\d+\])/g);
    return (
      <>
        {parts.map((p, i) => {
          const m = p.match(/^\[(\d+)\]$/);
          if (!m) return <span key={i}>{p}</span>;
          const idx = Number(m[1]) - 1;
          const cite = citations[idx];
          if (!cite) return <span key={i}>{p}</span>;
          return (
            <button
              key={i}
              onClick={() => onOpenNote(cite.noteId, cite.startMs)}
              className="inline-flex items-center px-1.5 py-0.5 mx-0.5 rounded text-[0.7rem] font-bold align-baseline"
              style={{
                background: 'rgba(255,255,255,0.15)',
                border: '1px solid rgba(255,255,255,0.4)',
                color: '#FFFFFF',
                fontFamily: 'Rajdhani, sans-serif',
              }}
              title={`${titleFor(cite.noteId, cite.noteTitle)} @ ${fmtTime(cite.startMs)}`}
            >
              [{idx + 1}]
            </button>
          );
        })}
      </>
    );
  };

  return (
    <div className="flex flex-col h-full px-6 pt-12 pb-6 relative z-10">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to home"
          className="flex items-center gap-1 mb-3 -ml-2 px-2 py-1 rounded-md cursor-pointer self-start"
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
          marginBottom: '1rem',
        }}
      >
        Ask your meetings
      </h2>

      <div className="flex-1 overflow-y-auto space-y-4 pb-4">
        {messages.length === 0 && (
          <p style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.9rem' }}>
            I can answer questions across every meeting in your workspace and cite the moments I'm pulling from. Try "What did we agree to ship next quarter?" You can also edit records here — e.g. "rename my last note to Q3 kickoff" or "add an action item: email the deck".
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className="flex gap-3">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
              style={{
                background: m.role === 'user' ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.15)',
                border: '1px solid rgba(78,78,78,0.4)',
              }}
            >
              {m.role === 'user' ? <UserIcon size={14} color="#E5E0DF" /> : <Bot size={14} color="#FFFFFF" />}
            </div>
            <div className="flex-1 owll-card p-4">
              <p style={{ color: '#E5E0DF', lineHeight: 1.6, fontFamily: 'Titillium Web, sans-serif', fontSize: '0.9rem', whiteSpace: 'pre-wrap' }}>
                {renderWithCitations(m.content || (m.role === 'assistant' && streaming ? '…' : ''), m.citations)}
              </p>
              {m.editedNoteId && (
                <button
                  onClick={() => onOpenNote(m.editedNoteId!)}
                  className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold"
                  style={{ fontFamily: 'Rajdhani, sans-serif', background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.4)', color: '#FFFFFF' }}
                >
                  <FileText size={12} /> View note
                </button>
              )}
              {m.role === 'assistant' && m.citations && m.citations.length > 0 && (
                <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(78,78,78,0.3)' }}>
                  <p style={{ color: '#8C8684', fontSize: '0.7rem', fontFamily: 'Rajdhani, sans-serif', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.5rem' }}>
                    Sources
                  </p>
                  <div className="space-y-1.5">
                    {m.citations.map((cite, idx) => (
                      <button
                        key={`${cite.noteId}-${cite.startMs}-${idx}`}
                        onClick={() => onOpenNote(cite.noteId, cite.startMs)}
                        className="w-full text-left flex items-center gap-2 p-2 rounded hover:bg-white/5"
                      >
                        <FileText size={12} color="#FFFFFF" />
                        <span style={{ color: '#E5E0DF', fontSize: '0.78rem', fontFamily: 'Titillium Web, sans-serif' }}>
                          [{idx + 1}] {titleFor(cite.noteId, cite.noteTitle)} · {fmtTime(cite.startMs)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={sendMessage} className="owll-card p-3 flex items-center gap-2 mt-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question…"
          className="flex-1 bg-transparent outline-none"
          style={{ color: '#FFFFFF', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.95rem' }}
        />
        {streaming ? (
          // A hung stream used to leave the composer disabled with no way out
          // but a page reload.
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            aria-label="Stop generating"
            className="w-9 h-9 rounded-full flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg, #F2F7FF 0%, #DCEAFF 100%)',
              color: '#5B67F0',
            }}
          >
            <Square size={13} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            aria-label="Send"
            className="w-9 h-9 rounded-full flex items-center justify-center disabled:opacity-50"
            style={{
              background: 'linear-gradient(135deg, #F2F7FF 0%, #DCEAFF 100%)',
              color: '#5B67F0',
            }}
          >
            <Send size={16} aria-hidden="true" />
          </button>
        )}
      </form>
    </div>
  );
}
