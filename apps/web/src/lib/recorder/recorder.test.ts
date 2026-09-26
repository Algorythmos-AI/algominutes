import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { RecordingStore } from './store';
import { CHUNK_MS, extensionFor, leftOver, LIVE_WITHOUT_LOCKS_MS, pickMimeType, RecordingGoneError, startRecording } from './recorder';
import { FakeRecorder, fakeLocks, fakeStream } from '../../test/fakeRecorder';

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

const Recorder = FakeRecorder as unknown as typeof MediaRecorder;
const flush = () => new Promise((r) => setTimeout(r, 20));

describe('a recording still being made', () => {
  it('holds a lock while it records, so no tab offers it as left over; stopping lets it go', async () => {
    const store = new RecordingStore(new IDBFactory());
    const { locks, held } = fakeLocks();
    const rec = await startRecording({ id: 'r1', uid: 'u1', stream: fakeStream().stream, store, mimeType: 'audio/webm', onStoreError: () => {}, Recorder, locks });
    FakeRecorder.last!.emit('a');
    await flush();
    expect(held.has('algominutes-recording:r1')).toBe(true);
    expect(await leftOver(await store.list('u1'), locks)).toEqual([]);
    await rec.stop();
    await flush();
    expect(held.size).toBe(0);
    expect((await leftOver(await store.list('u1'), locks)).map((r) => r.id)).toEqual(['r1']);
  });

  it('without Web Locks, one written to in the last 30 seconds and not stopped counts as live', async () => {
    const base = { uid: 'u1', mimeType: 'audio/webm', startedAt: 0, seconds: 1 };
    const now = 1_000_000;
    const all = [
      { ...base, id: 'live', touchedAt: now - 1000 },
      { ...base, id: 'stale', touchedAt: now - LIVE_WITHOUT_LOCKS_MS },
      { ...base, id: 'stopped', touchedAt: now - 1000, stoppedAt: now - 500 },
      { ...base, id: 'old-format' },
    ];
    expect((await leftOver(all, null, now)).map((r) => r.id)).toEqual(['stale', 'stopped', 'old-format']);
  });

  it('a recording removed while it records keeps no orphan chunks, and its stop says it is gone', async () => {
    const store = new RecordingStore(new IDBFactory());
    const errors: unknown[] = [];
    const rec = await startRecording({ id: 'r1', uid: 'u1', stream: fakeStream().stream, store, mimeType: 'audio/webm', onStoreError: (e) => errors.push(e), Recorder, locks: null });
    await store.remove('r1');
    FakeRecorder.last!.emit('orphan');
    await flush();
    expect(errors[0]).toBeInstanceOf(RecordingGoneError);
    expect(await store.append('r1', 9, new Blob(['x']), 1)).toBe(false);
    // Nothing was written under its id: the same id, recreated, holds no audio.
    await store.create({ id: 'r1', uid: 'u1', mimeType: 'audio/webm', startedAt: 0, seconds: 0 });
    expect(await blobText(await store.blob('r1'))).toBe('');
    await store.remove('r1');
    await expect(rec.stop()).rejects.toBeInstanceOf(RecordingGoneError);
  });

  it('a recorder that fails to start leaves no empty entry, and releases its lock', async () => {
    const store = new RecordingStore(new IDBFactory());
    const { locks, held } = fakeLocks();
    FakeRecorder.failOnStart = true;
    try {
      await expect(startRecording({ id: 'r1', uid: 'u1', stream: fakeStream().stream, store, mimeType: 'audio/webm', onStoreError: () => {}, Recorder, locks })).rejects.toThrow();
    } finally {
      FakeRecorder.failOnStart = false;
    }
    await flush();
    expect(await store.list('u1')).toEqual([]);
    expect(held.size).toBe(0);
  });

  it("a recorder the browser won't create (an unsupported format) leaves no entry either", async () => {
    const store = new RecordingStore(new IDBFactory());
    const Broken = class {
      constructor() {
        throw new DOMException('no', 'NotSupportedError');
      }
    } as unknown as typeof MediaRecorder;
    await expect(startRecording({ id: 'r1', uid: 'u1', stream: fakeStream().stream, store, mimeType: 'audio/webm', onStoreError: () => {}, Recorder: Broken, locks: null })).rejects.toThrow();
    expect(await store.list('u1')).toEqual([]);
  });
});

describe('a recording that stops capturing by itself', () => {
  it('reports a microphone that ends (unplugged, or its permission taken back), once', async () => {
    const store = new RecordingStore(new IDBFactory());
    const s = fakeStream();
    let interrupted = 0;
    await startRecording({ id: 'r1', uid: 'u1', stream: s.stream, store, mimeType: 'audio/webm', onStoreError: () => {}, onInterrupted: () => interrupted++, Recorder, locks: null });
    s.end();
    FakeRecorder.last!.stopOnItsOwn();
    expect(interrupted).toBe(1);
  });

  it('reports a recorder that stops on its own, but never the stop the user asked for', async () => {
    const store = new RecordingStore(new IDBFactory());
    let interrupted = 0;
    const rec = await startRecording({ id: 'r1', uid: 'u1', stream: fakeStream().stream, store, mimeType: 'audio/webm', onStoreError: () => {}, onInterrupted: () => interrupted++, Recorder, locks: null });
    await rec.stop();
    expect(interrupted).toBe(0);
    const again = await startRecording({ id: 'r2', uid: 'u1', stream: fakeStream().stream, store, mimeType: 'audio/webm', onStoreError: () => {}, onInterrupted: () => interrupted++, Recorder, locks: null });
    FakeRecorder.last!.stopOnItsOwn();
    expect(interrupted).toBe(1);
    // Its audio so far is still saved by a stop afterwards.
    await again.stop();
    expect((await store.list('u1')).find((r) => r.id === 'r2')?.stoppedAt).toBeTypeOf('number');
  });

  it('reports the seconds recorded after each stored chunk (the cap is checked there too)', async () => {
    const store = new RecordingStore(new IDBFactory());
    const seen: number[] = [];
    let t = 0;
    await startRecording({ id: 'r1', uid: 'u1', stream: fakeStream().stream, store, mimeType: 'audio/webm', onStoreError: () => {}, onProgress: (s) => seen.push(s), now: () => t, Recorder, locks: null });
    t = 5000;
    FakeRecorder.last!.emit('a');
    await flush();
    expect(seen).toEqual([5]);
  });
});

