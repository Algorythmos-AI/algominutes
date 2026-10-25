import { describe, it, expect } from 'vitest';
import { buildTextNote, TEXT_NOTE_MAX_CHARS } from '@algominutes/db';
import { TextNoteCreateRequest, TextNoteResponse, TEXT_NOTE_REQUEST_MAX_UNITS } from '@algominutes/contracts/schemas';

// Plan rev 12 R12.8 PR 1: a text note (a scan, a PDF, an imported file) is built on the server from the text the
// app extracted, with the iPhone's TextNoteBuilder rules, so every client gets the same note. These are the
// Swift TextNoteBuilderTests' cases (apps/ios/AlgoMinutesTests/AlgoMinutesTests.swift), plus the edges.
describe('buildTextNote: parity with the iPhone TextNoteBuilder', () => {
  it('builds paragraphs into lines, counts words, and takes a title and a gist', () => {
    const r = buildTextNote('First paragraph line.\n\nSecond paragraph.', 'scanned_image');
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toEqual({ idx: 0, speaker: 'Scanned image', text: 'First paragraph line.' });
    expect(r.wordCount).toBe(5);
    expect(r.gist.startsWith('Scanned image - 5 words extracted.')).toBe(true);
    expect(r.title).toBe('First paragraph line.');
    expect(r.truncated).toBe(false);
  });

  it('empty text is one line that says so, and no title', () => {
    const r = buildTextNote('', 'pdf');
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.text).toContain('No text detected');
    expect(r.lines[0]!.text).toBe('No text detected in pdf document.');
    expect(r.title).toBeNull();
  });

  it('truncates past the cap, with the suffix, and says so in the gist', () => {
    const r = buildTextNote('a'.repeat(200_000), 'imported');
    expect(r.truncated).toBe(true);
    expect(r.rawText.endsWith('[Text truncated for mobile display.]')).toBe(true);
    expect(r.gist).toContain('(truncated)');
    expect(TEXT_NOTE_MAX_CHARS).toBe(180_000);
  });

  it('caps the title at 60 characters', () => {
    expect(buildTextNote('t'.repeat(90), 'imported').title).toBe(`${'t'.repeat(60)}...`);
  });

  it('strips NUL characters', () => {
    expect(buildTextNote('a\0b', 'imported').rawText).toBe('ab');
  });

  it('repeated paragraphs stay separate lines, in order', () => {
    const r = buildTextNote('Yes.\n\nYes.\n\nYes.', 'imported');
    expect(r.lines.map((l) => l.idx)).toEqual([0, 1, 2]);
    expect(r.lines.map((l) => l.text)).toEqual(['Yes.', 'Yes.', 'Yes.']);
  });
});

describe('buildTextNote: the edges Swift handles by its own rules', () => {
  it('counts characters as the iPhone does (graphemes), so an emoji is one, not two', () => {
    const r = buildTextNote('😀'.repeat(180_001), 'imported');
    expect(r.truncated).toBe(true);
    expect(buildTextNote('😀'.repeat(180_000), 'imported').truncated).toBe(false);
    expect(buildTextNote('é'.repeat(70), 'imported').title).toBe(`${'é'.repeat(60)}...`);
  });

  it('splits on every newline Swift does (CRLF, U+2028, U+2029, U+0085), trims spaces, drops blank lines', () => {
    const r = buildTextNote('  one \r\ntwo\u2028three\u2029four\u0085five\n\n   \n', 'imported');
    expect(r.lines.map((l) => l.text)).toEqual(['one', 'two', 'three', 'four', 'five']);
  });

  it('a title is the first paragraph of 5 characters or more', () => {
    expect(buildTextNote('Hi\n\nA longer first line', 'imported').title).toBe('A longer first line');
  });

  it('the gist quotes at most 500 characters of the first paragraph', () => {
    const r = buildTextNote('w'.repeat(800), 'imported');
    expect(r.gist).toBe(`Imported document - 1 words extracted.\n\n${'w'.repeat(500)}...`);
  });
});

describe('the text note contract', () => {
  const ok = { noteId: 'n1', workspaceId: 'workspace_u', text: 'Hello', source: 'scanned_image' };

  it('accepts a request, and the answer is the ready note', () => {
    expect(TextNoteCreateRequest.parse(ok)).toEqual(ok);
    expect(TextNoteCreateRequest.parse({ ...ok, title: 'Receipt' })).toMatchObject({ title: 'Receipt' });
    expect(TextNoteResponse.parse({ noteId: 'n1', status: 'ready' })).toEqual({ noteId: 'n1', status: 'ready' });
  });

  it('takes up to 300,000 UTF-16 units (under the 1 MB body limit at 3 bytes each); the builder truncates to 180,000', () => {
    expect(TEXT_NOTE_REQUEST_MAX_UNITS).toBe(300_000);
    expect(TextNoteCreateRequest.safeParse({ ...ok, text: 'a'.repeat(300_000) }).success).toBe(true);
    expect(TextNoteCreateRequest.safeParse({ ...ok, text: 'a'.repeat(300_001) }).success).toBe(false);
  });

  it('refuses an unknown source, a missing id, and a title over 300', () => {
    expect(TextNoteCreateRequest.safeParse({ ...ok, source: 'camera' }).success).toBe(false);
    expect(TextNoteCreateRequest.safeParse({ ...ok, noteId: '' }).success).toBe(false);
    expect(TextNoteCreateRequest.safeParse({ ...ok, title: 'x'.repeat(301) }).success).toBe(false);
  });
});
