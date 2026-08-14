import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Trash2, AlertTriangle, Loader2 } from 'lucide-react';

interface Props {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

const REQUIRED_PHRASE = 'DELETE';

export default function DeleteAccountConfirmation({ open, onCancel, onConfirm }: Props) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Synchronous re-entrancy guard. setBusy(true) is async, so a fast
  // double-tap on Confirm could fire two parallel deletes before the UI
  // disables. The ref blocks that synchronously.
  const inFlightRef = useRef(false);
  // Avoid setState-after-unmount warnings if the parent unmounts the modal
  // mid-await (rare but possible if user signs out from another tab).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const ready = acknowledged && phrase.trim().toUpperCase() === REQUIRED_PHRASE && !busy;

  const reset = () => {
    setAcknowledged(false);
    setPhrase('');
    setBusy(false);
    setError(null);
  };

  const handleCancel = () => {
    if (busy || inFlightRef.current) return;
    reset();
    onCancel();
  };

  const handleConfirm = async () => {
    if (!ready || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      // success: parent will sign the user out, modal unmounts. Reset for safety.
      if (mountedRef.current) reset();
    } catch (err) {
      console.error('delete_account_confirm_failed', err);
      if (mountedRef.current) {
        setError('Could not delete your account. Please try again or contact support.');
        setBusy(false);
      }
    } finally {
      inFlightRef.current = false;
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-end justify-center"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={handleCancel}
        >
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 320 }}
            className="w-full max-w-md rounded-t-3xl p-6 pb-10 space-y-5"
            style={{
              background: 'linear-gradient(175deg,#131313,#050505)',
              border: '1px solid rgba(78,78,78,0.45)',
              borderBottom: 'none',
              paddingBottom: 'calc(2.5rem + env(safe-area-inset-bottom, 0px))',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-2xl flex items-center justify-center"
                style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.45)' }}
              >
                <Trash2 size={20} color="#EF4444" />
              </div>
              <h2 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, color: '#FFFFFF', fontSize: '1.1rem' }}>
                Delete your account
              </h2>
            </div>

            <div
              className="flex items-start gap-2 p-3 rounded-2xl"
              style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}
            >
              <AlertTriangle size={16} color="#EF4444" className="shrink-0 mt-0.5" />
              <p style={{ color: '#FCA5A5', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.82rem', lineHeight: 1.5 }}>
                This permanently deletes your account, every recording, every transcript, every summary, and every search index entry. It cannot be undone.
              </p>
            </div>

            <button
              onClick={() => setAcknowledged(!acknowledged)}
              disabled={busy}
              className="w-full flex items-start gap-3 p-3 rounded-2xl text-left"
              style={{
                background: acknowledged ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.03)',
                border: acknowledged ? '1px solid rgba(239,68,68,0.45)' : '1px solid rgba(78,78,78,0.45)',
                opacity: busy ? 0.5 : 1,
                cursor: busy ? 'not-allowed' : 'pointer',
              }}
              aria-checked={acknowledged}
              role="checkbox"
            >
              <div
                className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 mt-0.5"
                style={{
                  background: acknowledged ? '#EF4444' : 'transparent',
                  border: acknowledged ? 'none' : '1.5px solid rgba(78,78,78,0.6)',
                }}
              >
                {acknowledged && (
                  <span style={{ color: '#0a0a0a', fontWeight: 'bold', fontSize: 12, lineHeight: 1 }}>✓</span>
                )}
              </div>
              <p
                style={{
                  color: acknowledged ? '#FFFFFF' : '#8C8684',
                  fontFamily: 'Titillium Web, sans-serif',
                  fontSize: '0.82rem',
                  lineHeight: 1.5,
                }}
              >
                I understand this is permanent and I have exported anything I want to keep.
              </p>
            </button>

            <div className="space-y-2">
              <label
                style={{
                  color: '#8C8684',
                  fontFamily: 'Titillium Web, sans-serif',
                  fontSize: '0.78rem',
                  display: 'block',
                }}
              >
                Type <span style={{ color: '#EF4444', fontWeight: 700 }}>{REQUIRED_PHRASE}</span> to confirm:
              </label>
              <input
                type="text"
                value={phrase}
                onChange={(e) => {
                  setPhrase(e.target.value);
                  if (error) setError(null);
                }}
                disabled={busy}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                placeholder={REQUIRED_PHRASE}
                aria-label="Type DELETE to confirm account deletion"
                className="w-full px-4 py-3 rounded-2xl text-sm"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(78,78,78,0.45)',
                  color: '#FFFFFF',
                  fontFamily: 'Titillium Web, sans-serif',
                }}
              />
            </div>

            {error && (
              <p style={{ color: '#FCA5A5', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.82rem' }}>
                {error}
              </p>
            )}

            <div className="flex gap-3">
              <button
                onClick={handleCancel}
                disabled={busy}
                className="flex-1 py-3.5 rounded-2xl text-sm font-bold"
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(78,78,78,0.45)',
                  color: '#FFFFFF',
                  fontFamily: 'Rajdhani, sans-serif',
                  opacity: busy ? 0.5 : 1,
                  cursor: busy ? 'not-allowed' : 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                disabled={!ready}
                className="flex-1 py-3.5 rounded-2xl text-sm font-bold flex items-center justify-center gap-2 transition-opacity"
                style={{
                  background: ready ? '#EF4444' : 'rgba(239,68,68,0.25)',
                  color: ready ? '#FFFFFF' : 'rgba(255,255,255,0.4)',
                  fontFamily: 'Rajdhani, sans-serif',
                  opacity: ready ? 1 : 0.65,
                  cursor: ready ? 'pointer' : 'not-allowed',
                }}
              >
                {busy && <Loader2 size={16} className="animate-spin" />}
                {busy ? 'Deleting…' : 'Delete forever'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
