// A text note (a scanned image, a PDF, an imported file), built from the text the app extracted (plan rev 12
// R12.8, S16). The rules are the iPhone's TextNoteBuilder (apps/ios/AlgoMinutes/Services/TextNoteBuilder.swift),
// moved here so every client gets the same note and Postgres holds it like every other note. Pure: no I/O.
//
// Characters are counted as the iPhone counts them, in graphemes (Swift's String.count), not UTF-16 units, so
// the cap and the title cut agree with what the app showed.

import type { TextNoteSource } from '@algominutes/contracts/schemas';

export const TEXT_NOTE_MAX_CHARS = 180_000;
export const TEXT_NOTE_TRUNCATION_SUFFIX = '\n\n[Text truncated for mobile display.]';
const TITLE_MIN_CHARS = 5;
const TITLE_MAX_CHARS = 60;
const GIST_QUOTE_CHARS = 500;

const SOURCE_LABEL: Record<TextNoteSource, string> = {
  scanned_image: 'Scanned image',
  pdf: 'PDF document',
  imported: 'Imported document',
};

export interface TextNoteLine { idx: number; speaker: string; text: string }

export interface BuiltTextNote {
  /** The text as kept: NULs gone, trimmed, truncated (with its suffix) past the cap. */
  rawText: string;
  /** One line per non-blank paragraph, in order; a single "No text detected" line when there is none. */
  lines: TextNoteLine[];
  truncated: boolean;
  wordCount: number;
  gist: string;
  /** The first paragraph of 5 characters or more, cut at 60; null when there is none. */
  title: string | null;
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
function chars(s: string): string[] {
  return Array.from(graphemes.segment(s), (g) => g.segment);
}
function prefixChars(s: string, n: number): string {
  // Short strings can't exceed n graphemes: skip segmenting them.
  if (s.length <= n) return s;
  return chars(s).slice(0, n).join('');
}
function countChars(s: string, atMost = Infinity): number {
  if (s.length <= atMost) return chars(s).length;
  let count = 0;
  for (const _ of graphemes.segment(s)) if (++count > atMost) break;
  return count;
}

// Swift's CharacterSet.newlines: U+000A–U+000D, U+0085, U+2028, U+2029.
const NEWLINES = /[\n\u000B\f\r\u0085\u2028\u2029]/;

export function buildTextNote(text: string, source: TextNoteSource): BuiltTextNote {
  const label = SOURCE_LABEL[source];
  let normalized = text.replace(/\0/g, '').trim();
  let truncated = false;
  if (countChars(normalized, TEXT_NOTE_MAX_CHARS) > TEXT_NOTE_MAX_CHARS) {
    normalized = prefixChars(normalized, TEXT_NOTE_MAX_CHARS) + TEXT_NOTE_TRUNCATION_SUFFIX;
    truncated = true;
  }

  const paragraphs = normalized
    .split(NEWLINES)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const lines: TextNoteLine[] = paragraphs.length === 0
    ? [{ idx: 0, speaker: label, text: `No text detected in ${label.toLowerCase()}.` }]
    : paragraphs.map((p, idx) => ({ idx, speaker: label, text: p }));

  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const first = paragraphs[0] ?? '';
  const gist = `${label} - ${wordCount} words extracted${truncated ? ' (truncated)' : ''}.\n\n${prefixChars(first, GIST_QUOTE_CHARS)}...`;

  const titleSource = paragraphs.find((p) => countChars(p, TITLE_MIN_CHARS) >= TITLE_MIN_CHARS);
  const title = titleSource === undefined
    ? null
    : countChars(titleSource, TITLE_MAX_CHARS) > TITLE_MAX_CHARS ? `${prefixChars(titleSource, TITLE_MAX_CHARS)}...` : titleSource;

  return { rawText: normalized, lines, truncated, wordCount, gist, title };
}
