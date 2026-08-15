package com.algorythmos.algominutes

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import java.io.File

/**
 * Foreground Service that records audio using Android's native MediaRecorder.
 *
 * Running as a foreground service ensures the OS does not kill the recording
 * when the user locks the screen, switches apps, or the WebView is suspended.
 * A persistent notification ("Recording in progress…") is displayed for the
 * duration of the recording, as required by Android.
 *
 * PORTING NOTE (A3): recording logic is a §5 protected asset and is ported
 * UNCHANGED from the source Capacitor app. The ONLY adaptation is the
 * notification tap-target: the original hard-referenced the Capacitor
 * `MainActivity`, which no longer exists in this audio-only module. It is
 * resolved at runtime via the package launch intent so the future Compose
 * launcher Activity (Track B2) becomes the tap-target with no code change here.
 */
class RecordingService : Service() {

    companion object {
        const val TAG = "RecordingService"
        const val CHANNEL_ID = "algominutes_recording_channel"
        const val NOTIFICATION_ID = 1001
        const val ACTION_START = "com.algorythmos.algominutes.ACTION_START_RECORDING"
        const val ACTION_STOP = "com.algorythmos.algominutes.ACTION_STOP_RECORDING"

        /** Absolute path to the current recording file, or null if not recording. */
        @Volatile
        var currentFilePath: String? = null
            private set

        @Volatile
        var isRecording: Boolean = false
            private set

        @Volatile
        var startTimeMs: Long = 0L
            private set

        /** Called by the recorder after a successful deleteFile() to clear stale state. */
        fun resetFilePath() {
            currentFilePath = null
        }
    }

    private var recorder: MediaRecorder? = null

    override fun onBind(intent: Intent?): IBinder? = null

    @RequiresApi(Build.VERSION_CODES.O)
    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    @RequiresApi(Build.VERSION_CODES.R)
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startRecording()
            ACTION_STOP -> stopRecording()
        }
        return START_STICKY
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun startRecording() {
        if (isRecording) {
            Log.w(TAG, "Already recording — ignoring duplicate start request")
            return
        }

        // Clean up any orphaned recording files from previous sessions
        filesDir.listFiles { file -> file.name.startsWith("recording_") && file.name.endsWith(".m4a") }
            ?.forEach { old ->
                if (old.delete()) Log.d(TAG, "Cleaned up old recording: ${old.name}")
            }

        val outputFile = File(filesDir, "recording_${System.currentTimeMillis()}.m4a")
        currentFilePath = outputFile.absolutePath

        try {
            recorder = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(this)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }).apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioSamplingRate(44100)
                setAudioEncodingBitRate(64_000)
                setOutputFile(outputFile.absolutePath)

                // Detect mid-recording failures (hardware error, I/O error)
                setOnErrorListener { _, what, extra ->
                    Log.e(TAG, "MediaRecorder error during recording: what=$what extra=$extra")
                    isRecording = false
                    // The service will be stopped; the file may be partial
                    stopRecording()
                }

                // Detect max filesize / max duration limits (not set, but safety net)
                setOnInfoListener { _, what, _ ->
                    Log.w(TAG, "MediaRecorder info: what=$what")
                }

                prepare()
                start()
            }

            isRecording = true
            startTimeMs = System.currentTimeMillis()

            // Start foreground with the persistent notification
            val notification = buildNotification()
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            )

            Log.i(TAG, "Recording started → $currentFilePath")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start recording", e)
            isRecording = false
            currentFilePath = null
            stopSelf()
        }
    }

    private fun stopRecording() {
        try {
            recorder?.apply {
                stop()
                release()
            }
            Log.i(TAG, "Recording stopped → $currentFilePath")
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping recorder", e)
        } finally {
            recorder = null
            isRecording = false
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    override fun onDestroy() {
        // Safety net: if the service is destroyed while recording, stop cleanly
        if (isRecording) {
            stopRecording()
        }
        super.onDestroy()
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Recording",
            NotificationManager.IMPORTANCE_LOW     // Low = no sound, just persistent icon
        ).apply {
            description = "Shows while AlgoMinutes is recording audio"
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        // Tapping the notification re-opens the app.
        // TODO(android B2): the Capacitor `MainActivity` was dropped in A3; the
        // launcher Activity is supplied by the Compose client (B2). We resolve
        // the package launch intent at runtime so no compile-time coupling to a
        // specific Activity remains. Until B2 supplies a launcher Activity the
        // tap-target is simply absent (the notification and recording still work).
        val openIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = openIntent?.let {
            PendingIntent.getActivity(
                this, 0, it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("AlgoMinutes")
            .setContentText("Recording in progress…")
            .setSmallIcon(R.drawable.ic_stat_algominutes)
            .setOngoing(true)
            .apply { pendingIntent?.let { setContentIntent(it) } }
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }
}
