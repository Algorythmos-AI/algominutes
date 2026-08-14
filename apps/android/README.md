# apps/android — AlgoMinutes Android audio layer (BUILD-PLAN A3)

**Scope: this is the ported audio recording layer and a direct, Capacitor-free
Kotlin interface — nothing more.** The full native Android client (Jetpack
Compose UI, auth, Media3 playback, WorkManager upload, networking) is **Track
B2** and is intentionally not built here.

This module was extracted from the Capacitor app at
`src/wasssup-meeting/android`. The two MediaProjection / ForegroundService
recorder classes are a §5 protected asset and were **ported unchanged**; the two
Capacitor plugin wrappers were **replaced** by a plain Kotlin interface.

> Package identifiers stay `com.wassup.meeting` this phase. The
> `wassup -> algominutes` rename is a later phase (A5) — do not rename yet.

## What's here

```
app/
  build.gradle                         # minimal, Capacitor-free module build
  src/main/
    AndroidManifest.xml                # de-Capacitored: 2 services + FileProvider, no bridge Activity
    java/com/wassup/meeting/
      RecordingService.kt              # PORTED VERBATIM — mic recorder (MediaRecorder foreground service)
      BroadcastRecordingService.kt     # PORTED VERBATIM — MediaProjection recorder (app audio + mic)
      AudioRecorder.kt                 # NEW interface + models (RecorderState, RecordingFile, BroadcastStatus)
      BackgroundAudioRecorder.kt       # NEW impl — drives RecordingService via Intents
      BroadcastAudioRecorder.kt        # NEW impl — drives BroadcastRecordingService via Intents
    res/
      drawable/ic_stat_wassup.png      # notification icon used by both services
      values/strings.xml               # app_name only
      xml/file_paths.xml               # FileProvider paths (copied verbatim)
```

### Ported verbatim vs adapted

- **`RecordingService.kt` / `BroadcastRecordingService.kt`** — recording logic is
  byte-for-byte identical to source. The **only** adaptation is the notification
  tap-target: the originals hard-referenced the Capacitor `MainActivity` (dropped
  in A3). They now resolve the target at runtime via
  `packageManager.getLaunchIntentForPackage(packageName)`, so B2's launcher
  Activity becomes the tap-target automatically with zero further edits. Until B2
  adds an Activity the "open" tap-target is simply absent — the notification, the
  broadcast **Stop** action, and all recording continue to work. Marked with
  `// TODO(android B2)`.
- **`BackgroundRecorderPlugin.kt` / `BroadcastRecorderPlugin.kt`** — **removed.**
  Their capability surface is reproduced by the interface + two impls below, with
  no Capacitor plugin types anywhere.

## The interface (replaces the Capacitor bridges)

`AudioRecorder` is the shared contract. `start` lives on each concrete class
because the two recorders start differently (mic = immediate; broadcast = needs a
MediaProjection consent result first).

```
interface AudioRecorder {
    val requiredPermissions: List<String>     // caller must hold these before start
    val state: StateFlow<RecorderState>       // IDLE / STARTING / RECORDING / FINISHED / ERROR
    val isRecording: Boolean                  // reads the service's live @Volatile state
    val currentError: String?
    suspend fun stop(): RecordingFile?        // suspends until file finalised, returns it
    fun currentFile(): RecordingFile?
    fun deleteRecording(): Boolean
}
```

Design: `stop()` is a **suspend fun** (replaces the plugin's Handler-poll →
resolve-with-filePath); `state` is a **StateFlow** for Compose `collectAsState()`;
errors surface as `RecorderState.ERROR` + a message string (not thrown
exceptions), mirroring the plugins' `reject(message)`.

### `BackgroundAudioRecorder(context)` — mic (was `BackgroundRecorderPlugin`)

