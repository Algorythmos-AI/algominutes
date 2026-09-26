import { describe, expect, it } from 'vitest';
import { abandonedUploads, endedUpload, startedUpload } from './ownUploads';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("this browser's uploads", () => {
  it('one running in this tab is never abandoned; one from a closed tab is', () => {
    const store = memory();
    startedUpload('live', store);
    expect(abandonedUploads(store)).toEqual([]);
    // Another tab's (or a closed tab's) record: in storage, not running here.
    store.setItem('own_uploads', JSON.stringify({ ...JSON.parse(store.getItem('own_uploads')!), closed: 1 }));
    expect(abandonedUploads(store)).toEqual(['closed']);
    endedUpload('closed', store);
    endedUpload('live', store);
    expect(abandonedUploads(store)).toEqual([]);
  });
});
