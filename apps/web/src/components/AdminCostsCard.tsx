import React, { useMemo } from 'react';
import type { Note } from '../types';
import { estimateNoteCost, formatUsd, withinLastDays } from '../lib/costs';

interface Props {
  notes: Note[];
}

export const AdminCostsCard: React.FC<Props> = ({ notes }) => {
  const { rows, last30Total } = useMemo(() => {
    const ready = notes.filter((n) => n.status === 'ready');
    const enriched = ready.map((n) => ({ note: n, cost: estimateNoteCost(n) }));
    enriched.sort((a, b) => Date.parse(b.note.createdAt) - Date.parse(a.note.createdAt));
    const last30 = enriched
      .filter((e) => withinLastDays(e.note.createdAt, 30))
      .reduce((acc, e) => acc + e.cost.total, 0);
    return { rows: enriched.slice(0, 25), last30Total: last30 };
  }, [notes]);

  return (
    <div className="owll-card p-5 mt-4" data-testid="admin-costs-card">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, color: '#FFFFFF', fontSize: '1.05rem' }}>
            Admin tools
          </span>
          <span
            style={{
              background: 'rgba(255,255,255,0.15)',
              color: '#FFFFFF',
              fontFamily: 'Rajdhani, sans-serif',
              fontWeight: 700,
              fontSize: '0.6rem',
              padding: '2px 6px',
              borderRadius: 4,
              letterSpacing: 0.5,
            }}
          >
            ADMIN ONLY
          </span>
        </div>
      </div>

      <div className="flex justify-between items-baseline mb-3 pb-3" style={{ borderBottom: '1px solid rgba(78,78,78,0.3)' }}>
        <span style={{ color: '#E5E0DF', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.85rem' }}>
          Last 30 days · estimated
        </span>
        <span style={{ color: '#FFFFFF', fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, fontSize: '1.1rem' }}>
          {formatUsd(last30Total, 2)}
        </span>
      </div>

      {rows.length === 0 ? (
        <p style={{ color: '#8C8684', fontSize: '0.85rem', fontFamily: 'Titillium Web, sans-serif' }}>
          No ready notes yet — record one to see cost.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map(({ note, cost }) => (
            <li key={note.id} className="flex justify-between items-start gap-3 py-1">
              <div className="flex-1 min-w-0">
                <div
                  title={note.title}
                  style={{
                    color: '#E5E0DF',
                    fontFamily: 'Titillium Web, sans-serif',
                    fontSize: '0.85rem',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {note.title || 'Untitled'}
                </div>
                <div style={{ color: '#8C8684', fontSize: '0.7rem', fontFamily: 'Titillium Web, sans-serif' }}>
                  {cost.durationMinutes > 0 ? `${cost.durationMinutes.toFixed(1)} min` : '—'}
                  {' · '}
                  STT {formatUsd(cost.stt)} · LLM {formatUsd(cost.llmInput + cost.llmOutput)} · Emb {formatUsd(cost.embed)}
                </div>
              </div>
              <span
                style={{
                  color: '#FFFFFF',
                  fontFamily: 'Rajdhani, sans-serif',
                  fontWeight: 700,
                  fontSize: '0.85rem',
                  whiteSpace: 'nowrap',
                }}
              >
                {formatUsd(cost.total)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p
        title="Estimated from char counts × published rates; not actual billed amount. Token-cost ledger lands post-alpha."
        style={{ color: '#5C5856', fontSize: '0.65rem', fontFamily: 'Titillium Web, sans-serif', marginTop: 12 }}
      >
        Estimated from char counts × published rates · not the actual billed amount.
      </p>
    </div>
  );
};

export default AdminCostsCard;
