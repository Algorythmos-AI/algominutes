/** A MediaRecorder that emits the chunks a test tells it to. */
export class FakeRecorder {
  static last: FakeRecorder | null = null;
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: BlobEvent) => void) | null = null;
  onstop: ((e: Event) => void) | null = null;
  timeslice = 0;
  constructor(readonly stream: MediaStream, readonly options: MediaRecorderOptions) {
    FakeRecorder.last = this;
  }
  start(timeslice: number) {
    this.state = 'recording';
    this.timeslice = timeslice;
  }
  emit(text: string) {
    this.ondataavailable?.({ data: new Blob([text]) } as BlobEvent);
  }
  stop() {
    this.state = 'inactive';
    this.emit('last');
    this.onstop?.(new Event('stop'));
  }
}

export const fakeStream = () => {
  const stopped: string[] = [];
  return { stream: { getTracks: () => [{ stop: () => stopped.push('track') }] } as unknown as MediaStream, stopped };
};
