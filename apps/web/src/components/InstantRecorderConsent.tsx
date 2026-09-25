import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, Check } from 'lucide-react';

interface Props {
  open: boolean;
  onCancel: () => void;
  onContinue: () => void;
}

/**
 * Consent sheet shown before Instant Recorder starts capturing audio.
 * Mirrors BroadcastInstructionSheet — the recording captures the user's
 * voice plus ambient audio, which may include other people. Two-party-consent
 * jurisdictions (CA, FL, PA, MA in US; many EU under GDPR) require all
 * participants to consent to recording.
 *
 * The "don't show again" lever is `localStorage.instant_recorder_consent_shown`.
 * The CHECKBOX is required EVERY time though — only the steps copy is
 * suppressed on subsequent uses.
 */
export default function InstantRecorderConsent({ open, onCancel, onContinue }: Props) {
  const [consented, setConsented] = useState(false);

  const handleContinue = () => {
    if (!consented) return;
    try { localStorage.setItem('instant_recorder_consent_shown', '1'); } catch (err) { console.warn('localstorage_set_failed', err); }
    onContinue();
    setConsented(false);
  };

  const handleCancel = () => {
    setConsented(false);
    onCancel();
  };

  let alreadySeen = false;
  try { alreadySeen = localStorage.getItem('instant_recorder_consent_shown') === '1'; } catch { /* silent-catch-ok: localStorage can be unavailable (private mode, blocked storage); no flag is the default */ }

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
            style={{ background: 'linear-gradient(175deg,#131313,#050505)', border: '1px solid rgba(78,78,78,0.45)', borderBottom: 'none', paddingBottom: 'calc(2.5rem + env(safe-area-inset-bottom, 0px))' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.35)' }}>
                <Mic size={20} color="#FFFFFF" />
              </div>
              <h2 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, color: '#FFFFFF', fontSize: '1.1rem' }}>Before you record</h2>
            </div>

            {!alreadySeen && (
              <p style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.85rem', lineHeight: 1.6 }}>
                AlgoMinutes records audio from this device for as long as you're recording. The audio is uploaded to be transcribed and summarised, then kept in your account until you delete it.
              </p>
            )}

            <button
              onClick={() => setConsented(!consented)}
              className="w-full flex items-start gap-3 p-3 rounded-2xl text-left"
              style={{ background: consented ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.03)', border: consented ? '1px solid rgba(255,255,255,0.45)' : '1px solid rgba(78,78,78,0.45)' }}
              aria-checked={consented}
              role="checkbox"
            >
              <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 mt-0.5" style={{ background: consented ? '#FFFFFF' : 'transparent', border: consented ? 'none' : '1.5px solid rgba(78,78,78,0.6)' }}>
                {consented && <Check size={14} color="#0a0a0a" strokeWidth={3} />}
              </div>
              <p style={{ color: consented ? '#FFFFFF' : '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.82rem', lineHeight: 1.5 }}>
                I have permission from anyone whose voice may be captured. If others are present, I'll let them know the meeting is being recorded.
              </p>
            </button>

            <div className="flex gap-3">
              <button
                onClick={handleCancel}
                className="flex-1 py-3.5 rounded-2xl text-sm font-bold"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(78,78,78,0.45)', color: '#FFFFFF', fontFamily: 'Rajdhani, sans-serif' }}
              >
                Cancel
              </button>
              <button
                onClick={handleContinue}
                disabled={!consented}
                className="flex-1 py-3.5 rounded-2xl text-sm font-bold transition-opacity"
                style={{
                  background: consented ? '#FFFFFF' : 'rgba(255,255,255,0.25)',
                  color: consented ? '#0a0a0a' : 'rgba(255,255,255,0.4)',
                  fontFamily: 'Rajdhani, sans-serif',
                  opacity: consented ? 1 : 0.65,
                  cursor: consented ? 'pointer' : 'not-allowed',
                }}
              >
                {consented ? 'Start recording' : 'Tick the box to start'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
