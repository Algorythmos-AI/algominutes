package com.algorythmos.algominutes

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.io.File
import java.nio.ByteOrder
import kotlin.concurrent.thread
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Android equivalent of the iOS ReplayKit broadcast recorder.
 *
 * Uses MediaProjection + AudioPlaybackCapture (Android 10+) to capture meeting
 * app playback, mixes in the device microphone, and writes an AAC .m4a file.
 * Some apps can opt out of playback capture; in that case Android returns
 * silence for app audio, but the microphone track can still be recorded.
 *
 * PORTING NOTE (A3): recording logic is a §5 protected asset and is ported
 * UNCHANGED from the source Capacitor app. The ONLY adaptation is the
 * notification tap-target (see [buildNotification]); the dropped Capacitor
 * `MainActivity` is resolved at runtime via the package launch intent.
 */
@RequiresApi(Build.VERSION_CODES.Q)
class BroadcastRecordingService : Service() {

    companion object {
        const val TAG = "BroadcastRecordingService"
        const val CHANNEL_ID = "algominutes_broadcast_recording_channel"
        const val NOTIFICATION_ID = 1002
        const val ACTION_START = "com.algorythmos.algominutes.ACTION_START_BROADCAST_RECORDING"
        const val ACTION_STOP = "com.algorythmos.algominutes.ACTION_STOP_BROADCAST_RECORDING"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"

        private const val SAMPLE_RATE = 44_100
        private const val BIT_RATE = 96_000
        private const val CHANNEL_COUNT = 1
        private const val MIN_RECORDING_BYTES = 8 * 1024
        private const val NON_SILENT_THRESHOLD = 500
        private const val MIN_ACTIVE_SAMPLES = SAMPLE_RATE / 2

        @Volatile
        var state: String = "idle"
            private set

        @Volatile
        var currentFilePath: String? = null
            private set

        @Volatile
        var startedAtMs: Long = 0L
            private set

        @Volatile
        var finishedAtMs: Long = 0L
            private set

        @Volatile
        var errorMessage: String? = null
            private set

        @Volatile
        var appAudioPeak: Int = 0
            private set

        @Volatile
        var micAudioPeak: Int = 0
            private set

        @Volatile
        var appAudioRms: Double = 0.0
            private set

        @Volatile
        var micAudioRms: Double = 0.0
            private set

        @Volatile
        var appActiveSamples: Long = 0L
            private set

        @Volatile
        var micActiveSamples: Long = 0L
            private set

        @Volatile
        var appTotalSamples: Long = 0L
            private set

        @Volatile
        var micTotalSamples: Long = 0L
            private set

        @Volatile
        var appAudioCaptured: Boolean = false
            private set

        @Volatile
        var micAudioCaptured: Boolean = false
            private set

        private var appSquareSum: Double = 0.0
        private var micSquareSum: Double = 0.0

        fun reset() {
            state = "idle"
            currentFilePath = null
            startedAtMs = 0L
            finishedAtMs = 0L
            errorMessage = null
            resetAudioStats()
        }

        fun hasCompletedRecording(): Boolean {
            val path = currentFilePath ?: return false
            return state == "finished" && File(path).exists() && File(path).length() >= MIN_RECORDING_BYTES
        }

        fun hasAnyAudioCaptured(): Boolean = appAudioCaptured || micAudioCaptured

        fun resetAudioStats() {
            appAudioPeak = 0
            micAudioPeak = 0
            appAudioRms = 0.0
            micAudioRms = 0.0
            appActiveSamples = 0L
            micActiveSamples = 0L
            appTotalSamples = 0L
            micTotalSamples = 0L
            appAudioCaptured = false
            micAudioCaptured = false
            appSquareSum = 0.0
            micSquareSum = 0.0
        }

        fun accumulateAudioStats(appSamples: ShortArray, appCount: Int, micSamples: ShortArray, micCount: Int) {
            if (appCount > 0) {
                appTotalSamples += appCount.toLong()
                for (i in 0 until appCount) {
                    val abs = kotlin.math.abs(appSamples[i].toInt())
                    appAudioPeak = max(appAudioPeak, abs)
                    appSquareSum += (abs * abs).toDouble()
                    if (abs >= NON_SILENT_THRESHOLD) appActiveSamples += 1
                }
                appAudioRms = sqrt(appSquareSum / appTotalSamples.toDouble())
                appAudioCaptured = appActiveSamples >= MIN_ACTIVE_SAMPLES || appAudioPeak >= 1_500
            }

            if (micCount > 0) {
                micTotalSamples += micCount.toLong()
                for (i in 0 until micCount) {
                    val abs = kotlin.math.abs(micSamples[i].toInt())
                    micAudioPeak = max(micAudioPeak, abs)
                    micSquareSum += (abs * abs).toDouble()
                    if (abs >= NON_SILENT_THRESHOLD) micActiveSamples += 1
                }
                micAudioRms = sqrt(micSquareSum / micTotalSamples.toDouble())
                micAudioCaptured = micActiveSamples >= MIN_ACTIVE_SAMPLES || micAudioPeak >= 1_500
            }
        }
    }

