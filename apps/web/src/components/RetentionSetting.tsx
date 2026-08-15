import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { RETENTION_OPTIONS_DAYS } from '@algominutes/contracts';
import { setRetention } from '../lib/compliance';

// null = "Keep until I delete". There is no GET endpoint for the current value,
// so we remember the last choice locally for display continuity only; the server
// remains the source of truth for enforcement.
const STORAGE_KEY = 'retention_days_choice';

type Choice = number | null;

function loadChoice(): Choice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null || raw === 'null') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function labelFor(days: Choice): string {
  if (days === null) return 'Keep until I delete';
  if (days % 365 === 0) return `${days / 365} year${days > 365 ? 's' : ''}`;
  return `${days} days`;
}

/**
 * A10 #5 — note-retention picker for Settings. Posts the chosen window (one of
 * RETENTION_OPTIONS_DAYS, or null for "keep until I delete") to the server.
 */
export default function RetentionSetting() {
  const [choice, setChoice] = useState<Choice>(loadChoice);
  const [busy, setBusy] = useState<Choice | 'idle'>('idle');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options: Choice[] = [...RETENTION_OPTIONS_DAYS, null];

  const pick = async (next: Choice) => {
    if (busy !== 'idle' || next === choice) return;
    setBusy(next);
    setError(null);
    setSaved(false);
    try {
      await setRetention(next);
      setChoice(next);
      try { localStorage.setItem(STORAGE_KEY, next === null ? 'null' : String(next)); } catch { /* non-fatal */ }
      setSaved(true);
    } catch (err) {
      setError((err as Error)?.message || 'Could not update your retention setting.');
    } finally {
      setBusy('idle');
    }
  };

  return (
    <div className="owll-card p-5 mt-4">
      <div className="mb-3">
        <span style={{ color: '#E5E0DF', fontFamily: 'Titillium Web, sans-serif' }}>Data retention</span>
        <p style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.78rem', lineHeight: 1.5, marginTop: '0.25rem' }}>
          Automatically delete notes older than the window you choose. Applies going forward.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {options.map((opt) => {
          const active = opt === choice;
          const loading = busy === opt;
          return (
            <button
              key={opt === null ? 'keep' : opt}
              onClick={() => pick(opt)}
              disabled={busy !== 'idle'}
              className="w-full flex justify-between items-center py-3 px-4 rounded-xl text-sm transition-colors disabled:opacity-70"
              style={{
                background: active ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.03)',
                border: active ? '1px solid rgba(255,255,255,0.4)' : '1px solid rgba(78,78,78,0.45)',
                color: active ? '#FFFFFF' : '#8C8684',
                fontFamily: 'Titillium Web, sans-serif',
                cursor: busy !== 'idle' ? 'default' : 'pointer',
              }}
              aria-pressed={active}
            >
              <span>{labelFor(opt)}</span>
              {loading ? <Loader2 size={16} className="animate-spin" /> : active ? <Check size={16} color="#4ADE80" /> : null}
            </button>
          );
        })}
      </div>

      {saved && !error && (
        <p style={{ color: '#4ADE80', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.78rem', marginTop: '0.75rem' }}>
          Saved.
        </p>
      )}
      {error && (
        <p role="alert" style={{ color: '#FCA5A5', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.78rem', marginTop: '0.75rem' }}>
          {error}
        </p>
      )}
    </div>
  );
}
