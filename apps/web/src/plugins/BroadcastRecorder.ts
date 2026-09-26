// Web shim for the native BroadcastRecorder plugin (ReplayKit / MediaProjection
// capture of another app's audio in the old Capacitor shell). The web client is
// NOT a Capacitor app: App.tsx only calls this when Capacitor.getPlatform() !==
// 'web', which the native-shim core never answers, so on the web every call is
// refused. Typed to the surface App.tsx uses. TODO(web A8): delete with
// App.tsx's native branches.
import { nativeOnly } from '../lib/native-shim/plugins';

export type BroadcastState = 'idle' | 'starting' | 'recording' | 'finished' | 'error';

export interface BroadcastStatus {
  state: BroadcastState;
  durationMs: number;
  hasCompletedRecording?: boolean;
  errorMessage?: string;
}

export interface BroadcastRecording {
  filePath: string;
  appAudioCaptured?: boolean;
  micAudioCaptured?: boolean;
  appAudioPeak?: number;
  appAudioRms?: number;
  micAudioPeak?: number;
  micAudioRms?: number;
}

export interface BroadcastRecorderPlugin {
  isSupported(): Promise<{ supported: boolean; reason?: string }>;
  startBroadcast(): Promise<void>;
  /** Android only (MediaProjection); optional, as App.tsx checks before calling. */
  stopBroadcast?(): Promise<void>;
  getStatus(): Promise<BroadcastStatus>;
  getRecording(): Promise<BroadcastRecording>;
  clearRecording(): Promise<void>;
}

const BroadcastRecorder = nativeOnly('BroadcastRecorder') as BroadcastRecorderPlugin;
export default BroadcastRecorder;
