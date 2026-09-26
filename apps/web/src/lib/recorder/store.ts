// A recording, kept safe while it's made: each chunk MediaRecorder hands over
// (every few seconds) is written to IndexedDB at once, so a tab that crashes,
// is closed, or loses power keeps everything up to the last chunk, and the
// next visit offers to upload it. The web twin of iOS RecordingStore (audio
// kept on the device until its upload is confirmed, then removed).

const DB = 'algominutes-recorder';
const VERSION = 1;

export interface RecordingMeta {
  id: string;
  /** The account it belongs to: another user signing in on this browser never sees it. */
  uid: string;
  mimeType: string;
  startedAt: number;
  /** Set when the user stopped it; unset means it was cut off. */
  stoppedAt?: number;
  /** Seconds recorded so far (a running total, updated with each chunk). */
  seconds: number;
  /** When the last chunk was written: a recording touched moments ago may still be live in another tab. */
  touchedAt?: number;
  /**
   * Set once its audio is uploaded to a note whose processing didn't start: a retry
   * asks the server to process that note, instead of uploading (and charging) again.
   */
  kickoff?: Kickoff;
}

/** What /v1/process needs for a note whose audio is already uploaded. */
export interface Kickoff {
  noteId: string;
  workspaceId: string;
  storagePath: string;
  mimeType: string;
  durationSec?: number;
}

type Idb = Pick<IDBFactory, 'open'>;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('recorder store: transaction aborted'));
  });
}

export class RecordingStore {
  private db: Promise<IDBDatabase> | null = null;
  // Resolved on first use, not at construction: a page that never records never touches IndexedDB.
  constructor(private readonly idb?: Idb) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const r = (this.idb ?? indexedDB).open(DB, VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('recordings', { keyPath: 'id' });
        const chunks = db.createObjectStore('chunks', { keyPath: ['id', 'seq'] });
        chunks.createIndex('byRecording', 'id');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return this.db;
  }

  async create(meta: RecordingMeta): Promise<void> {
    const db = await this.open();
    const tx = db.transaction('recordings', 'readwrite');
    tx.objectStore('recordings').put(meta);
    await done(tx);
  }

  /**
   * One chunk, and the running length, in one transaction: a crash never leaves
   * them disagreeing. Stored as its bytes, not a Blob: every engine keeps an
   * ArrayBuffer (a 5-second chunk is about 40 KB). False, and nothing written,
   * when the recording is gone (uploaded or discarded elsewhere): its chunks
   * would be orphans nothing lists or removes.
   */
  async append(id: string, seq: number, blob: Blob, seconds: number, now = Date.now()): Promise<boolean> {
    const bytes = await blob.arrayBuffer();
    const db = await this.open();
    const tx = db.transaction(['recordings', 'chunks'], 'readwrite');
    const recs = tx.objectStore('recordings');
    const meta = (await request(recs.get(id))) as RecordingMeta | undefined;
    if (meta) {
      tx.objectStore('chunks').put({ id, seq, bytes });
      recs.put({ ...meta, seconds: Math.max(meta.seconds, seconds), touchedAt: now });
    }
    await done(tx);
    return Boolean(meta);
  }

  /** Marks it stopped by the user. False when the recording is gone. */
  async stop(id: string, stoppedAt = Date.now()): Promise<boolean> {
    return this.update(id, (m) => ({ ...m, stoppedAt }));
  }

  /** Remembers the note its audio went to, when that note's processing didn't start. */
  async setKickoff(id: string, kickoff: Kickoff): Promise<boolean> {
    return this.update(id, (m) => ({ ...m, kickoff }));
  }

  private async update(id: string, fn: (m: RecordingMeta) => RecordingMeta): Promise<boolean> {
    const db = await this.open();
    const tx = db.transaction('recordings', 'readwrite');
    const recs = tx.objectStore('recordings');
    const meta = (await request(recs.get(id))) as RecordingMeta | undefined;
    if (meta) recs.put(fn(meta));
    await done(tx);
    return Boolean(meta);
  }

  /** One recording's details, or null when it's gone. */
  async get(id: string): Promise<RecordingMeta | null> {
    const db = await this.open();
    return ((await request(db.transaction('recordings').objectStore('recordings').get(id))) as RecordingMeta | undefined) ?? null;
  }

  /** The user's recordings still on this browser (not yet uploaded), oldest first. */
  async list(uid: string): Promise<RecordingMeta[]> {
    const db = await this.open();
    const all = (await request(db.transaction('recordings').objectStore('recordings').getAll())) as RecordingMeta[];
    return all.filter((r) => r.uid === uid).sort((a, b) => a.startedAt - b.startedAt);
  }

  /** The recording's audio: its chunks, in order, as one file. */
  async blob(id: string): Promise<Blob | null> {
    const db = await this.open();
    const tx = db.transaction(['recordings', 'chunks']);
    const meta = (await request(tx.objectStore('recordings').get(id))) as RecordingMeta | undefined;
    if (!meta) return null;
    const chunks = (await request(tx.objectStore('chunks').index('byRecording').getAll(id))) as Array<{ seq: number; bytes: ArrayBuffer }>;
    chunks.sort((a, b) => a.seq - b.seq);
    return new Blob(chunks.map((c) => c.bytes), { type: meta.mimeType });
  }

  /** Removes a recording and its audio: after its upload is confirmed, or when the user discards it. */
  async remove(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(['recordings', 'chunks'], 'readwrite');
    tx.objectStore('recordings').delete(id);
    tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
    await done(tx);
  }
}
