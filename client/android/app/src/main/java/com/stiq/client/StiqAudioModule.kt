package com.stiq.client

import android.app.Activity
import android.content.Intent
import android.media.MediaMetadataRetriever
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableNativeMap
import java.io.File
import java.util.concurrent.Executors

/**
 * StiqAudioModule — self-contained voice recording + playback for NIP-A0 voice messages.
 *
 * STIQ has no media host: voice audio rides INLINE in the relay event (base64), so the module
 * records to a temp AAC/m4a file and returns the bytes as base64 (never a URL), and plays back
 * a base64 payload by staging it to a temp file. Mirrors the other Stiq* native modules; no
 * third-party audio dependency. RECORD_AUDIO must be granted (requested from JS) before record().
 */
class StiqAudioModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private var recorder: MediaRecorder? = null
    private var recordFile: File? = null
    private var recordStartMs: Long = 0
    private var player: MediaPlayer? = null

    // MediaRecorder and MediaPlayer are NOT thread-safe: every prepare/start/stop/release plus the
    // temp-file I/O and base64 codec work must run off the shared NativeModules bridge thread yet
    // stay on ONE thread so lifecycle calls never race. A single-thread executor gives us both, and
    // it preserves the natural start→stop ordering the JS side issues.
    private val audio = Executors.newSingleThreadExecutor { r -> Thread(r, "StiqAudio").apply { isDaemon = true } }

    // Pending promise for an in-flight importAudio() picker round-trip (resolved in onActivityResult).
    private var importPromise: Promise? = null

    // Listens for the system audio-picker result. On OK, reads the chosen file off the audio thread
    // (base64 + duration/mime probe) and resolves the promise with the SAME shape as stopRecording();
    // a cancel resolves null so JS can quietly no-op.
    private val activityListener: ActivityEventListener = object : BaseActivityEventListener() {
        override fun onActivityResult(activity: Activity?, requestCode: Int, resultCode: Int, data: Intent?) {
            if (requestCode != IMPORT_AUDIO_REQ) return
            val promise = importPromise ?: return
            importPromise = null
            val uri: Uri? = if (resultCode == Activity.RESULT_OK) data?.data else null
            if (uri == null) {
                promise.resolve(null) // cancelled / no selection
                return
            }
            audio.execute { readImportedAudio(uri, promise) }
        }
    }

    init {
        reactContext.addActivityEventListener(activityListener)
    }

    override fun getName(): String = "StiqAudio"

    /**
     * Open the system document picker for an audio file. Resolves {base64, mime, durationSec, size}
     * for the chosen clip (like stopRecording), null if the user cancels, or rejects on error. JS
     * enforces the inline size cap and shows the friendly limit message.
     */
    @ReactMethod
    fun importAudio(promise: Promise) {
        val activity = currentActivity
        if (activity == null) {
            promise.reject("IMPORT_ERROR", "no foreground activity")
            return
        }
        // A second call while one is pending supersedes the first (its picker was dismissed).
        importPromise?.resolve(null)
        importPromise = promise
        UiThreadUtil.runOnUiThread {
            try {
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "audio/*"
                    putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("audio/*"))
                }
                activity.startActivityForResult(intent, IMPORT_AUDIO_REQ)
            } catch (e: Exception) {
                importPromise = null
                promise.reject("IMPORT_ERROR", e.message ?: "could not open the file picker")
            }
        }
    }

    /** Read + encode a picked audio URI. Runs on the audio thread; never touches the recorder/player. */
    private fun readImportedAudio(uri: Uri, promise: Promise) {
        try {
            val cr = reactContext.contentResolver
            // Reject oversized files BEFORE reading them into memory (OOM guard). The precise inline
            // cap is enforced in JS; this is only a coarse ceiling.
            var size = -1L
            cr.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
                val idx = c.getColumnIndex(OpenableColumns.SIZE)
                if (idx >= 0 && c.moveToFirst() && !c.isNull(idx)) size = c.getLong(idx)
            }
            if (size > MAX_IMPORT_BYTES) {
                promise.reject("IMPORT_TOO_LARGE", "that file is too large — choose a short clip")
                return
            }
            val bytes = cr.openInputStream(uri)?.use { it.readBytes() }
                ?: throw Exception("could not open the file")
            if (bytes.isEmpty()) throw Exception("that file is empty")
            if (bytes.size > MAX_IMPORT_BYTES) {
                promise.reject("IMPORT_TOO_LARGE", "that file is too large — choose a short clip")
                return
            }
            var mime = cr.getType(uri) ?: "audio/mp4"
            var durationSec = 0
            val mmr = MediaMetadataRetriever()
            try {
                mmr.setDataSource(reactContext, uri)
                val durMs = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
                durationSec = (durMs / 1000L).toInt()
                val probed = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE)
                if (!probed.isNullOrEmpty()) mime = probed
            } catch (_: Exception) {
                // Non-fatal: fall back to the resolver mime + 0s duration.
            } finally {
                try { mmr.release() } catch (_: Exception) {}
            }
            val result = WritableNativeMap().apply {
                putString("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                putString("mime", if (mime.startsWith("audio/")) mime else "audio/mp4")
                putInt("durationSec", durationSec)
                putInt("size", bytes.size)
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("IMPORT_ERROR", e.message ?: "failed to read that audio file")
        }
    }

    /**
     * Begin recording. `bitRate` (bps) and `sampleRate` (Hz) come from JS (organizer-tunable via
     * stiq:audio-limits); out-of-range or 0 values fall back to the voice-optimised defaults. Audio
     * is always AAC-LC MONO in an MPEG-4/m4a container — mono halves the payload and voice is mono.
     * Lower defaults than the old 48kbps/44.1kHz cut a clip's bytes ~2x with no perceptible loss for
     * speech, and make the recorder's 60s duration cap agree with feed/voice.ts's byte cap.
     */
    @ReactMethod
    fun startRecording(bitRate: Int, sampleRate: Int, promise: Promise) {
        audio.execute {
            try {
                stopRecorderQuietly()
                val file = File.createTempFile("stiq_voice_", ".m4a", reactContext.cacheDir)
                val br = if (bitRate in MIN_BITRATE..MAX_BITRATE) bitRate else DEFAULT_BITRATE
                val sr = if (sampleRate in MIN_SAMPLE_RATE..MAX_SAMPLE_RATE) sampleRate else DEFAULT_SAMPLE_RATE
                @Suppress("DEPRECATION")
                val rec = MediaRecorder().apply {
                    setAudioSource(MediaRecorder.AudioSource.MIC)
                    setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                    setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                    setAudioChannels(1)
                    setAudioEncodingBitRate(br)
                    setAudioSamplingRate(sr)
                    setOutputFile(file.absolutePath)
                    prepare()
                    start()
                }
                recorder = rec
                recordFile = file
                recordStartMs = System.currentTimeMillis()
                promise.resolve(null)
            } catch (e: Exception) {
                stopRecorderQuietly()
                promise.reject("RECORD_ERROR", e.message ?: "failed to start recording")
            }
        }
    }

    /** Stop recording and return {base64, mime, durationSec}. Deletes the temp file. */
    @ReactMethod
    fun stopRecording(promise: Promise) {
        audio.execute {
            val rec = recorder
            val file = recordFile
            if (rec == null || file == null) {
                promise.reject("RECORD_ERROR", "not recording")
                return@execute
            }
            try {
                val durationSec = ((System.currentTimeMillis() - recordStartMs) / 1000.0).toInt()
                try { rec.stop() } finally { rec.release() }
                recorder = null
                recordFile = null
                val bytes = file.readBytes()
                file.delete()
                if (bytes.isEmpty()) throw Exception("empty recording")
                val result = WritableNativeMap().apply {
                    putString("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                    putString("mime", "audio/mp4")
                    putInt("durationSec", durationSec)
                    putInt("size", bytes.size)
                }
                promise.resolve(result)
            } catch (e: Exception) {
                recorder = null
                recordFile?.delete()
                recordFile = null
                promise.reject("RECORD_ERROR", e.message ?: "failed to stop recording")
            }
        }
    }

    /** Cancel an in-progress recording without returning audio. */
    @ReactMethod
    fun cancelRecording(promise: Promise) {
        audio.execute {
            stopRecorderQuietly()
            promise.resolve(null)
        }
    }

    /** Stage a base64 audio payload to a temp file and play it. Resolves when playback starts. */
    @ReactMethod
    fun playBase64(base64: String, promise: Promise) {
        audio.execute {
            try {
                stopPlayerQuietly()
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                val file = File.createTempFile("stiq_play_", ".m4a", reactContext.cacheDir)
                file.writeBytes(bytes)
                val mp = MediaPlayer().apply {
                    setDataSource(file.absolutePath)
                    setOnCompletionListener {
                        it.release()
                        file.delete()
                        if (player === it) player = null
                    }
                    prepare()
                    start()
                }
                player = mp
                promise.resolve(null)
            } catch (e: Exception) {
                stopPlayerQuietly()
                promise.reject("PLAY_ERROR", e.message ?: "failed to play audio")
            }
        }
    }

    @ReactMethod
    fun stopPlayback(promise: Promise) {
        audio.execute {
            stopPlayerQuietly()
            promise.resolve(null)
        }
    }

    private fun stopRecorderQuietly() {
        try { recorder?.stop() } catch (_: Exception) {}
        try { recorder?.release() } catch (_: Exception) {}
        recorder = null
        try { recordFile?.delete() } catch (_: Exception) {}
        recordFile = null
    }

    private fun stopPlayerQuietly() {
        try { player?.stop() } catch (_: Exception) {}
        try { player?.release() } catch (_: Exception) {}
        player = null
    }

    override fun onCatalystInstanceDestroy() {
        try { reactContext.removeActivityEventListener(activityListener) } catch (_: Exception) {}
        importPromise?.resolve(null)
        importPromise = null
        // Tear down on the audio thread so MediaRecorder/MediaPlayer are only ever touched there,
        // then stop accepting new work.
        try {
            audio.execute {
                stopRecorderQuietly()
                stopPlayerQuietly()
            }
        } catch (_: Exception) {}
        audio.shutdown()
    }

    companion object {
        // startActivityForResult request code (must fit the low 16 bits) for the audio picker.
        private const val IMPORT_AUDIO_REQ = 0xA0D1
        // Coarse OOM ceiling for a picked file; the exact inline cap lives in JS (feed/voice.ts).
        private const val MAX_IMPORT_BYTES = 2 * 1024 * 1024
        // AAC-LC encoder bounds. Defaults are voice-optimised (mono speech): 24kbps@24kHz keeps a 60s
        // clip ~176KB, under feed/voice.ts MAX_VOICE_BYTES. JS passes organizer-tuned values from
        // stiq:audio-limits; anything outside these bounds falls back to the default.
        private const val DEFAULT_BITRATE = 24_000
        private const val MIN_BITRATE = 8_000
        private const val MAX_BITRATE = 128_000
        private const val DEFAULT_SAMPLE_RATE = 24_000
        private const val MIN_SAMPLE_RATE = 8_000
        private const val MAX_SAMPLE_RATE = 48_000
    }
}
