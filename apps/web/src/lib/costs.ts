// Client-side per-note cost estimation. Numbers are approximate:
// transcript char count / 4 stands in for token count; STT is billed
// per audio minute. The persisted token-cost ledger
// (db/migrations/001_init.sql:186 usage_events) is intentionally
// deferred to the first multi-tester week — at single-operator
// alpha scale this estimation is "good enough" and surfaces in the
// admin cost card with an explicit "estimated" label.
import type { Note } from '../types';

// Rates valid 2026-Q2; see plan §3.
export const RATES = {
  sttPerAudioMinute: 0.024,           // STT v2 batch + inline
  llmInputPer1MTokens: 0.075,         // Vertex Gemini 2.5 Flash
  llmOutputPer1MTokens: 0.30,
  embedPer1KTokens: 0.000025,         // text-embedding-004
} as const;

export interface CostBreakdown {
  stt: number;
  llmInput: number;
  llmOutput: number;
  embed: number;
  total: number;
  durationMinutes: number;
  inputTokens: number;
  outputTokens: number;
}

const charsPerToken = 4; // crude proxy; matches OpenAI's published rule of thumb

function summaryChars(note: Note): number {
  const s = note.summary;
  if (!s) return 0;
  const blocks: string[] = [];
  if (s.gist) blocks.push(s.gist);
  if (Array.isArray(s.actionItems)) blocks.push(...s.actionItems);
  if (Array.isArray(s.keyDecisions)) blocks.push(...s.keyDecisions);
  if (Array.isArray(s.keyPoints)) blocks.push(...s.keyPoints);
  return blocks.reduce((acc, b) => acc + (b ? b.length : 0), 0);
}

function transcriptChars(note: Note): number {
  if (Array.isArray(note.transcript) && note.transcript.length > 0) {
    return note.transcript.reduce((acc, line) => acc + (line.text ? line.text.length : 0), 0);
  }
  if (note.rawText) return note.rawText.length;
  return 0;
}

export function estimateNoteCost(note: Note): CostBreakdown {
  const tChars = transcriptChars(note);
  const sChars = summaryChars(note);
  const durationMinutes = (note.duration || 0) / 60;

  const inputTokens = tChars / charsPerToken;          // transcript fed to Gemini
  const outputTokens = sChars / charsPerToken;          // summary returned by Gemini

  const stt = durationMinutes * RATES.sttPerAudioMinute;
  const llmInput = (inputTokens / 1_000_000) * RATES.llmInputPer1MTokens;
  const llmOutput = (outputTokens / 1_000_000) * RATES.llmOutputPer1MTokens;
  // Embedding fans out across chunks but the input volume equals
  // transcript length in tokens; charge once.
  const embed = (inputTokens / 1_000) * RATES.embedPer1KTokens;

  return {
    stt,
    llmInput,
    llmOutput,
    embed,
    total: stt + llmInput + llmOutput + embed,
    durationMinutes,
    inputTokens,
    outputTokens,
  };
}

export function formatUsd(amount: number, decimals = 4): string {
  if (!Number.isFinite(amount)) return '$0.0000';
  return `$${amount.toFixed(decimals)}`;
}

export function withinLastDays(iso: string | undefined, days: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return (Date.now() - t) <= days * 24 * 60 * 60 * 1000;
}