    private var mediaProjection: MediaProjection? = null
    private var playbackRecord: AudioRecord? = null
    private var micRecord: AudioRecord? = null
    private var encoder: MediaCodec? = null
    private var muxer: MediaMuxer? = null
    private var recordingThread: Thread? = null

    @Volatile
    private var stopRequested = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
                @Suppress("DEPRECATION")
                val resultData = intent.getParcelableExtra(EXTRA_RESULT_DATA) as? Intent
                if (resultData == null) {
                    fail("Screen/audio capture permission was not granted.")
                } else {
                    startCapture(resultCode, resultData)
                }
            }
            ACTION_STOP -> stopCapture()
        }
        return START_NOT_STICKY
    }

    private fun startCapture(resultCode: Int, resultData: Intent) {
        if (state == "recording" || state == "starting") {
            Log.w(TAG, "Already recording - ignoring duplicate start request")
            return
        }

        state = "starting"
        errorMessage = null
        finishedAtMs = 0L
        resetAudioStats()
        stopRequested = false

        filesDir.listFiles { file -> file.name.startsWith("broadcast_") && file.name.endsWith(".m4a") }
            ?.forEach { old -> if (old.delete()) Log.d(TAG, "Cleaned up old broadcast recording: ${old.name}") }

        val outputFile = File(filesDir, "broadcast_${System.currentTimeMillis()}.m4a")
        currentFilePath = outputFile.absolutePath

        try {
            val notification = buildNotification()
            val serviceType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            } else {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            }
            startForeground(NOTIFICATION_ID, notification, serviceType)

            val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val projection = projectionManager.getMediaProjection(resultCode, resultData)
                ?: throw IllegalStateException("MediaProjection unavailable")
            projection.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    Log.i(TAG, "MediaProjection stopped by the system")
                    stopCapture()
                }
            }, Handler(Looper.getMainLooper()))
            mediaProjection = projection

            recordingThread = thread(name = "AlgoMinutesBroadcastEncoder") {
                runEncoder(outputFile)
            }
        } catch (err: Exception) {
            Log.e(TAG, "Failed to start broadcast recording", err)
            fail("Could not start Android meeting recording: ${err.message ?: "unknown error"}")
        }
    }

    private fun runEncoder(outputFile: File) {
        var muxerStarted = false
        var trackIndex = -1
        var presentationTimeUs = 0L
        val bufferInfo = MediaCodec.BufferInfo()

        try {
            val minBufferBytes = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
            val frameSamples = 1024
            val bufferBytes = max(minBufferBytes, frameSamples * 2 * 4)

            val audioFormat = AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                .build()

            playbackRecord = createPlaybackAudioRecord(audioFormat, bufferBytes)
            micRecord = createMicAudioRecord(audioFormat, bufferBytes)
            if (playbackRecord?.state != AudioRecord.STATE_INITIALIZED) {
                throw IllegalStateException("Android playback capture could not be initialized")
            }
            if (micRecord?.state != AudioRecord.STATE_INITIALIZED) {
                throw IllegalStateException("Microphone capture could not be initialized")
            }

            encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC).apply {
                val format = MediaFormat.createAudioFormat(
                    MediaFormat.MIMETYPE_AUDIO_AAC,
                    SAMPLE_RATE,
                    CHANNEL_COUNT
                )
                format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                format.setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE)
                configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                start()
            }
            muxer = MediaMuxer(outputFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

            playbackRecord?.startRecording()
            micRecord?.startRecording()
            state = "recording"
            startedAtMs = System.currentTimeMillis()
            Log.i(TAG, "Broadcast recording started -> ${outputFile.absolutePath}")

            val playbackSamples = ShortArray(frameSamples)
            val micSamples = ShortArray(frameSamples)
            val mixedSamples = ShortArray(frameSamples)

            while (!stopRequested) {
                val micSource = micRecord
                val playbackReadMode = if (micSource == null) AudioRecord.READ_BLOCKING else AudioRecord.READ_NON_BLOCKING
                val playbackRead = playbackRecord?.read(playbackSamples, 0, frameSamples, playbackReadMode) ?: 0
                val micRead = micSource?.read(micSamples, 0, frameSamples, AudioRecord.READ_BLOCKING) ?: 0
                val playbackCount = positiveRead(playbackRead)
                val micCount = positiveRead(micRead)
                val sampleCount = max(playbackCount, micCount)
                if (sampleCount <= 0) {
                    Thread.sleep(10)
                    continue
                }
                accumulateAudioStats(playbackSamples, playbackCount, micSamples, micCount)

                for (i in 0 until sampleCount) {
                    val appSample = if (i < playbackCount) playbackSamples[i].toInt() else 0
                    val micSample = if (i < micCount) micSamples[i].toInt() else 0
                    mixedSamples[i] = min(Short.MAX_VALUE.toInt(), max(Short.MIN_VALUE.toInt(), appSample + micSample)).toShort()
                }

                presentationTimeUs = queuePcmFrame(mixedSamples, sampleCount, presentationTimeUs)
                val drainResult = drainEncoder(bufferInfo, endOfStream = false, muxerStarted, trackIndex)
                muxerStarted = drainResult.first
                trackIndex = drainResult.second
            }

            queueEndOfStream(presentationTimeUs)
            while (true) {
                val drainResult = drainEncoder(bufferInfo, endOfStream = true, muxerStarted, trackIndex)
                muxerStarted = drainResult.first
                trackIndex = drainResult.second
                if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break
            }

            val bytes = outputFile.length()
            finishedAtMs = System.currentTimeMillis()
            state = if (bytes >= MIN_RECORDING_BYTES && hasAnyAudioCaptured()) "finished" else "error"
            errorMessage = if (state == "error") {
                if (bytes < MIN_RECORDING_BYTES) {
                    "Recording was too short. Please record for a few seconds longer."
                } else {
                    "No meeting audio was detected. Android may block playback capture for this app."
                }
            } else {
                null
            }
            Log.i(
                TAG,
                "Broadcast recording stopped -> ${outputFile.absolutePath} ($bytes bytes, appCaptured=$appAudioCaptured, micCaptured=$micAudioCaptured, appPeak=$appAudioPeak, micPeak=$micAudioPeak)"
            )
        } catch (err: Exception) {
            Log.e(TAG, "Broadcast recording failed", err)
            finishedAtMs = System.currentTimeMillis()
            state = "error"
            errorMessage = err.message ?: "Android meeting recording failed"
        } finally {
            releaseRecorder(playbackRecord)
            releaseRecorder(micRecord)
            playbackRecord = null
            micRecord = null

            try { encoder?.stop() } catch (_: Exception) {}
            try { encoder?.release() } catch (_: Exception) {}
            encoder = null

            try { muxer?.stop() } catch (_: Exception) {}
            try { muxer?.release() } catch (_: Exception) {}
            muxer = null

            try { mediaProjection?.stop() } catch (_: Exception) {}
            mediaProjection = null

            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun positiveRead(value: Int): Int = if (value > 0) value else 0

    private fun queuePcmFrame(samples: ShortArray, sampleCount: Int, presentationTimeUs: Long): Long {
        val codec = encoder ?: return presentationTimeUs
        val inputIndex = codec.dequeueInputBuffer(10_000)
        if (inputIndex < 0) return presentationTimeUs

        val inputBuffer = codec.getInputBuffer(inputIndex) ?: return presentationTimeUs
        inputBuffer.clear()
        inputBuffer.order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until sampleCount) inputBuffer.putShort(samples[i])
        codec.queueInputBuffer(
            inputIndex,
            0,
            sampleCount * 2,
            presentationTimeUs,
            0
        )
        return presentationTimeUs + (sampleCount * 1_000_000L / SAMPLE_RATE)
    }

    private fun queueEndOfStream(presentationTimeUs: Long) {
        val codec = encoder ?: return
        val inputIndex = codec.dequeueInputBuffer(10_000)
        if (inputIndex >= 0) {
            codec.queueInputBuffer(inputIndex, 0, 0, presentationTimeUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
        }
    }

    private fun drainEncoder(
        bufferInfo: MediaCodec.BufferInfo,
        endOfStream: Boolean,
        muxerStartedIn: Boolean,
        trackIndexIn: Int
    ): Pair<Boolean, Int> {
        val codec = encoder ?: return Pair(muxerStartedIn, trackIndexIn)
        val localMuxer = muxer ?: return Pair(muxerStartedIn, trackIndexIn)
        var muxerStarted = muxerStartedIn
        var trackIndex = trackIndexIn

        while (true) {
            val outputIndex = codec.dequeueOutputBuffer(bufferInfo, if (endOfStream) 10_000 else 0)
            when {
                outputIndex == MediaCodec.INFO_TRY_AGAIN_LATER -> return Pair(muxerStarted, trackIndex)
                outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    if (muxerStarted) throw IllegalStateException("Encoder format changed twice")
                    trackIndex = localMuxer.addTrack(codec.outputFormat)
                    localMuxer.start()
                    muxerStarted = true
                }
                outputIndex >= 0 -> {
                    val outputBuffer = codec.getOutputBuffer(outputIndex)
                    if (outputBuffer != null && bufferInfo.size > 0 && muxerStarted) {
                        outputBuffer.position(bufferInfo.offset)
                        outputBuffer.limit(bufferInfo.offset + bufferInfo.size)
                        localMuxer.writeSampleData(trackIndex, outputBuffer, bufferInfo)
                    }
                    codec.releaseOutputBuffer(outputIndex, false)
                    if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                        return Pair(muxerStarted, trackIndex)
                    }
                }
            }
        }
    }

    private fun createPlaybackAudioRecord(audioFormat: AudioFormat, bufferBytes: Int): AudioRecord {
        val projection = mediaProjection ?: throw IllegalStateException("MediaProjection unavailable")
        val captureConfig = AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .build()

        return AudioRecord.Builder()
            .setAudioFormat(audioFormat)
            .setBufferSizeInBytes(bufferBytes)
            .setAudioPlaybackCaptureConfig(captureConfig)
            .build()
    }

    private fun createMicAudioRecord(audioFormat: AudioFormat, bufferBytes: Int): AudioRecord? {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return null
        }
        return AudioRecord.Builder()
            .setAudioSource(android.media.MediaRecorder.AudioSource.VOICE_RECOGNITION)
            .setAudioFormat(audioFormat)
            .setBufferSizeInBytes(bufferBytes)
            .build()
    }

    private fun releaseRecorder(record: AudioRecord?) {
        try { record?.stop() } catch (_: Exception) {}
        try { record?.release() } catch (_: Exception) {}
    }

    private fun stopCapture() {
        if (state != "recording" && state != "starting") {
            stopSelf()
            return
        }
        stopRequested = true
    }

    private fun fail(message: String) {
        Log.e(TAG, message)
        state = "error"
        errorMessage = message
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Meeting recording",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Shows while AlgoMinutes records an online meeting"
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        // TODO(android B2): the Capacitor `MainActivity` was dropped in A3; the
        // launcher Activity is supplied by the Compose client (B2). We resolve
        // the package launch intent at runtime so no compile-time coupling to a
        // specific Activity remains. Until B2 supplies a launcher Activity the
        // "open" tap-target is simply absent; the "Stop" action still works.
        val openIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPendingIntent = openIntent?.let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        val stopIntent = Intent(this, BroadcastRecordingService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPendingIntent = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("AlgoMinutes")
            .setContentText("Recording online meeting audio")
            .setSmallIcon(R.drawable.ic_stat_algominutes)
            .setOngoing(true)
            .apply { openPendingIntent?.let { setContentIntent(it) } }
            .addAction(0, "Stop", stopPendingIntent)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }
}
