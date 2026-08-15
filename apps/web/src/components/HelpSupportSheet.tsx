import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { LifeBuoy, X, CheckCircle2, Loader2 } from 'lucide-react';
import { submitSupport, type SupportKind, APP_VERSION } from '../lib/compliance';

interface Props {
  open: boolean;
  onClose: () => void;
  // Pre-selects the form intent. 'bad_summary' / 'bad_transcript' arrive from the
  // note view's "report" control; 'contact' is the default from Help & support.
  initialKind?: SupportKind;
  // Reference only — attached so we can locate the note. Never carries content.
  noteId?: string;
}

const FAQ: { q: string; a: string }[] = [
  {
    q: 'How accurate are the transcripts and summaries?',
    a: 'They are AI-generated and can contain mistakes. Always verify anything you rely on. If a summary or transcript is wrong, use “Report an issue” on the note so we can improve it.',
  },
  {
    q: 'Do I need to tell people I am recording?',
    a: 'Yes. You may only record conversations you are entitled to record, and you must obtain consent where your jurisdiction requires it.',
  },
  {
    q: 'How long are my notes kept?',
    a: 'By default notes are kept until you delete them. You can set an automatic retention window (30, 90, 180 or 365 days) in Settings.',
  },
  {
    q: 'How do I delete my account?',
    a: 'Settings → Delete my account, or visit /delete-account. Deletion is permanent and removes every recording, transcript, and summary.',
  },
  {
    q: 'Is my content used to train AI models?',
    a: 'No. Your content is processed only to operate the service for you (transcription, summarization, search) and is not used to train general AI models.',
  },
];

const KIND_TITLE: Record<SupportKind, string> = {
  contact: 'Contact support',
  bad_summary: 'Report a bad summary',
  bad_transcript: 'Report a bad transcript',
};

const KIND_PLACEHOLDER: Record<SupportKind, string> = {
  contact: 'Describe the problem or question. Do not paste sensitive content — we already have the diagnostic details we need.',
  bad_summary: 'What was wrong with the summary? (Please don’t paste the summary itself — we attach only a reference to this note.)',
  bad_transcript: 'What was wrong with the transcript? (Please don’t paste the transcript itself — we attach only a reference to this note.)',
};

/**
 * A10 #4 — Help/FAQ + contact/support surface.
 *
 * The contact form attaches DIAGNOSTIC context only (app version, browser UA,
 * platform, and an optional note id for reference). It never sends transcript,
 * summary, or audio content — there is no field for it and the copy steers the
 * user away from pasting it. Doubles as the "report bad summary/transcript"
 * form when opened with initialKind from the note view.
 */
export default function HelpSupportSheet({ open, onClose, initialKind = 'contact', noteId }: Props) {
  const [kind, setKind] = useState<SupportKind>(initialKind);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);

  // Reset to the requested intent each time the sheet is opened.
  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setMessage('');
      setError(null);
      setSentId(null);
      setBusy(false);
    }
  }, [open, initialKind]);

  const handleSubmit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await submitSupport({ kind, message, noteId });
      setSentId(id || 'sent');
    } catch (err) {
      setError((err as Error)?.message || 'Could not send your message. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const isReport = kind === 'bad_summary' || kind === 'bad_transcript';

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-end justify-center"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
          onClick={onClose}
        >
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            className="w-full max-w-md rounded-t-3xl p-6 space-y-5 max-h-[90vh] overflow-y-auto"
            style={{
              background: 'linear-gradient(175deg,#131313,#050505)',
              border: '1px solid rgba(78,78,78,0.45)',
              borderBottom: 'none',
              paddingBottom: 'calc(2rem + env(safe-area-inset-bottom, 0px))',
            }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Help and support"
          >
            <div className="w-10 h-1 rounded-full mx-auto" style={{ background: 'rgba(255,255,255,0.16)' }} />

            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.35)' }}>
                  <LifeBuoy size={20} color="#FFFFFF" />
                </div>
                <h2 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, color: '#FFFFFF', fontSize: '1.15rem' }}>
                  {isReport ? KIND_TITLE[kind] : 'Help & support'}
                </h2>
              </div>
              <button onClick={onClose} aria-label="Close" className="p-2 rounded-xl hover:bg-white/5 transition-colors" style={{ color: '#8C8684' }}>
                <X size={20} />
              </button>
            </div>

            {sentId ? (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <CheckCircle2 size={40} color="#4ADE80" />
                <p style={{ color: '#FFFFFF', fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, fontSize: '1.05rem' }}>
                  Thanks — we got it.
                </p>
                <p style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.85rem' }}>
                  {sentId !== 'sent' ? `Reference: ${sentId}` : 'Your message has been sent.'}
                </p>
                <button
                  onClick={onClose}
                  className="mt-2 px-6 py-2.5 rounded-2xl text-sm font-bold"
                  style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(78,78,78,0.45)', color: '#FFFFFF', fontFamily: 'Rajdhani, sans-serif' }}
                >
                  Done
                </button>
              </div>
            ) : (
              <>
                {/* Static FAQ — only in the general "contact" entry, not the report flow. */}
                {!isReport && (
                  <div className="space-y-3">
                    {FAQ.map((item) => (
                      <details key={item.q} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(78,78,78,0.35)', borderRadius: '0.9rem', padding: '0.75rem 0.9rem' }}>
                        <summary style={{ color: '#E5E0DF', fontFamily: 'Rajdhani, sans-serif', fontWeight: 600, fontSize: '0.92rem', cursor: 'pointer' }}>
                          {item.q}
                        </summary>
                        <p style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.85rem', lineHeight: 1.55, marginTop: '0.5rem' }}>
                          {item.a}
                        </p>
                      </details>
                    ))}
                  </div>
                )}

                <div className="space-y-2">
                  <label style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.8rem', display: 'block' }}>
                    {isReport ? KIND_TITLE[kind] : 'Message'}
                  </label>
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    disabled={busy}
                    rows={4}
                    maxLength={4000}
                    placeholder={KIND_PLACEHOLDER[kind]}
                    aria-label={KIND_TITLE[kind]}
                    className="w-full px-4 py-3 rounded-2xl text-sm"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(78,78,78,0.45)', color: '#FFFFFF', fontFamily: 'Titillium Web, sans-serif', resize: 'vertical' }}
                  />
                  <p style={{ color: '#5C5856', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.72rem', lineHeight: 1.5 }}>
                    We attach only diagnostic details (app v{APP_VERSION}, your browser, and{' '}
                    {noteId ? 'a reference to this note' : 'no note reference'}). We never send your
                    recordings, transcripts, or summaries.
                  </p>
                </div>

                {error && (
                  <p role="alert" style={{ color: '#FCA5A5', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.82rem' }}>
                    {error}
                  </p>
                )}

                <button
                  onClick={handleSubmit}
                  disabled={busy}
                  className="w-full py-3.5 rounded-2xl text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-60"
                  style={{ background: '#FFFFFF', color: '#0a0a0a', fontFamily: 'Rajdhani, sans-serif' }}
                >
                  {busy && <Loader2 size={16} className="animate-spin" />}
                  {busy ? 'Sending…' : isReport ? 'Send report' : 'Send message'}
                </button>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
