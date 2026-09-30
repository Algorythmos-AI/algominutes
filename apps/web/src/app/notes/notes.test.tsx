import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { fakeAuth, PERMANENT } from '../../test/fakeAuth';
import { fakeFeed, renderApp } from '../../test/renderApp';
import type { NoteDoc } from '../../lib/notes/notesFeed';
import { parseNotes } from '../../lib/notes/notesFeed';
import { formatClock, formatDuration, notetakerAction, notetakerLabel, statusOf } from '../../lib/notes/format';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const WS = 'workspace_u1';
const note = (id: string, extra: Partial<NoteDoc> = {}): NoteDoc => ({
  id,
  title: `Note ${id}`,
  workspaceId: WS,
  authorId: 'u1',
  status: 'ready',
  type: 'recording',
  createdAt: '2026-09-26T01:00:00.000Z',
  updatedAt: new Date().toISOString(),
  duration: 1500,
  storagePath: `recordings/${WS}/${id}.m4a`,
  ...extra,
});

const READ = {
  note: {
    id: 'n1', workspaceId: WS, title: 'Weekly sync', status: 'ready', sourceType: 'recording', sourceUrl: null, storagePath: 'p', mimeType: 'audio/mp4',
    durationSec: 1500, language: 'en', wordCount: 100, participants: null, meetingAt: null, errorMessage: null, chunksDone: null, chunksTotal: null,
    createdAt: '2026-09-26T01:00:00.000Z', updatedAt: '2026-09-26T01:30:00.000Z',
  },
  summary: {
    gist: 'We agreed the launch plan.',
    model: 'gemini', generatedAt: null,
    actionItems: [{ id: 1, text: 'Ship the site', status: 'open', assigneeName: 'Sam', dueDate: null }],
    keyDecisions: [{ id: 2, text: 'Launch on Monday' }],
    chapters: [{ startMs: 65_000, title: 'Budget', summary: 'The numbers.' }],
  },
  transcript: {
    lines: [{ id: 'l1', speaker: 'Sam', speakerTag: 1, startMs: 0, endMs: 4000, text: 'Hello everyone.', confidence: 0.9 }],
    nextCursor: 'c2', truncated: true,
  },
  redaction: { applied: true, scheme: 'shared/redaction.cjs' },
};
const PAGE2 = { transcript: { lines: [{ id: 'l2', speaker: 'Alex', speakerTag: 2, startMs: 5000, endMs: 9000, text: 'Hi Sam.', confidence: 0.9 }], nextCursor: null, truncated: false }, redaction: READ.redaction };

type Route = (url: string, body: Record<string, unknown>) => Response | undefined;
const server = (route: Route) => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    calls.push({ url: String(url), body });
    return route(String(url), body) ?? new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

