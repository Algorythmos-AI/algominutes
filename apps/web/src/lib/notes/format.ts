// How notes read on screen. en-AU, the app's locale.
import type { NoteDoc } from './notesFeed';

export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** 2026-09-26T11:05:00Z → "26 Sep 2026, 9:05 pm" in the viewer's time zone. */
export function formatDate(iso: string | null | undefined, timeZone?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone }).format(d);
}

/** A transcript timestamp: 75_000 ms → "1:15", 3_725_000 → "1:02:05". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export type StatusKind = 'working' | 'ready' | 'failed';

export function statusOf(status: NoteDoc['status']): { kind: StatusKind; label: string } {
  switch (status) {
    case 'ready':
      return { kind: 'ready', label: 'Ready' };
    case 'error':
      return { kind: 'failed', label: "Couldn't process" };
    case 'recording':
      return { kind: 'working', label: 'Recording' };
    case 'processing':
    case 'queued':
      return { kind: 'working', label: 'Waiting to start' };
    case 'chunking':
    case 'transcribing':
      return { kind: 'working', label: 'Transcribing' };
    case 'summarizing':
      return { kind: 'working', label: 'Summarising' };
  }
}

export const displayTitle = (title: string | null | undefined) => (title && title.trim() ? title : 'Untitled note');
