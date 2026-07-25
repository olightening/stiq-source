package com.stiq.client

import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

/**
 * StiqFiles — save a small text document (.ics calendar file, .csv guest export) into the
 * device's public Downloads collection, so "Added - check your downloads" is literally true.
 *
 * The app had NO file-save capability before this module (key backup is clipboard-only), and no
 * RN filesystem dependency is wanted. On API 29+ this uses MediaStore.Downloads, which needs no
 * storage permission and auto-uniquifies duplicate names. On the pre-29 floor (minSdk 24) it
 * falls back to the public Downloads directory; without WRITE_EXTERNAL_STORAGE that write fails
 * and the promise rejects — the JS layer treats any rejection as "not saved" and never shows a
 * false success state.
 */
class StiqFilesModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "StiqFiles"

    @ReactMethod
    fun saveTextFile(name: String, mime: String, content: String, promise: Promise) {
        Thread {
            try {
                // Defense in depth: the JS layer sanitizes, but never allow a path to escape
                // Downloads regardless of what crosses the bridge.
                val safeName = name
                    .replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1f]"), "_")
                    .trim()
                    .ifEmpty { "stiq-export.txt" }
                val bytes = content.toByteArray(Charsets.UTF_8)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val resolver = reactApplicationContext.contentResolver
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                        put(MediaStore.Downloads.MIME_TYPE, mime)
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    }
                    val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                    val uri = resolver.insert(collection, values)
                        ?: throw IllegalStateException("MediaStore insert failed")
                    try {
                        resolver.openOutputStream(uri)?.use { it.write(bytes) }
                            ?: throw IllegalStateException("openOutputStream failed")
                        values.clear()
                        values.put(MediaStore.Downloads.IS_PENDING, 0)
                        resolver.update(uri, values, null, null)
                    } catch (e: Exception) {
                        // Don't leave a pending ghost row behind on a failed write.
                        resolver.delete(uri, null, null)
                        throw e
                    }
                    promise.resolve(safeName)
                } else {
                    @Suppress("DEPRECATION")
                    val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                    if (!dir.exists() && !dir.mkdirs()) throw IllegalStateException("Downloads dir unavailable")
                    val dot = safeName.lastIndexOf('.')
                    val base = if (dot > 0) safeName.substring(0, dot) else safeName
                    val ext = if (dot > 0) safeName.substring(dot) else ""
                    var f = File(dir, safeName)
                    var i = 1
                    while (f.exists()) {
                        f = File(dir, "$base-$i$ext")
                        i++
                    }
                    f.writeBytes(bytes)
                    promise.resolve(f.name)
                }
            } catch (e: Exception) {
                promise.reject("SAVE_ERROR", e)
            }
        }.start()
    }
}
