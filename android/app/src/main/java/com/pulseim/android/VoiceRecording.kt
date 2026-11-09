package com.pulseim.android

import android.content.Context
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaRecorder
import android.os.Build
import java.io.File

/** Recorder output is accepted only after stop succeeds and an audio-only AAC track can be read. */
internal object VoiceRecording {
    const val MAX_DURATION_MS = 300000L
    const val MAX_BYTES = 10L * 1024 * 1024

    @Suppress("DEPRECATION")
    fun create(context: Context): MediaRecorder = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else MediaRecorder()

    fun checkedDuration(file: File, elapsedMs: Long): Long {
        require(elapsedMs > 0 && file.isFile && file.length() in 1..MAX_BYTES) { "未录制到有效语音，请重新录制" }
        val extractor = MediaExtractor()
        try {
            extractor.setDataSource(file.absolutePath)
            require(extractor.trackCount == 1) { "录音内容无效，请重新录制" }
            val format = extractor.getTrackFormat(0)
            require(format.getString(MediaFormat.KEY_MIME) == "audio/mp4a-latm" && format.containsKey(MediaFormat.KEY_DURATION)) { "录音格式无效，请重新录制" }
            val actualMs = format.getLong(MediaFormat.KEY_DURATION) / 1000
            // AAC can include one padded frame at the maximum recording boundary.
            require(actualMs in 1..(MAX_DURATION_MS + 1000)) { "录音时长无效，请重新录制" }
            extractor.selectTrack(0)
            require(extractor.sampleTime >= 0 && extractor.readSampleData(java.nio.ByteBuffer.allocate(64 * 1024), 0) > 0) { "录音没有有效音频，请重新录制" }
            return minOf(actualMs, elapsedMs, MAX_DURATION_MS).coerceAtLeast(1)
        } finally { extractor.release() }
    }
}
