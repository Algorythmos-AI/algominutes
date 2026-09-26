import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { RecordingStore } from './store';
import { CHUNK_MS, extensionFor, pickMimeType, startRecording } from './recorder';
import { FakeRecorder, fakeStream } from '../../test/fakeRecorder';

const blobText = async (b: Blob | null) => (b ? await b.text() : null);

describe('the recording store', () => {
  it('keeps each chunk as it arrives, in order, and gives back the whole recording', async () => {
    const store = new RecordingStore(new IDBFactory());
    await store.create({ id: 'r1', uid: 'u1', mimeType: 'audio/webm', startedAt: 1, seconds: 0 });
    await store.append('r1', 1, new Blob(['b']), 10);
    await store.append('r1', 0, new Blob(['a']), 5);
    expect(await blobText(await store.blob('r1'))).toBe('ab');
    expect((await store.list('u1'))[0]).toMatchObject({ id: 'r1', seconds: 10 });
  });

  it("another account on this browser never sees it; removing it removes its audio", async () => {
    const store = new RecordingStore(new IDBFactory());
    await store.create({ id: 'r1', uid: 'u1', mimeType: 'audio/webm', startedAt: 1, seconds: 0 });
    await store.append('r1', 0, new Blob(['a']), 5);
    expect(await store.list('someone-else')).toEqual([]);
    await store.remove('r1');
    expect(await store.list('u1')).toEqual([]);
    expect(await store.blob('r1')).toBeNull();
  });
});

describe('recording', () => {
  it('records in chunks straight to the store, and on stop keeps the last chunk and ends the microphone', async () => {
    const store = new RecordingStore(new IDBFactory());
    const { stream, stopped } = fakeStream();
    const errors: unknown[] = [];
    let t = 1000;
    const rec = await startRecording({ id: 'r1', uid: 'u1', stream, store, mimeType: 'audio/webm;codecs=opus', onStoreError: (e) => errors.push(e), now: () => t, Recorder: FakeRecorder as unknown as typeof MediaRecorder });
    expect(FakeRecorder.last!.timeslice).toBe(CHUNK_MS);
    t = 6000;
    FakeRecorder.last!.emit('one');
    t = 11000;
    FakeRecorder.last!.emit('two');
    await rec.stop();
    expect(await blobText(await store.blob('r1'))).toBe('onetwolast');
    const [meta] = await store.list('u1');
    expect(meta.seconds).toBe(10);
    expect(meta.stoppedAt).toBeTypeOf('number');
    expect(stopped).toEqual(['track']);
    expect(errors).toEqual([]);
  });

  it('a crash mid-recording (no stop) leaves everything so far, marked as cut off', async () => {
    const idb = new IDBFactory();
    const store = new RecordingStore(idb);
    await startRecording({ id: 'r1', uid: 'u1', stream: fakeStream().stream, store, mimeType: 'audio/webm', onStoreError: () => {}, Recorder: FakeRecorder as unknown as typeof MediaRecorder });
    FakeRecorder.last!.emit('kept');
    await new Promise((r) => setTimeout(r, 20));
    // The tab is gone: a new page opens the same database.
    const after = new RecordingStore(idb);
    const [meta] = await after.list('u1');
    expect(meta.stoppedAt).toBeUndefined();
    expect(await blobText(await after.blob('r1'))).toBe('kept');
  });

  it('a chunk that can\'t be stored (a full disk) is reported, so the page can stop', async () => {
    const store = new RecordingStore(new IDBFactory());
    const errors: unknown[] = [];
    await startRecording({ id: 'r1', uid: 'u1', stream: fakeStream().stream, store, mimeType: 'audio/webm', onStoreError: (e) => errors.push(e), Recorder: FakeRecorder as unknown as typeof MediaRecorder });
    store.append = async () => { throw new DOMException('full', 'QuotaExceededError'); };
    FakeRecorder.last!.emit('x');
    await new Promise((r) => setTimeout(r, 20));
    expect(errors).toHaveLength(1);
  });

  it('picks WebM/Opus where supported, MP4 on Safari, and none without MediaRecorder', () => {
    expect(pickMimeType((t) => t.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus');
    expect(pickMimeType((t) => t.startsWith('audio/mp4'))).toBe('audio/mp4;codecs=mp4a.40.2');
    expect(pickMimeType(() => false)).toBeNull();
    expect(extensionFor('audio/mp4;codecs=mp4a.40.2')).toBe('m4a');
    expect(extensionFor('audio/webm;codecs=opus')).toBe('webm');
  });
});
