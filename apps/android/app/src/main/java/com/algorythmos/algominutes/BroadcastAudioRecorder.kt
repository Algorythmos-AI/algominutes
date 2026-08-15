package com.algorythmos.algominutes

import android.Manifest
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File

/**
 * MediaProjection meeting recorder — the Capacitor-free replacement for
 * `BroadcastRecorderPlugin`. Drives [BroadcastRecordingService] directly via
 * Intents, reusing the exact action strings + extras the service declares.
 *
 * The capture/mix/encode logic itself lives untouched in
 * [BroadcastRecordingService] (a §5 protected asset); this class is only the
 * thin, idiomatic control surface the plugin used to be.
 *
 * ## MediaProjection consent (owned by the caller)
 * MediaProjection needs an explicit user-granted consent Intent that can only
 * be launched from an Activity. The plugin did this inline with Capacitor's
 * `startActivityForResult`. Here the flow is split so the B2 Activity owns it:
 *   1. `val consent = recorder.mediaProjectionConsentIntent()`
 *   2. launch it with an `ActivityResultLauncher` (Activity concern)
 *   3. on RESULT_OK: `recorder.start(result.resultCode, result.data!!)`
 * See `// TODO(android B2)` on [mediaProjectionConsentIntent] / [start].
 *
 * @param context any Context; the application context is retained.
 */
class BroadcastAudioRecorder(context: Context) : AudioRecorder {

    private val appContext: Context = context.applicationContext

    private val _state = MutableStateFlow(
        RecorderState.fromServiceState(BroadcastRecordingService.state)
    )
    override val state: StateFlow<RecorderState> = _state.asStateFlow()

