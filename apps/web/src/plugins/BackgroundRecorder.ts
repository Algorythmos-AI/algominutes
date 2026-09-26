// Web shim for the native BackgroundRecorder plugin (the Android/iOS foreground
// recorder of the old Capacitor shell). The web client is NOT a Capacitor app:
// App.tsx only calls this when Capacitor.getPlatform() !== 'web', which the
// native-shim core never answers, so on the web every call is refused. Typed
// to the surface App.tsx uses. TODO(web A8): delete with App.tsx's native branches.
import { nativeOnly } from '../lib/native-shim/plugins';

export interface BackgroundRecorderPlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRecording(): Promise<{ recording: boolean; startTimeMs?: number }>;
  getFile(): Promise<{ filePath: string }>;
  deleteFile(): Promise<void>;
  addListener(
    event: 'recordingError',
    listener: (data: { error?: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

const BackgroundRecorder = nativeOnly('BackgroundRecorder') as BackgroundRecorderPlugin;
export default BackgroundRecorder;
