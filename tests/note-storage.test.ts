import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { purgeNoteObjects, noteObjectSets, ownedStoragePath, cancelResumableUpload } = require('@algominutes/ai/note-storage.cjs');

// The objects of one note are matched by EXACT name after a prefix listing. A
// bare prefix would also match another note whose id extends this one's
// (note1 -> note10), which is the bug the old onNoteDeleted sweep had.
const owned = (names: string[], opts: { includeScratch?: boolean } = {}) => {
  const sets = noteObjectSets({ workspaceId: 'ws1', noteId: 'note1', includeScratch: opts.includeScratch ?? true });
  return names.filter((n) => sets.some((s: { prefix: string; matches: (n: string) => boolean }) => n.startsWith(s.prefix) && s.matches(n)));
};

describe('noteObjectSets', () => {
  it("matches the note's content objects, with or without an extension, in every content root", () => {
    expect(owned(['recordings/ws1/note1', 'recordings/ws1/note1.m4a', 'imports/ws1/note1.mp4', 'scans/ws1/note1.jpg']))
      .toHaveLength(4);
  });

  it('never matches a different note whose id shares the prefix, or anything nested', () => {
    expect(owned([
      'recordings/ws1/note10.m4a', 'recordings/ws1/note1-copy.m4a', 'recordings/ws1/note1_b',
      'recordings/ws1/note1.m4a/extra', 'recordings/ws2/note1.m4a', 'transcoder/note10/chunk.flac',
    ])).toEqual([]);
  });

  it('matches the transcoder scratch only when told the id is proven', () => {
    expect(owned(['transcoder/note1/chunk-000.flac'], { includeScratch: true })).toHaveLength(1);
    expect(owned(['transcoder/note1/chunk-000.flac'], { includeScratch: false })).toEqual([]);
  });

  it('refuses a malformed id, so a listing can never widen to a whole workspace or bucket', () => {
    for (const bad of ['', '../x', 'a/b', 'x'.repeat(129), null]) {
      expect(() => noteObjectSets({ workspaceId: 'ws1', noteId: bad })).toThrow(/invalid/);
      expect(() => noteObjectSets({ workspaceId: bad, noteId: 'note1' })).toThrow(/invalid/);
    }
  });
});

describe('ownedStoragePath', () => {
  it("accepts only exactly this note's object name", () => {
    expect(ownedStoragePath('recordings/ws1/note1.m4a', 'ws1', 'note1')).toBe('recordings/ws1/note1.m4a');
    expect(ownedStoragePath('imports/ws1/note1', 'ws1', 'note1')).toBe('imports/ws1/note1');
    // Another note's object in the same workspace (storage_path is client-supplied).
    expect(ownedStoragePath('recordings/ws1/note2.m4a', 'ws1', 'note1')).toBeNull();
    expect(ownedStoragePath('recordings/ws2/note1.m4a', 'ws1', 'note1')).toBeNull();
    expect(ownedStoragePath('recordings/ws1/../ws2/x', 'ws1', 'note1')).toBeNull();
    expect(ownedStoragePath('exports/ws1/note1.pdf', 'ws1', 'note1')).toBeNull();
    expect(ownedStoragePath(null, 'ws1', 'note1')).toBeNull();
  });
});

describe('purgeNoteObjects', () => {
  it('lists by prefix, deletes the exact matches plus the recorded path, and propagates a failure', async () => {
    const present = new Set(['recordings/ws1/note1.m4a', 'recordings/ws1/note10.m4a']);
    const bucket = {
      getFiles: async ({ prefix }: { prefix: string }) => [[...present].filter((n) => n.startsWith(prefix)).map((name) => ({ name }))],
      file: (name: string) => ({ delete: async () => void present.delete(name) }),
    };
    const deleted = await purgeNoteObjects({ bucket, workspaceId: 'ws1', noteId: 'note1', storagePath: 'imports/ws1/note1.mp4', includeScratch: true });
    expect(deleted.sort()).toEqual(['imports/ws1/note1.mp4', 'recordings/ws1/note1.m4a']);
    expect([...present]).toEqual(['recordings/ws1/note10.m4a']);

    const failing = { ...bucket, getFiles: async () => { throw new Error('list 503'); } };
    await expect(purgeNoteObjects({ bucket: failing, workspaceId: 'ws1', noteId: 'note1' })).rejects.toThrow('list 503');
  });
});

describe('cancelResumableUpload', () => {
  it('DELETEs the GCS session and treats 499/404/410 as done', async () => {
    const calls: any[] = [];
    for (const status of [499, 404, 410]) {
      await cancelResumableUpload('https://storage.googleapis.com/upload/storage/v1/b/x/o?upload_id=1', async (u: string, i: any) => { calls.push([u, i.method]); return { status }; });
    }
    expect(calls.every(([, m]) => m === 'DELETE')).toBe(true);
    await expect(cancelResumableUpload('https://storage.googleapis.com/u', async () => ({ status: 503 }))).rejects.toThrow(/HTTP 503/);
  });

  it('never contacts anything but storage.googleapis.com over https', async () => {
    const never = async () => { throw new Error('must not be called'); };
    for (const uri of ['https://evil.example/u', 'http://storage.googleapis.com/u', 'https://storage.googleapis.com.evil.example/u', 'not a url']) {
      await expect(cancelResumableUpload(uri, never)).rejects.toThrow(/refusing|not a session uri/);
    }
  });
});