| Plugin JS method            | Kotlin                                            |
|-----------------------------|---------------------------------------------------|
| `start()`                   | `fun start(): Boolean`                            |
| `stop()`                    | `suspend fun stop(): RecordingFile?`              |
| `getFile()`                 | `fun currentFile(): RecordingFile?`               |
| `deleteFile()`              | `fun deleteRecording(): Boolean`                  |
| `isRecording()`             | `val isRecording` + `val startTimeMs`             |

Drives `RecordingService` with the service's own action strings:
- start → `RecordingService.ACTION_START` = `com.wassup.meeting.ACTION_START_RECORDING` via `startForegroundService`
- stop  → `RecordingService.ACTION_STOP`  = `com.wassup.meeting.ACTION_STOP_RECORDING` via `startService`, then polls `RecordingService.isRecording` (100 ms, ~2 s cap) before returning the file.

### `BroadcastAudioRecorder(context)` — MediaProjection (was `BroadcastRecorderPlugin`)

| Plugin JS method            | Kotlin                                                        |
|-----------------------------|--------------------------------------------------------------|
| `isSupported()`             | `fun isSupported(): Boolean` (Android 10+)                    |
| `startBroadcast()`          | `fun mediaProjectionConsentIntent(): Intent?` + `fun start(resultCode, resultData): Boolean` |
| `stopBroadcast()`           | `suspend fun stop(): RecordingFile?`                          |
| `getStatus()`               | `fun status(): BroadcastStatus` (live telemetry snapshot)    |
| `getRecording()`            | `fun getRecording(): RecordingFile?` / `currentFile()`       |
| `clearRecording()`          | `fun deleteRecording(): Boolean`                             |

Drives `BroadcastRecordingService` with the service's own action strings + extras:
- start → `BroadcastRecordingService.ACTION_START` = `com.wassup.meeting.ACTION_START_BROADCAST_RECORDING`, with extras `EXTRA_RESULT_CODE` (`"resultCode"`) and `EXTRA_RESULT_DATA` (`"resultData"`) carrying the MediaProjection consent result, via `startForegroundService`.
- stop  → `BroadcastRecordingService.ACTION_STOP` = `com.wassup.meeting.ACTION_STOP_BROADCAST_RECORDING` via `startService`, then polls the service `state` to a terminal value before returning.

## What a caller (Track B2) must still wire

These were done inline by Capacitor; the interface only **declares** them and
leaves the flow to the Activity (each marked `// TODO(android B2)` in code):

1. **Runtime permissions** — request `AudioRecorder.requiredPermissions`
   (`RECORD_AUDIO`, plus `POST_NOTIFICATIONS` on Android 13+) **before** calling
   `start`. Use an `ActivityResultContracts.RequestMultiplePermissions` launcher.
   The recorders do **not** request them.
2. **MediaProjection consent** (broadcast only) — call
   `mediaProjectionConsentIntent()`, launch it from the Activity with an
   `ActivityResultLauncher<Intent>` (`StartActivityForResult`), and on
   `RESULT_OK` call `broadcastRecorder.start(result.resultCode, result.data!!)`.
   Consent can only be requested from an Activity, so it cannot live in this
   headless module.
3. **Launcher Activity** — add a Compose launcher `<activity>` to the manifest
   (the `<application>` here has a `// TODO(android B2)` placeholder). The
   notification tap-target resolves to it automatically via the package launch
   intent; no service edit is needed.
4. **Full build stack** — Compose, Media3, WorkManager, Retrofit/OkHttp, etc.
   are added to `app/build.gradle` in B2 (see the `// TODO(android B2)` there).
   This module only depends on AppCompat, core-ktx, annotation and coroutines.

## Not included on purpose

Capacitor runtime, `capacitor.build.gradle` / `capacitor.settings.gradle`, the
web assets, the Capacitor bridge Activity / `MainActivity`, splash/launcher icon
set, and any Capacitor npm dependency. Grepping this module for the Capacitor
plugin package, the Capacitor npm scope, or the bridge Activity class name
returns nothing — no Capacitor coupling remains.
