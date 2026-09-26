/** A MediaRecorder that emits the chunks a test tells it to. */
export class FakeRecorder extends EventTarget {
  static last: FakeRecorder | null = null;
  static failOnStart = false;
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: BlobEvent) => void) | null = null;
  onstop: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  timeslice = 0;
  constructor(readonly stream: MediaStream, readonly options: MediaRecorderOptions) {
    super();
    FakeRecorder.last = this;
  }
  start(timeslice: number) {
    if (FakeRecorder.failOnStart) throw new DOMException('no', 'NotSupportedError');
    this.state = 'recording';
    this.timeslice = timeslice;
  }
  emit(text: string) {
    this.ondataavailable?.({ data: new Blob([text]) } as BlobEvent);
  }
  stop() {
    this.state = 'inactive';
    this.emit('last');
    const e = new Event('stop');
    this.onstop?.(e);
    this.dispatchEvent(e);
  }
  /** The browser stopped it by itself (every track ended). */
  stopOnItsOwn() {
    this.state = 'inactive';
    const e = new Event('stop');
    this.onstop?.(e);
    this.dispatchEvent(e);
  }
}

export const fakeStream = () => {
  const stopped: string[] = [];
  const track = Object.assign(new EventTarget(), { stop: () => stopped.push('track'), readyState: 'live' as MediaStreamTrackState, kind: 'audio' });
  return {
    stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream,
    stopped,
    /** The microphone went away (unplugged, or its permission taken back). */
    end: () => {
      track.readyState = 'ended';
      track.dispatchEvent(new Event('ended'));
    },
  };
};

/** Web Locks in memory: a lock is held while its callback's promise is pending. Tabs share one by sharing it. */
export function fakeLocks() {
  const held = new Set<string>();
  const request = async (name: string, cb: () => Promise<unknown>) => {
    held.add(name);
    try {
      return await cb();
    } finally {
      held.delete(name);
    }
  };
  const locks = {
    request: request as unknown as LockManager['request'],
    query: async () => ({ held: [...held].map((name) => ({ name, mode: 'exclusive' as const, clientId: 'tab' })), pending: [] }),
  };
  return { locks, held };
}