describe('the notes list', () => {
  it('lists the notes newest first, with status and length', async () => {
    const { feed } = fakeFeed([note('old', { createdAt: '2026-09-01T00:00:00.000Z' }), note('new', { status: 'transcribing' }), note('bad', { status: 'error' })]);
    renderApp('/app', fakeAuth(PERMANENT).adapter, undefined, feed);
    const section = (await screen.findByRole('heading', { level: 1, name: 'Your notes' })).closest('section')!;
    const items = await within(section).findAllByRole('listitem');
    expect(items.map((li) => within(li).getByRole('link').textContent)).toEqual([
      expect.stringMatching(/^Note newTranscribing/),
      expect.stringMatching(/^Note badCouldn't process/),
      expect.stringMatching(/^Note oldReady.*25 min/),
    ]);
  });

  it('says when a note is taking longer than usual', async () => {
    const { feed } = fakeFeed([note('stuck', { status: 'summarizing', updatedAt: new Date(Date.now() - 60 * 60_000).toISOString() })]);
    renderApp('/app', fakeAuth(PERMANENT).adapter, undefined, feed);
    expect(await screen.findByText('Taking longer than usual')).toBeTruthy();
  });

  it('has an empty state that says where notes come from', async () => {
    renderApp('/app', fakeAuth(PERMANENT).adapter, undefined, fakeFeed([]).feed);
    expect(await screen.findByText('No notes yet')).toBeTruthy();
  });

  it('a null field (as the mirror repair writes) or a missing title keeps the note in the list', () => {
    const { notes, invalid } = parseNotes([{ id: 'r', data: { ...note('r'), errorMessage: null, title: undefined } }]);
    expect(invalid).toEqual([]);
    expect(notes[0]).toMatchObject({ id: 'r', title: '' });
  });

  it("when the feed fails it says so, and tries again on its own", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    const feed = {
      subscribe: (_uid: string, onNotes: (n: NoteDoc[]) => void, onError: (e: unknown) => void) => {
        calls += 1;
        if (calls === 1) setTimeout(() => onError(new Error('unavailable')), 0);
        else onNotes([note('back')]);
        return () => {};
      },
    };
    renderApp('/app', fakeAuth(PERMANENT).adapter, undefined, feed);
    expect(await screen.findByText(/couldn't be loaded/)).toBeTruthy();
    await vi.advanceTimersByTimeAsync(2500);
    expect(await screen.findByText('Note back')).toBeTruthy();
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  it('parseNotes drops a doc that breaks the contract, and sorts', () => {
    const { notes, invalid } = parseNotes([
      { id: 'a', data: { ...note('a'), createdAt: '2026-01-01T00:00:00Z' } },
      { id: 'b', data: { title: 'no status' } },
      { id: 'c', data: { ...note('c'), createdAt: '2026-02-01T00:00:00Z' } },
    ]);
    expect(notes.map((n) => n.id)).toEqual(['c', 'a']);
    expect(invalid).toEqual(['b']);
  });
});

describe('a note', () => {
  it('shows the summary, actions, decisions, chapters and transcript from the api, and loads more', async () => {
    const { feed } = fakeFeed([note('n1')]);
    const s = server((url, body) => (url.endsWith('/v1/notes/read') ? json(body.cursor ? PAGE2 : READ) : undefined));
    renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, s.fetchImpl, feed);
    expect(await screen.findByRole('heading', { level: 1, name: 'Weekly sync' })).toBeTruthy();
    expect(screen.getByText('We agreed the launch plan.')).toBeTruthy();
    expect(screen.getByText('Ship the site')).toBeTruthy();
    expect(screen.getByText('Launch on Monday')).toBeTruthy();
    expect(screen.getByText('Budget')).toBeTruthy();
    expect(screen.getByText('Hello everyone.')).toBeTruthy();
    expect(s.calls.find((c) => c.url.endsWith('/v1/notes/read'))!.body).toEqual({ noteId: 'n1', workspaceId: WS });
    fireEvent.click(screen.getByRole('button', { name: 'Show more of the transcript' }));
    expect(await screen.findByText('Hi Sam.')).toBeTruthy();
    expect(s.calls.filter((c) => c.url.endsWith('/v1/notes/read'))[1].body).toEqual({ noteId: 'n1', workspaceId: WS, cursor: 'c2' });
    expect(screen.queryByRole('button', { name: 'Show more of the transcript' })).toBeNull();
  });

  it('while processing: shows progress and reads nothing from the api', async () => {
    const { feed } = fakeFeed([note('n1', { status: 'transcribing', progress: { done: 2, total: 5 } })]);
    const s = server(() => undefined);
    renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, s.fetchImpl, feed);
    expect(await screen.findByText(/Transcribing \(2 of 5 parts\)/)).toBeTruthy();
    expect(s.calls.filter((c) => c.url.endsWith('/v1/notes/read'))).toEqual([]);
  });

  it('a failed note says so, and that no minutes were used', async () => {
    const { feed } = fakeFeed([note('n1', { status: 'error', errorMessage: 'The audio was silent.' })]);
    renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, undefined, feed);
    expect((await screen.findByRole('alert')).textContent).toMatch(/The audio was silent\. It didn’t use any of your minutes/);
  });

  // RELEASE.md rev 11, UX6 (H14): a failed note had only its message, and no way forward on the web.
  it('a failed recording can be tried again: its audio is processed afresh, and the page says so', async () => {
    const { feed } = fakeFeed([note('n1', { status: 'error', errorMessage: 'Transcription failed.', type: 'recording', storagePath: 'recordings/workspace_u1/n1.webm', mimeType: 'audio/webm', duration: 125 })]);
    const s = server((url) => (url.endsWith('/v1/process') ? json({ success: true, noteId: 'n1', jobId: 'j', status: 'queued' }) : undefined));
    renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, s.fetchImpl, feed);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Trying again/)).toBeTruthy();
    expect(s.calls.find((c) => c.url.endsWith('/v1/process'))?.body).toEqual({
      noteId: 'n1', workspaceId: 'workspace_u1', type: 'recording', storagePath: 'recordings/workspace_u1/n1.webm', mimeType: 'audio/webm', durationSec: 125,
    });
  });

  it("a try that's refused says why, and can be tried again", async () => {
    const { feed } = fakeFeed([note('n1', { status: 'error', type: 'recording', storagePath: 'recordings/workspace_u1/n1.webm' })]);
    const s = server((url) => (url.endsWith('/v1/process') ? json({ error: 'The service is busy. Try again in a minute.' }, 503) : undefined));
    renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, s.fetchImpl, feed);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/couldn’t start again|couldn't start again/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a failed note with no audio of ours to process offers no Try again', async () => {
    const { feed } = fakeFeed([note('n1', { status: 'error', type: 'recording', storagePath: undefined, sourceUrl: undefined })]);
    renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, undefined, feed);
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it("a note that isn't in the user's list isn't available", async () => {
    renderApp('/app/notes/nope', fakeAuth(PERMANENT).adapter, undefined, fakeFeed([note('n1')]).feed);
    expect(await screen.findByRole('heading', { name: "This note isn't available" })).toBeTruthy();
  });

  it('a ready note the api has no copy of is shown from its doc, not called deleted', async () => {
    const s = server((url) => (url.endsWith('/v1/notes/read') ? json({ error: 'note_not_found' }, 404) : undefined));
    renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, s.fetchImpl, fakeFeed([note('n1', { summary: { gist: 'From the doc.', actionItems: ['Doc action'], keyDecisions: [] } })]).feed);
    expect(await screen.findByText('From the doc.')).toBeTruthy();
    expect(screen.getByText('Doc action')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: "This note isn't available" })).toBeNull();
  });

  it('a scanned note is read from its doc alone, as on iOS', async () => {
    const s = server(() => undefined);
    renderApp('/app/notes/sc', fakeAuth(PERMANENT).adapter, s.fetchImpl, fakeFeed([note('sc', { type: 'scan_text', storagePath: undefined, rawText: 'Scanned words.', summary: { gist: 'Scan gist.', actionItems: [], keyDecisions: [] } })]).feed);
    expect(await screen.findByText('Scanned words.')).toBeTruthy();
    expect(screen.getByText('Scan gist.')).toBeTruthy();
    expect(s.calls.filter((c) => c.url.endsWith('/v1/notes/read'))).toEqual([]);
  });

  it('plays the recording from a fresh signed URL, and fetches one more when it expires', async () => {
    const { feed } = fakeFeed([note('n1')]);
    let n = 0;
    const s = server((url) => {
      if (url.endsWith('/v1/notes/read')) return json(READ);
      if (url.endsWith('/v1/notes/audio-url')) return json({ url: `https://storage.googleapis.com/a.m4a?sig=${++n}`, expiresAt: '2026-09-26T02:00:00Z' });
      return undefined;
    });
    renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, s.fetchImpl, feed);
    fireEvent.click(await screen.findByRole('button', { name: 'Play recording' }));
    await waitFor(() => expect(document.querySelector('audio')?.getAttribute('src')).toMatch(/sig=1$/));
    fireEvent.error(document.querySelector('audio')!);
    await waitFor(() => expect(document.querySelector('audio')?.getAttribute('src')).toMatch(/sig=2$/));
    // It played on the new URL, so a later expiry is refreshed too (a long listen).
    fireEvent.playing(document.querySelector('audio')!);
    fireEvent.error(document.querySelector('audio')!);
    await waitFor(() => expect(document.querySelector('audio')?.getAttribute('src')).toMatch(/sig=3$/));
    // Failing again before it ever played: give up, and say so.
    fireEvent.error(document.querySelector('audio')!);
    expect(await screen.findByText("The recording couldn't be played.")).toBeTruthy();
    expect(s.calls.filter((c) => c.url.endsWith('/v1/notes/audio-url'))).toHaveLength(3);
  });
});