    /**
     * RECORD_AUDIO always; POST_NOTIFICATIONS on Android 13+. Note MediaProjection
     * consent is NOT a manifest permission — obtain it via
     * [mediaProjectionConsentIntent]. The B2 Activity must hold these before [start].
     */
    override val requiredPermissions: List<String> = buildList {
        add(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override val isRecording: Boolean
        get() = BroadcastRecordingService.state == "recording" ||
            BroadcastRecordingService.state == "starting"

    override val currentError: String?
        get() = BroadcastRecordingService.errorMessage

    /** AudioPlaybackCapture requires Android 10 (Q). Mirrors the plugin's isSupported(). */
    fun isSupported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

    /**
     * The MediaProjection consent Intent to launch from an Activity. Returns null
     * below Android 10 (unsupported).
     *
     * TODO(android B2): the launcher Activity registers an ActivityResultLauncher
     * for `StartActivityForResult`, launches this Intent, and on RESULT_OK calls
     * [start] with the result code + data. This module does NOT launch it (no
     * Activity here).
     */
    fun mediaProjectionConsentIntent(): Intent? {
        if (!isSupported()) return null
        val manager = appContext.getSystemService(Context.MEDIA_PROJECTION_SERVICE)
            as MediaProjectionManager
        return manager.createScreenCaptureIntent()
    }

    /**
     * Start meeting recording via [BroadcastRecordingService], forwarding the
     * MediaProjection consent result the caller obtained from
     * [mediaProjectionConsentIntent].
     *
     * PRECONDITION: [requiredPermissions] granted, and [resultCode]/[resultData]
     * come from a successful (RESULT_OK) consent launch. Passes them through as
     * the exact extras the service reads (EXTRA_RESULT_CODE / EXTRA_RESULT_DATA).
     *
     * @return true if a start was dispatched; false if unsupported or already running.
     */
    @RequiresApi(Build.VERSION_CODES.Q)
    fun start(resultCode: Int, resultData: Intent): Boolean {
        if (!isSupported()) return false
        if (isRecording) return false
        val intent = Intent(appContext, BroadcastRecordingService::class.java).apply {
            action = BroadcastRecordingService.ACTION_START
            putExtra(BroadcastRecordingService.EXTRA_RESULT_CODE, resultCode)
            putExtra(BroadcastRecordingService.EXTRA_RESULT_DATA, resultData)
        }
        ContextCompat.startForegroundService(appContext, intent)
        _state.value = RecorderState.STARTING
        return true
    }

    /**
     * Request stop and suspend until the encoder thread reaches a terminal state
     * ("finished"/"error"/"idle"), then return the completed recording (or null).
     * The old plugin's stopBroadcast() returned immediately; here we await
     * completion so the caller can use the file directly, consistent with the
     * [AudioRecorder] contract.
     */
    override suspend fun stop(): RecordingFile? {
        val intent = Intent(appContext, BroadcastRecordingService::class.java).apply {
            action = BroadcastRecordingService.ACTION_STOP
        }
        appContext.startService(intent)

        var attemptsLeft = 50 // ~5 s cap; encoder drain/mux finalisation is async
        while (isRecording && attemptsLeft > 0) {
            delay(100)
            attemptsLeft--
        }
        _state.value = RecorderState.fromServiceState(BroadcastRecordingService.state)
        return getRecording()
    }

    /**
     * On-demand live telemetry snapshot — the idiomatic equivalent of the
     * plugin's getStatus() (which JS polled). Reads the service's @Volatile
     * companion fields, the live source of truth.
     */
    fun status(): BroadcastStatus {
        val now = System.currentTimeMillis()
        val startedAt = BroadcastRecordingService.startedAtMs
        val finishedAt = BroadcastRecordingService.finishedAtMs
        val raw = BroadcastRecordingService.state
        val durationMs = when {
            startedAt <= 0L -> 0L
            raw == "starting" || raw == "recording" -> now - startedAt
            finishedAt > startedAt -> finishedAt - startedAt
            else -> 0L
        }
        return BroadcastStatus(
            state = RecorderState.fromServiceState(raw),
            rawState = raw,
            isBroadcasting = raw == "starting" || raw == "recording",
            hasCompletedRecording = BroadcastRecordingService.hasCompletedRecording(),
            durationMs = durationMs,
            recordingSizeBytes = BroadcastRecordingService.currentFilePath?.let { File(it).length() } ?: 0L,
            appAudioCaptured = BroadcastRecordingService.appAudioCaptured,
            micAudioCaptured = BroadcastRecordingService.micAudioCaptured,
            appAudioPeak = BroadcastRecordingService.appAudioPeak,
            micAudioPeak = BroadcastRecordingService.micAudioPeak,
            appAudioRms = BroadcastRecordingService.appAudioRms,
            micAudioRms = BroadcastRecordingService.micAudioRms,
            appActiveSamples = BroadcastRecordingService.appActiveSamples,
            micActiveSamples = BroadcastRecordingService.micActiveSamples,
            startedAtMs = startedAt,
            errorMessage = BroadcastRecordingService.errorMessage,
        )
    }

    /**
     * The completed, validated recording — mirrors the plugin's getRecording()
     * guards (file exists, >= 8 KB, some audio actually captured). Returns null
     * (rather than rejecting) when those preconditions are not met; inspect
     * [currentError] / [status] for the reason.
     */
    fun getRecording(): RecordingFile? {
        val path = BroadcastRecordingService.currentFilePath
        if (path.isNullOrEmpty()) return null
        val file = File(path)
        if (!file.exists()) return null
        if (file.length() < MIN_RECORDING_BYTES) return null
        if (!BroadcastRecordingService.hasAnyAudioCaptured()) return null
        return RecordingFile(path = path, mimeType = MIME_TYPE, sizeBytes = file.length())
    }

    /** Alias for the [AudioRecorder] contract; same as [getRecording]. */
    override fun currentFile(): RecordingFile? = getRecording()

    /**
     * Delete the current recording (if any) and reset service state — the
     * equivalent of the plugin's clearRecording(). Returns true if a file was deleted.
     */
    override fun deleteRecording(): Boolean {
        val path = BroadcastRecordingService.currentFilePath
        val deleted = if (!path.isNullOrEmpty()) {
            val file = File(path)
            file.exists() && file.delete()
        } else {
            false
        }
        BroadcastRecordingService.reset()
        _state.value = RecorderState.IDLE
        return deleted
    }

    companion object {
        const val TAG = "BroadcastAudioRecorder"
        private const val MIME_TYPE = "audio/mp4"
        private const val MIN_RECORDING_BYTES = 8 * 1024
    }
}
