import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { render } from '@testing-library/react';
import { ApiProvider } from '../ApiContext';
import { AuthProvider } from '../auth/AuthContext';
import { NoticeProvider } from '../Notice';
import { NotesProvider } from './NotesContext';
import { ImportPage } from './ImportPage';
import { fakeAuth, PERMANENT } from '../../test/fakeAuth';
import { fakeFeed, ORIGINS, renderApp } from '../../test/renderApp';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const SESSION = { uploadId: 'u1', sessionUri: 'https://storage.googleapis.com/s', storagePath: 'recordings/workspace_u1/x.m4a', chunkSize: 8388608, expiresAt: '2026-10-03T00:00:00Z' };

describe('the Import page', () => {
  it('the notes list links to it', async () => {
    renderApp('/app', fakeAuth(PERMANENT).adapter, undefined, fakeFeed([]).feed);
    expect((await screen.findByRole('link', { name: 'Import a recording' })).getAttribute('href')).toBe('/app/import');
  });

  it('a chosen file uploads, then opens its new note', async () => {
    const writer = { createNoteDoc: vi.fn(async () => {}), markNoteFailed: vi.fn(async () => {}) };
    const api = async (url: RequestInfo | URL) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/uploads') return new Response(JSON.stringify(SESSION), { status: 200 });
      if (path === '/v1/uploads/u1/complete') return new Response(JSON.stringify({ uploadId: 'u1', storagePath: SESSION.storagePath, complete: true }), { status: 200 });
      if (path === '/v1/process') return new Response(JSON.stringify({ success: true, noteId: 'n', jobId: 'j', status: 'queued' }), { status: 202 });
      return new Response('{}', { status: 200 });
    };
    const gcsPut = (async () => new Response(null, { status: 200 })) as typeof fetch;
    const auth = fakeAuth(PERMANENT);
    const router = createMemoryRouter(
      [{ path: '/import', element: <ImportPage deps={{ fetchImpl: gcsPut, probe: async () => 60 }} /> }, { path: '/notes/:id', element: <h1>Opened</h1> }],
      { initialEntries: ['/import'] },
    );
    render(
      <AuthProvider adapter={auth.adapter}>
        <ApiProvider origins={ORIGINS} fetchImpl={api as typeof fetch}>
          <NotesProvider feed={fakeFeed([]).feed} writer={writer}>
            <NoticeProvider>
              <RouterProvider router={router} />
            </NoticeProvider>
          </NotesProvider>
        </ApiProvider>
      </AuthProvider>,
    );
    fireEvent.change(await screen.findByLabelText('Audio file'), { target: { files: [new File([new Uint8Array(1000)], 'Standup.m4a', { type: 'audio/mp4' })] } });
    expect(await screen.findByRole('heading', { name: 'Opened' })).toBeTruthy();
    expect(writer.createNoteDoc).toHaveBeenCalledWith(expect.objectContaining({ title: 'Standup', type: 'import_audio', storagePath: SESSION.storagePath, duration: 60 }));
    expect(router.state.location.pathname).toMatch(/^\/notes\/web[0-9a-f]{32}$/);
  });

  it("a file that isn't audio is refused on the spot", async () => {
    renderApp('/app/import', fakeAuth(PERMANENT).adapter, undefined, fakeFeed([]).feed, { createNoteDoc: vi.fn(), markNoteFailed: vi.fn() });
    fireEvent.change(await screen.findByLabelText('Audio file'), { target: { files: [new File(['x'], 'minutes.pdf', { type: 'application/pdf' })] } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn’t supported/);
    expect(screen.queryByText(/Uploading/)).toBeNull();
  });

  it("fails this browser's upload left behind by a closed tab, and no other device's", async () => {
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    localStorage.setItem('own_uploads', JSON.stringify({ mine: 1 }));
    const writer = { createNoteDoc: vi.fn(async () => {}), markNoteFailed: vi.fn(async () => {}) };
    const note = (id: string) => ({ id, title: id, workspaceId: 'workspace_u1', authorId: 'u1', status: 'processing' as const, type: 'import_audio' as const, createdAt: old, updatedAt: old });
    renderApp('/app', fakeAuth(PERMANENT).adapter, undefined, fakeFeed([note('mine'), note('phone')]).feed, writer);
    await screen.findByRole('heading', { level: 1, name: 'Your notes' });
    await vi.waitFor(() => expect(writer.markNoteFailed).toHaveBeenCalledWith('u1', 'mine', expect.stringMatching(/didn’t finish/)));
    expect(writer.markNoteFailed).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem('own_uploads')!)).toEqual({});
  });
});
