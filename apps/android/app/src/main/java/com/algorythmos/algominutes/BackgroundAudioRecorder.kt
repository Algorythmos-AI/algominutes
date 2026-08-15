package com.algorythmos.algominutes

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File

/**
 * Microphone recorder — the Capacitor-free replacement for
 * `BackgroundRecorderPlugin`. Drives [RecordingService] directly via Intents,
 * reusing the exact action strings the service declares.
 *
 * The recording logic itself lives untouched in [RecordingService] (a §5
 * protected asset); this class is only the thin, idiomatic control surface the
 * plugin used to be.
 *
 * @param context any Context; the application context is retained.
 */
class BackgroundAudioRecorder(context: Context) : AudioRecorder {

    private val appContext: Context = context.applicationContext

    private val _state = MutableStateFlow(
        if (RecordingService.isRecording) RecorderState.RECORDING else RecorderState.IDLE
    )
    override val state: StateFlow<RecorderState> = _state.asStateFlow()

    /**
     * RECORD_AUDIO always; POST_NOTIFICATIONS on Android 13+ (for the foreground
     * service notification). The old plugin requested these inline via Capacitor
     * — the B2 Activity must hold them before calling [start].
     */
    override val requiredPermissions: List<String> = buildList {
        add(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override val isRecording: Boolean
        get() = RecordingService.isRecording

    override val currentError: String?
        get() = null // BackgroundRecorder surfaces failures by stopping; no message channel.

    /** Epoch millis the current recording started at, or 0. Mirrors isRecording().startTimeMs. */
    val startTimeMs: Long
        get() = RecordingService.startTimeMs

    /**
     * Start microphone recording via [RecordingService].
     *
     * PRECONDITION: [requiredPermissions] are granted. This method does NOT
     * request them — see the class KDoc / interface contract.
     * TODO(android B2): the launcher Activity requests RECORD_AUDIO (+ 13+
     * POST_NOTIFICATIONS) before invoking this.
     *
     * @return true if a start was dispatched; false if already recording.
     */
    fun start(): Boolean {
        if (RecordingService.isRecording) {
            Log.w(TAG, "A recording is already in progress")
            return false
        }
        val intent = Intent(appContext, RecordingService::class.java).apply {
            action = RecordingService.ACTION_START
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            appContext.startForegroundService(intent)
        } else {
            appContext.startService(intent)
        }
        _state.value = RecorderState.RECORDING
        Log.i(TAG, "Recording service start requested")
        return true
    }

    /**
     * Stop recording and suspend until [RecordingService] finishes writing the
     * file (polled every 100 ms, ~2 s cap — same policy the plugin used), then
     * return the finalised file.
     */
    override suspend fun stop(): RecordingFile? {
        if (!RecordingService.isRecording) {
            return currentFile()
        }
        // Capture the path before stopping — it is still valid here.
        val filePath = RecordingService.currentFilePath

        val intent = Intent(appContext, RecordingService::class.java).apply {
            action = RecordingService.ACTION_STOP
        }
        appContext.startService(intent)
        Log.i(TAG, "Recording service stop requested")

        var attemptsLeft = 20
        while (RecordingService.isRecording && attemptsLeft > 0) {
            delay(100)
            attemptsLeft--
        }
        _state.value = RecorderState.FINISHED

        if (filePath.isNullOrEmpty()) return null
        val file = File(filePath)
        if (!file.exists()) return null
        return RecordingFile(path = filePath, mimeType = MIME_TYPE, sizeBytes = file.length())
    }

    override fun currentFile(): RecordingFile? {
        val path = RecordingService.currentFilePath
        if (path.isNullOrEmpty()) return null
        val file = File(path)
        if (!file.exists()) return null
        return RecordingFile(path = path, mimeType = MIME_TYPE, sizeBytes = file.length())
    }

    override fun deleteRecording(): Boolean {
        val path = RecordingService.currentFilePath
        if (path.isNullOrEmpty()) return false
        val file = File(path)
        val deleted = file.exists() && file.delete()
        Log.i(TAG, "Deleted recording file: $deleted → $path")
        if (deleted) {
            RecordingService.resetFilePath()
            _state.value = RecorderState.IDLE
        }
        return deleted
    }

    companion object {
        const val TAG = "BackgroundAudioRecorder"
        private const val MIME_TYPE = "audio/mp4"
    }
}
