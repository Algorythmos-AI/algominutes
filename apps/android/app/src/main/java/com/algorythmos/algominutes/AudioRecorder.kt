package com.algorythmos.algominutes

import kotlinx.coroutines.flow.StateFlow

/**
 * Capacitor-free audio-recorder contract (BUILD-PLAN A3).
 *
 * This replaces the two Capacitor plugin wrappers (`BackgroundRecorderPlugin`,
 * `BroadcastRecorderPlugin`) that previously bridged the recording services to
 * a JavaScript layer. It exposes the SAME capability surface those plugins
 * exposed to JS, but as an idiomatic Kotlin API that the future native Compose
 * client (Track B2) calls directly — no Capacitor plugin types anywhere.
 *
 * ## Design choices (documented, per the port brief)
 * - **`stop()` is a `suspend` fun.** The old `BackgroundRecorderPlugin.stop()`
 *   polled `RecordingService.isRecording` on a Handler every 100 ms and only
 *   resolved the JS promise once the file was finalised. The Kotlin equivalent
 *   is a suspend function that awaits the same condition with `delay` and
 *   returns the finished [RecordingFile]. Callers `launch { recorder.stop() }`.
 * - **State is observable via [state] (a [StateFlow]).** The services hold the
 *   source of truth in `@Volatile` companion fields; the recorder mirrors the
 *   lifecycle into a `StateFlow` at command boundaries so a Compose UI can
 *   `collectAsState()`. For the richer live telemetry the broadcast recorder
 *   exposes an on-demand snapshot (see `BroadcastAudioRecorder.status()`), which
 *   reads the service statics directly — that snapshot is the live source of
 *   truth, `state` is a coarse lifecycle signal.
 * - **Errors are surfaced as [RecorderState.ERROR] plus a message** on the
 *   status snapshot / [currentError], not as thrown exceptions, mirroring the
 *   plugins which `reject`ed with a message string.
 * - **Permissions & MediaProjection consent are NOT requested here.** The
 *   plugins used Capacitor's inline `requestPermissionForAlias` /
 *   `startActivityForResult`. That belongs to an Activity in the new world, so
 *   this interface only *declares the requirements* ([requiredPermissions], and
 *   `BroadcastAudioRecorder.mediaProjectionConsentIntent()`); the caller (B2
 *   Activity) owns the actual request/grant flow. See `// TODO(android B2)`.
 *
 * `start` is intentionally NOT on this base interface because the two recorders
 * start differently: the microphone recorder starts immediately, while the
 * broadcast recorder needs a MediaProjection consent result first. Each concrete
 * class declares its own `start` entry-point.
 */
interface AudioRecorder {

    /**
     * Runtime (dangerous) permissions the caller MUST hold before starting a
     * recording. The caller owns the request/grant flow.
     *
     * TODO(android B2): the Compose launcher Activity requests these (e.g. via
     * `ActivityResultContracts.RequestMultiplePermissions`) before calling
     * `start`. This module does not request them.
     */
    val requiredPermissions: List<String>

    /** Observable coarse lifecycle state. Safe to `collectAsState()` in Compose. */
    val state: StateFlow<RecorderState>

    /** Convenience: whether a capture is active right now (reads the service). */
    val isRecording: Boolean

    /** Last error message, or null. Populated when [state] is [RecorderState.ERROR]. */
    val currentError: String?

    /**
     * Request the recorder to stop and **suspend until the output file is
     * finalised**, returning it (or null if nothing usable was produced).
     * Equivalent to the plugins' stop()+poll then resolve-with-filePath.
     */
    suspend fun stop(): RecordingFile?

    /**
     * The current (or most recent) recording file, or null if there is none or
     * the file is missing on disk. Equivalent to the plugins' getFile().
     */
    fun currentFile(): RecordingFile?

    /**
     * Delete the current recording file and clear recorder state.
     * Returns true if a file was actually deleted. Equivalent to
     * deleteFile()/clearRecording().
     */
    fun deleteRecording(): Boolean
}

/** Coarse recorder lifecycle. Maps the services' internal state. */
enum class RecorderState {
    /** Nothing recorded / idle. */
    IDLE,

    /** Start requested, capture not yet running (broadcast: "starting"). */
    STARTING,

    /** Actively capturing audio. */
    RECORDING,

    /** Capture finished and a usable file exists. */
    FINISHED,

    /** Capture failed; see the error message. */
    ERROR;

    companion object {
        /** Maps `BroadcastRecordingService.state` ("idle"/"starting"/…) to enum. */
        fun fromServiceState(raw: String): RecorderState = when (raw) {
            "starting" -> STARTING
            "recording" -> RECORDING
            "finished" -> FINISHED
            "error" -> ERROR
            else -> IDLE
        }
    }
}

/**
 * A finished recording on disk. Mirrors the `{ filePath, mimeType, size }`
 * object the plugins resolved to JS. [path] is an absolute filesystem path in
 * the app's private `filesDir`; expose it to other apps via the FileProvider
 * (authority `${applicationId}.fileprovider`).
 */
data class RecordingFile(
    val path: String,
    val mimeType: String,
    val sizeBytes: Long,
)

/**
 * Live telemetry snapshot for the MediaProjection recorder. Mirrors the object
 * `BroadcastRecorderPlugin.getStatus()` returned to JS. Read on demand from the
 * service's `@Volatile` companion fields (the live source of truth).
 */
data class BroadcastStatus(
    val state: RecorderState,
    /** Raw service state string ("idle"/"starting"/"recording"/"finished"/"error"). */
    val rawState: String,
    val isBroadcasting: Boolean,
    val hasCompletedRecording: Boolean,
    val durationMs: Long,
    val recordingSizeBytes: Long,
    val appAudioCaptured: Boolean,
    val micAudioCaptured: Boolean,
    val appAudioPeak: Int,
    val micAudioPeak: Int,
    val appAudioRms: Double,
    val micAudioRms: Double,
    val appActiveSamples: Long,
    val micActiveSamples: Long,
    val startedAtMs: Long,
    val errorMessage: String?,
)
