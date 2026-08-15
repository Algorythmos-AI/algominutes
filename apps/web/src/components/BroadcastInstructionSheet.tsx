import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Radio, MonitorSmartphone, Square, Check } from 'lucide-react';

interface Props {
  open: boolean;
  platform: string;
  onCancel: () => void;
  onContinue: () => void;
}

const IOS_STEPS: { Icon: typeof Radio; title: string; body: string }[] = [
  { Icon: Radio,             title: 'Start the broadcast', body: 'Tap "Start Broadcast" in the sheet that iOS shows. Make sure AlgoMinutes is selected.' },
  { Icon: MonitorSmartphone, title: 'Switch to your meeting', body: 'Open Google Meet, Microsoft Teams, or any meeting app and join your call.' },
  { Icon: Square,            title: 'Tap the red bar to stop', body: 'When the meeting ends, tap the red status bar at the top of your screen, then Stop.' },
];

const ANDROID_STEPS: { Icon: typeof Radio; title: string; body: string }[] = [
  { Icon: Radio,             title: 'Allow recording', body: 'Approve Android screen/audio capture when the system prompt appears.' },
  { Icon: MonitorSmartphone, title: 'Switch to your meeting', body: 'Open Google Meet, Microsoft Teams, or any meeting app and join your call.' },
  { Icon: Square,            title: 'Stop from notification', body: 'When the meeting ends, pull down notifications and tap Stop on the AlgoMinutes recording notification.' },
];

export default function BroadcastInstructionSheet({ open, platform, onCancel, onContinue }: Props) {
  const [consented, setConsented] = useState(false);
  const isAndroid = platform === 'android';
  const steps = isAndroid ? ANDROID_STEPS : IOS_STEPS;

  const handleContinue = () => {
    if (!consented) return;
    onContinue();
    setConsented(false);
  };

  const handleCancel = () => {
    setConsented(false);
    onCancel();
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
            style={{ background: 'linear-gradient(175deg,#131313,#050505)', border: '1px solid rgba(78,78,78,0.45)', borderBottom: 'none', paddingBottom: 'calc(2.5rem + env(safe-area-inset-bottom, 0px))' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.35)' }}>
                <Radio size={20} color="#FFFFFF" />
              </div>
              <h2 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, color: '#FFFFFF', fontSize: '1.1rem' }}>Record an online meeting</h2>
            </div>

            <p style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.85rem', lineHeight: 1.6 }}>
              {isAndroid
                ? 'Android will let AlgoMinutes capture supported meeting audio and your microphone. Three steps:'
                : 'iOS will let AlgoMinutes capture audio from your meeting app and your microphone. Three steps:'}
            </p>

            <div className="space-y-3">
              {steps.map(({ Icon, title, body }, i) => (
                <div key={title} className="flex items-start gap-3 p-3 rounded-2xl" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(78,78,78,0.35)' }}>
                  <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'rgba(255,255,255,0.12)' }}>
                    <Icon size={16} color="#FFFFFF" />
                  </div>
                  <div className="flex-1">
                    <p style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, color: '#FFFFFF', fontSize: '0.85rem' }}>
                      <span style={{ color: '#FFFFFF', marginRight: 6 }}>{i + 1}.</span>{title}
                    </p>
                    <p style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.78rem', lineHeight: 1.5, marginTop: 2 }}>{body}</p>
                  </div>
                </div>
              ))}
            </div>

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
                I have permission from everyone in this meeting to record. I'll let participants know the meeting is being recorded.
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
                {consented ? 'Continue' : 'Tick the box to continue'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
