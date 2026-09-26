import { RecordingStore } from '../../lib/recorder/store';
import type { RecorderEnv } from './RecordPage';

let env: RecorderEnv | null = null;

/** The browser's own recorder pieces, made once: the store opens IndexedDB on first use. */
export function recorderEnv(): RecorderEnv {
  env ??= {
    store: new RecordingStore(),
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
  };
  return env;
}