// RELEASE.md PR 23: a notetaker's note (sourceKind bot) says what its notetaker is doing, and lets the user
// cancel it before it records or stop it while it does.
describe('a notetaker note', () => {
  const botNote = (status: string, extra: Partial<NoteDoc> = {}) => note('n1', {
    status: 'recording', type: 'online_meeting', sourceKind: 'bot', duration: undefined, storagePath: undefined,
    notetaker: { botId: 'b0a1b2c3-0000-4000-8000-000000000001', status, platform: 'google_meet' }, ...extra,
  });

  it('the list says what the notetaker is doing, not just "Recording"', async () => {
    renderApp('/app', fakeAuth(PERMANENT).adapter, undefined, fakeFeed([botNote('waiting_room')]).feed);
    const section = (await screen.findByRole('heading', { level: 1, name: 'Your notes' })).closest('section')!;
    const [item] = await within(section).findAllByRole('listitem');
    expect(within(item).getByRole('link').textContent).toMatch(/Notetaker waiting to be let in/);
  });

  it('before it records: the note offers to cancel it, asks first, and cancels through the api', async () => {
    const s = server((url) => (url.includes('/v1/meetings/bots/') ? json({ botId: 'b0a1b2c3-0000-4000-8000-000000000001', status: 'cancelled' }) : undefined));
    renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, s.fetchImpl, fakeFeed([botNote('joining')]).feed);
    expect(await screen.findByText(/Notetaker joining… You can leave this page/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the notetaker' }));
    expect(screen.getByRole('dialog', { name: 'Cancel the notetaker?' }).textContent).toMatch(/nothing is recorded or charged/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel it' }));
    await waitFor(() => expect(s.calls.map((c) => c.url)).toContain('https://api.example.test/v1/meetings/bots/b0a1b2c3-0000-4000-8000-000000000001/cancel'));
    expect(await screen.findByText('The notetaker is cancelled.')).toBeTruthy();
  });

  it('while it records: stopping keeps what it recorded; keeping it sends nothing', async () => {
    const s = server(() => undefined);
    renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, s.fetchImpl, fakeFeed([botNote('recording')]).feed);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop the notetaker' }));
    expect(screen.getByRole('dialog', { name: 'Stop the notetaker?' }).textContent).toMatch(/What it has recorded so far becomes this note/);
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(s.calls.filter((c) => c.url.includes('/v1/meetings/bots/'))).toEqual([]);
  });

  it('a refused cancel says why', async () => {
    const s = server((url) => (url.includes('/v1/meetings/bots/') ? json({ error: 'The notetaker already left.' }, 409) : undefined));
    renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, s.fetchImpl, fakeFeed([botNote('in_call')]).feed);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel the notetaker' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel it' }));
    expect(await screen.findByText(/^The notetaker wasn't stopped\./)).toBeTruthy();
  });

  it('once the meeting is over there is nothing to cancel; a failed one says why, with no minutes used', async () => {
    renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, undefined, fakeFeed([botNote('processing')]).feed);
    expect(await screen.findByText(/Meeting over: getting the recording/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /notetaker/ })).toBeNull();
    cleanup();
    renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, undefined, fakeFeed([botNote('failed', { status: 'error', errorMessage: 'The notetaker wasn’t let into the meeting.' })]).feed);
    expect((await screen.findByRole('alert')).textContent).toMatch(/wasn’t let into the meeting\. It didn’t use any of your minutes/);
  });

  it('a status this build doesn\'t know reads as in progress, never an error', () => {
    expect(notetakerLabel('teleporting')).toBe('Notetaker in progress');
    expect(notetakerAction('teleporting')).toBeNull();
    expect(statusOf('recording', { botId: 'x', status: 'teleporting', platform: 'zoom' })).toEqual({ kind: 'working', label: 'Notetaker in progress' });
    expect(statusOf('recording')).toEqual({ kind: 'working', label: 'Recording' });
    expect(parseNotes([{ id: 'n1', data: { ...botNote('teleporting'), notetaker: { botId: 'x', status: 'teleporting', platform: 'hopin', rank: 45 } } }]).invalid).toEqual([]);
  });
});

