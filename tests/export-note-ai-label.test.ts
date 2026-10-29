import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';

// docs/plans/APP-STORE-AI-LABEL.md, option C: whoever opens a forwarded Word export never saw the app, so the
// file says under its title that Algorythmos AI wrote it, and carries a machine-readable mark (EU AI Act
// Art. 50(2)) in its core properties. The iOS copy (NoteExport) must say the same words.
const require = createRequire(import.meta.url);
const exportNote = require('../services/api/src/routes/export-note.cjs');
const JSZip = require(require.resolve('jszip', { paths: [require.resolve('docx')] }));

const DATA = {
  note: { id: 'n1', title: 'Board meeting', created_at: new Date('2026-10-01T00:00:00Z') },
  summary: 'Budget approved.',
  actionItems: ['Send minutes'],
  keyDecisions: ['Approve budget'],
  lines: [{ chunk_id: 'c1', speaker_tag: 1, speaker_name: null, start_ms: 0, text: 'Welcome.' }],
};

async function open(scope: string) {
  const zip = await JSZip.loadAsync(await exportNote.renderDocx(DATA, scope));
  const body: string = await zip.file('word/document.xml').async('string');
  const core: string = await zip.file('docProps/core.xml').async('string');
  return { body, core };
}

describe('the Word export says Algorythmos AI wrote it', () => {
  it.each([
    ['summary', [exportNote.AI_SUMMARY_NOTICE]],
    ['transcript', [exportNote.AI_TRANSCRIPT_NOTICE]],
    ['both', [exportNote.AI_SUMMARY_NOTICE, exportNote.AI_TRANSCRIPT_NOTICE]],
  ])('%s: under the title, before the content, with the redaction notice kept', async (scope, notices) => {
    const { body } = await open(scope);
    const title = body.indexOf('Board meeting');
    const firstContent = Math.min(
      ...['Executive Summary', 'Transcript'].map((h) => body.indexOf(h)).filter((i) => i >= 0),
    );
    for (const notice of notices as string[]) {
      const at = body.indexOf(notice);
      expect(at, notice).toBeGreaterThan(title);
      expect(at, notice).toBeLessThan(firstContent);
    }
    expect(body).toContain(exportNote.REDACTION_NOTICE);
    expect(exportNote.aiNotices(scope)).toEqual(notices);
  });

  it('carries the machine-readable mark in the core properties', async () => {
    const { core } = await open('both');
    expect(core).toContain(exportNote.AI_MACHINE_MARK);
    expect(core).toContain('<dc:description>');
  });

  it('says the same words as the iPhone export', () => {
    const swift = fs.readFileSync(new URL('../apps/ios/AlgoMinutes/Models/ExportScope.swift', import.meta.url), 'utf8');
    for (const text of [exportNote.AI_SUMMARY_NOTICE, exportNote.AI_TRANSCRIPT_NOTICE, exportNote.AI_MACHINE_MARK]) {
      expect(swift).toContain(`"${text}"`);
    }
    const web = fs.readFileSync(new URL('../apps/web/src/lib/notes/aiLabel.ts', import.meta.url), 'utf8');
    expect(web).toContain(`'${exportNote.AI_MACHINE_MARK}'`);
  });
});
