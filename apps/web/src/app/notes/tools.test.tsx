import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { fakeAuth, PERMANENT } from '../../test/fakeAuth';
import { fakeFeed, renderApp } from '../../test/renderApp';
import type { NoteDoc } from '../../lib/notes/notesFeed';

const WS = 'workspace_u1';
const NOTE: NoteDoc = { id: 'n1', title: 'Weekly sync', workspaceId: WS, authorId: 'u1', status: 'ready', type: 'recording', createdAt: '2026-09-26T01:00:00.000Z', updatedAt: new Date().toISOString(), duration: 600, storagePath: 'p' };
const READ = {
  note: { id: 'n1', workspaceId: WS, title: 'Weekly sync', status: 'ready', sourceType: 'recording', sourceUrl: null, storagePath: 'p', mimeType: null, durationSec: 600, language: null, wordCount: null, participants: null, meetingAt: null, errorMessage: null, chunksDone: null, chunksTotal: null, createdAt: null, updatedAt: null },
  summary: { gist: 'Old gist.', model: null, generatedAt: null, actionItems: [{ id: 1, text: 'A1', status: 'open', assigneeName: null, dueDate: null }], keyDecisions: [{ id: 2, text: 'D1' }], chapters: [] },
  transcript: { lines: [{ id: 'l1', speaker: 'Speaker 1', speakerTag: 1, startMs: 0, endMs: 1, text: 'Hi.', confidence: null }, { id: 'l2', speaker: 'Speaker 1', speakerTag: 1, startMs: 2, endMs: 3, text: 'Again.', confidence: null }], nextCursor: null, truncated: false },
  redaction: { applied: true, scheme: 's' },
};

type Handler = (body: Record<string, unknown>, n: number) => Response;
let handlers: Record<string, Handler> = {};
const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(url)).pathname;
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
  calls.push({ path, body });
  const n = calls.filter((c) => c.path === path).length;
  return (handlers[path] ?? (() => json({ ok: true })))(body, n);
}) as typeof fetch;

beforeEach(() => {
  calls.length = 0;
  handlers = { '/v1/notes/read': () => json(READ) };
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const open = async (tool: string) => {
  renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, fetchImpl, fakeFeed([NOTE]).feed);
  fireEvent.click(await screen.findByRole('button', { name: tool }));
  return screen.getByRole('dialog');
};
const reads = () => calls.filter((c) => c.path === '/v1/notes/read').length;

describe('note tools', () => {
  it('rename saves the title through the api, then re-reads the note', async () => {
    handlers['/v1/notes/update'] = () => json({ ok: true, noteId: 'n1', pgWritten: true });
    const dlg = await open('Rename');
    fireEvent.change(within(dlg).getByLabelText('Title'), { target: { value: '  Planning  ' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/v1/notes/update')?.body).toEqual({ noteId: 'n1', workspaceId: WS, title: 'Planning' }));
    await waitFor(() => expect(reads()).toBe(2));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('edit summary sends the gist, and action items and decisions one per line', async () => {
    const dlg = await open('Edit summary');
    fireEvent.change(within(dlg).getByLabelText('Summary'), { target: { value: 'New gist.' } });
    fireEvent.change(within(dlg).getByLabelText('Action items, one per line'), { target: { value: 'A1\n\n  A2 \n' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/v1/notes/update')?.body).toEqual({ noteId: 'n1', workspaceId: WS, summary: { gist: 'New gist.', actionItems: ['A1', 'A2'], keyDecisions: ['D1'] } }));
  });

  it('regenerate: manual edits need an explicit "replace my edits", as on iOS', async () => {
    handlers['/v1/notes/regenerate-summary'] = (body) =>
      body.confirmOverwrite ? json({ ok: true, noteId: 'n1', status: 'summarizing', generation: 2, template: 'standup' }) : json({ error: 'manual_edits_present', editedAt: '2026-09-26T00:00:00Z' }, 409);
    const dlg = await open('Regenerate summary');
    fireEvent.click(within(dlg).getByLabelText(/Standup/));
    fireEvent.click(within(dlg).getByRole('button', { name: 'Regenerate' }));
    expect((await within(dlg).findByRole('alert')).textContent).toMatch(/You edited this summary/);
    fireEvent.click(within(dlg).getByLabelText(/Replace my edits/));
    fireEvent.click(within(dlg).getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.filter((c) => c.path === '/v1/notes/regenerate-summary').map((c) => c.body)).toEqual([
      { noteId: 'n1', workspaceId: WS, template: 'standup', confirmOverwrite: false },
      { noteId: 'n1', workspaceId: WS, template: 'standup', confirmOverwrite: true },
    ]);
  });

  it('regenerate while one is running says so', async () => {
    handlers['/v1/notes/regenerate-summary'] = () => json({ error: 'already_regenerating', status: 'summarizing' }, 409);
    const dlg = await open('Regenerate summary');
    fireEvent.click(within(dlg).getByRole('button', { name: 'Regenerate' }));
    expect((await within(dlg).findByRole('alert')).textContent).toBe('This summary is already being regenerated.');
  });

  it('feedback sends the kind, a 1–5 rating and the comment', async () => {
    const dlg = await open('Rate this note');
    const send = within(dlg).getByRole('button', { name: 'Send' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dlg).getByRole('button', { name: '4 out of 5' }));
    fireEvent.change(within(dlg).getByRole('textbox'), { target: { value: ' good ' } });
    fireEvent.click(send);
    await waitFor(() => expect(calls.find((c) => c.path === '/v1/notes/feedback')?.body).toEqual({ noteId: 'n1', workspaceId: WS, kind: 'summary', rating: 4, comment: 'good' }));
  });

  it('export downloads the Word document the api sends', async () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    handlers['/v1/export'] = () => new Response('DOCX', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="Weekly sync.docx"' } });
    const dlg = await open('Export');
    fireEvent.change(within(dlg).getByLabelText('Include'), { target: { value: 'summary' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(created).toHaveBeenCalled();
    expect(calls.find((c) => c.path === '/v1/export')?.body).toEqual({ noteId: 'n1', workspaceId: WS, scope: 'summary', format: 'docx' });
  });

  it("a transcript too long for Word says what to do", async () => {
    handlers['/v1/export'] = () => json({ error: 'transcript_too_large_for_docx', totalLines: 90000 }, 413);
    const dlg = await open('Export');
    fireEvent.click(within(dlg).getByRole('button', { name: 'Download' }));
    expect((await within(dlg).findByRole('alert')).textContent).toMatch(/Export the summary only/);
  });

  it('renaming a speaker renames every line of theirs', async () => {
    handlers['/v1/notes/n1/speakers'] = () => json({ ok: true, noteId: 'n1', speakers: [{ speakerTag: 1, name: 'Sam' }] });
    renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, fetchImpl, fakeFeed([NOTE]).feed);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Speaker 1:' }))[0]);
    const dlg = screen.getByRole('dialog');
    fireEvent.change(within(dlg).getByLabelText('Name'), { target: { value: 'Sam' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Sam:' })).toHaveLength(2));
    expect(calls.find((c) => c.path === '/v1/notes/n1/speakers')?.body).toEqual({ workspaceId: WS, speakerTag: 1, name: 'Sam' });
  });
});