describe('deleting a note', () => {
  it('asks, hides it at once, and deletes it through the api', async () => {
    const { feed } = fakeFeed([note('n1'), note('n2')]);
    const s = server((url) => (url.endsWith('/v1/notes/read') ? json(READ) : url.endsWith('/v1/notes/delete') ? json({ ok: true, noteId: 'n1', deleted: true }) : undefined));
    renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, s.fetchImpl, feed);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
    await screen.findByRole('heading', { level: 1, name: 'Your notes' });
    expect(screen.queryByText('Note n1')).toBeNull();
    expect(screen.getByText('Note n2')).toBeTruthy();
    await waitFor(() => expect(s.calls.find((c) => c.url.endsWith('/v1/notes/delete'))?.body).toEqual({ noteId: 'n1', workspaceId: WS }));
    expect(await screen.findByText('Note deleted.')).toBeTruthy();
  });

  it('puts it back, and says so, when the server refuses', async () => {
    const { feed } = fakeFeed([note('n1')]);
    const s = server((url) => (url.endsWith('/v1/notes/read') ? json(READ) : url.endsWith('/v1/notes/delete') ? json({ error: 'internal' }, 500) : undefined));
    renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, s.fetchImpl, feed);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
    expect(await screen.findByText(/The note wasn't deleted\./)).toBeTruthy();
    expect(await screen.findByText('Note n1')).toBeTruthy();
  });

  it('a note that was already gone counts as deleted', async () => {
    const s = server((url) => (url.endsWith('/v1/notes/read') ? json(READ) : url.endsWith('/v1/notes/delete') ? json({ error: 'note_not_found' }, 404) : undefined));
    renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, s.fetchImpl, fakeFeed([note('n1')]).feed);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
    expect(await screen.findByText('Note deleted.')).toBeTruthy();
    expect(screen.queryByText('Note n1')).toBeNull();
  });

  it('the dialog takes focus, closes on Escape, and gives focus back', async () => {
    const s = server((url) => (url.endsWith('/v1/notes/read') ? json(READ) : undefined));
    renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, s.fetchImpl, fakeFeed([note('n1')]).feed);
    const del = await screen.findByRole('button', { name: 'Delete' });
    del.focus();
    fireEvent.click(del);
    const dialog = screen.getByRole('dialog', { name: 'Delete this note?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(del);
  });

  it('cancel deletes nothing', async () => {
    const s = server((url) => (url.endsWith('/v1/notes/read') ? json(READ) : undefined));
    renderApp('/app/notes/n1', fakeAuth(PERMANENT).adapter, s.fetchImpl, fakeFeed([note('n1')]).feed);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(s.calls.filter((c) => c.url.endsWith('/v1/notes/delete'))).toEqual([]);
  });
});

describe('format', () => {
  it('durations and clocks', () => {
    expect(formatDuration(1500)).toBe('25 min');
    expect(formatDuration(3900)).toBe('1 h 5 min');
    expect(formatDuration(7200)).toBe('2 h');
    expect(formatDuration(0)).toBeNull();
    expect(formatClock(75_000)).toBe('1:15');
    expect(formatClock(3_725_000)).toBe('1:02:05');
  });
});
