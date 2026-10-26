// Where a notetaker's recording lands: the recordings bucket, at the note's fixed object
// (recordings/{ws}/{noteId}.mp3), so a replayed ingest overwrites rather than adds. The meetings service holds
// storage.objectAdmin on this bucket only (Terraform, RELEASE.md PR 17).
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import noteStorageModule from '@algominutes/ai/note-storage.cjs';
import { byteCap } from './media-download.js';

const { purgeNoteObjects } = noteStorageModule;

export function createRecordingsStore({ bucket = process.env.GCS_BUCKET, storage } = {}) {
  let b = null;
  const theBucket = async () => {
    if (b) return b;
    if (!bucket) throw new Error('GCS_BUCKET is not set');
    const client = storage ?? new (await import('@google-cloud/storage')).Storage();
    b = client.bucket(bucket);
    return b;
  };
  return {
    /** Stream a web ReadableStream into the object; the bytes written. Fails past maxBytes, leaving no object. */
    async write(path, body, { contentType, maxBytes }) {
      const cap = byteCap(maxBytes);
      const file = (await theBucket()).file(path);
      await pipeline(Readable.fromWeb(body), cap, file.createWriteStream({ contentType, resumable: true, metadata: { cacheControl: 'private, no-store' } }));
      return cap.bytes();
    },
    /** The object's size in bytes, or null when it isn't there (a replay after a crash that wrote it). */
    async size(path) {
      const file = (await theBucket()).file(path);
      const [there] = await file.exists();
      if (!there) return null;
      const [meta] = await file.getMetadata();
      return Number(meta?.size ?? 0);
    },
    /**
     * Remove every object of a deleted note, every version of each (the bucket is versioned: a plain delete
     * leaves the bytes as a noncurrent version). Nothing there is fine; a failure throws, for a retry.
     */
    async removeNote({ workspaceId, noteId }, log) {
      return purgeNoteObjects({ bucket: await theBucket(), workspaceId, noteId, includeScratch: false }, log);
    },
  };
}
