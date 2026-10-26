import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { fakeAuth, GUEST, PERMANENT } from '../../test/fakeAuth';
import { renderApp } from '../../test/renderApp';
import { recorderEnv } from './env';

// Recordings this browser hasn't uploaded (RELEASE.md PR 12a): seen on the notes list, and not left behind
// on the computer at sign-out. The app's own store, on fake-indexeddb.
const store = () => recorderEnv().store;

async function leave(uid: string, id = 'left', seconds = 125) {
  await store().create({ id, uid, mimeType: 'audio/webm', startedAt: Date.parse('2026-09-26T01:00:00Z'), stoppedAt: Date.parse('2026-09-26T01:02:05Z'), seconds });
  await store().append(id, 0, new Blob(['audio']), seconds, Date.now() - 60_000);
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  for (const uid of ['u1', 'g1', 'someone-else']) for (const r of await store().list(uid)) await store().remove(r.id);
});

describe('recordings not uploaded', () => {
  it('show on the notes list, with a way to upload them', async () => {
    await leave('u1');
    renderApp('/app', fakeAuth(PERMANENT).adapter);
    expect(await screen.findByText('A recording wasn’t uploaded')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Upload it' }));
    expect(await screen.findByRole('heading', { name: 'Record a meeting' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Upload it' })).toBeTruthy();
  });

  it("show only the account's own, and nothing when there are none", async () => {
    await leave('someone-else');
    renderApp('/app', fakeAuth(PERMANENT).adapter);
    await screen.findByRole('heading', { name: 'Your notes' });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/wasn’t uploaded|weren’t uploaded/)).toBeNull();
  });

  it('signing out says so; Delete and sign out removes them from this browser', async () => {
    await leave('u1', 'a');
    await leave('u1', 'b');
    const auth = fakeAuth(PERMANENT);
    renderApp('/app', auth.adapter);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    const dialog = await screen.findByRole('dialog', { name: '2 recordings aren’t uploaded' });
    expect(auth.adapter.signOut).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete and sign out' }));
    await screen.findByRole('heading', { name: 'Sign in to AlgoMinutes' });
    expect(auth.adapter.signOut).toHaveBeenCalledTimes(1);
    expect(await store().list('u1')).toEqual([]);
  });

  it("one that can't be removed doesn't keep the others on this computer", async () => {
    await leave('u1', 'a');
    await leave('u1', 'b');
    const real = store().remove.bind(store());
    vi.spyOn(store(), 'remove').mockImplementation(async (id: string) => {
      if (id === 'a') throw new Error('IndexedDB refused');
      return real(id);
    });
    const auth = fakeAuth(PERMANENT);
    renderApp('/app', auth.adapter);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete and sign out' }));
    await screen.findByRole('heading', { name: 'Sign in to AlgoMinutes' });
    expect((await store().list('u1')).map((r) => r.id)).toEqual(['a']);
    expect(auth.adapter.signOut).toHaveBeenCalledTimes(1);
  });

  it('Upload first keeps them, and the account signed in', async () => {
    await leave('u1');
    const auth = fakeAuth(PERMANENT);
    renderApp('/app', auth.adapter);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('link', { name: 'Upload first' }));
    expect(await screen.findByRole('heading', { name: 'Record a meeting' })).toBeTruthy();
    expect(auth.adapter.signOut).not.toHaveBeenCalled();
    expect(await store().list('u1')).toHaveLength(1);
  });

  it("a guest is also told the account can't be got back", async () => {
    await leave('g1');
    renderApp('/app', fakeAuth(GUEST).adapter);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    const dialog = await screen.findByRole('dialog', { name: 'A recording isn’t uploaded' });
    expect(dialog.textContent).toMatch(/won’t be able to get back into this guest account/);
  });

  it('with none, a sign-out goes ahead at once', async () => {
    const auth = fakeAuth(PERMANENT);
    renderApp('/app', auth.adapter);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(auth.adapter.signOut).toHaveBeenCalledTimes(1));
  });
});
