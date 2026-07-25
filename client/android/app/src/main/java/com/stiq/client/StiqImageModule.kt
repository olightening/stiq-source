package com.stiq.client

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableNativeMap
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.security.MessageDigest

/**
 * StiqImageModule — Tier 2 image sanitization (PLAN.md §3.2).
 *
 * Decodes untrusted image bytes into a Bitmap, downscales, and RE-ENCODES to a fresh JPEG.
 * Re-encoding from a decoded Bitmap inherently DROPS all metadata (EXIF GPS/camera, ICC
 * profiles, embedded thumbnails) and normalizes the file to a single known-safe format —
 * neutering both the privacy leak of a geotagged photo and most "malicious file" polyglots.
 * A file the platform decoder rejects (or that isn't really an image) throws, so it never
 * reaches a renderer.
 *
 * Returns the sanitized bytes, their sha256 (the value pinned into the NIP-94 `imeta` `x`
 * tag), the dimensions, and a small RGBA thumbnail used by the JS BlurHash encoder.
 */
class StiqImageModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "StiqImage"

    @ReactMethod
    fun process(bytesBase64: String, maxDim: Int, promise: Promise) {
        Thread {
            try {
                val input = Base64.decode(bytesBase64, Base64.DEFAULT)
                val src = BitmapFactory.decodeByteArray(input, 0, input.size)
                    ?: throw Exception("input is not a decodable image")

                val limit = if (maxDim > 0) maxDim else 1280
                val scaled = scaleWithin(src, limit)

                val out = ByteArrayOutputStream()
                scaled.compress(Bitmap.CompressFormat.JPEG, 85, out)
                val processed = out.toByteArray()

                val thumb = makeThumb(scaled, 32)
                val tw = thumb.width
                val th = thumb.height
                val pixels = IntArray(tw * th)
                thumb.getPixels(pixels, 0, tw, 0, 0, tw, th)
                val rgba = ByteArray(tw * th * 4)
                for (i in pixels.indices) {
                    val p = pixels[i]
                    rgba[i * 4] = ((p shr 16) and 0xff).toByte()     // R
                    rgba[i * 4 + 1] = ((p shr 8) and 0xff).toByte()  // G
                    rgba[i * 4 + 2] = (p and 0xff).toByte()          // B
                    rgba[i * 4 + 3] = ((p shr 24) and 0xff).toByte() // A
                }

                val result = WritableNativeMap().apply {
                    putString("base64", Base64.encodeToString(processed, Base64.NO_WRAP))
                    putString("mime", "image/jpeg")
                    putInt("width", scaled.width)
                    putInt("height", scaled.height)
                    putInt("size", processed.size)
                    putString("sha256", sha256Hex(processed))
                    putMap("thumb", WritableNativeMap().apply {
                        putInt("width", tw)
                        putInt("height", th)
                        putString("rgbaBase64", Base64.encodeToString(rgba, Base64.NO_WRAP))
                    })
                }
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("IMAGE_ERROR", e.message ?: "image processing failed")
            }
        }.start()
    }

    /**
     * Decode an image and return the WHOLE photo as a width×height RGBA buffer for the Stiq Pictures
     * pixel engine (scaled down so the longer side ≤ maxSide — NO crop; the JS cropper frames it, so
     * the user can pan the full photo within the square viewport). This replaces the design pipeline's
     * canvas drawSquare→getImageData with a native decode; the median-cut/dither run in pure JS on the
     * returned bytes. Nothing leaves the device.
     */
    @ReactMethod
    fun pixels(bytesBase64: String, maxSide: Int, promise: Promise) {
        Thread {
            try {
                val input = Base64.decode(bytesBase64, Base64.DEFAULT)
                val decoded = BitmapFactory.decodeByteArray(input, 0, input.size)
                    ?: throw Exception("input is not a decodable image")
                // Apply EXIF orientation so the RGBA handed to the pixel engine is UPRIGHT — the same
                // orientation RN's <Image> shows for the picked photo (Fresco auto-applies EXIF).
                // Without this, the framing preview (uri, upright) and the pixelated output (raw
                // decode, EXIF-ignored) disagree, and a portrait photo's width/height come out
                // swapped so the square crop can't be panned across the whole image.
                val src = applyExifOrientation(decoded, input)

                val limit = if (maxSide in 1..2048) maxSide else 512
                val scaled = scaleWithin(src, limit) // whole photo, longer side ≤ limit
                val w = scaled.width
                val h = scaled.height

                val px = IntArray(w * h)
                scaled.getPixels(px, 0, w, 0, 0, w, h)
                val rgba = ByteArray(w * h * 4)
                for (i in px.indices) {
                    val p = px[i]
                    rgba[i * 4] = ((p shr 16) and 0xff).toByte()     // R
                    rgba[i * 4 + 1] = ((p shr 8) and 0xff).toByte()  // G
                    rgba[i * 4 + 2] = (p and 0xff).toByte()          // B
                    rgba[i * 4 + 3] = ((p shr 24) and 0xff).toByte() // A
                }

                val result = WritableNativeMap().apply {
                    putInt("width", w)
                    putInt("height", h)
                    putString("rgbaBase64", Base64.encodeToString(rgba, Base64.NO_WRAP))
                }
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("IMAGE_ERROR", e.message ?: "image processing failed")
            }
        }.start()
    }

    /**
     * Save a base64 PNG to the device's Pictures collection via MediaStore. Used by the Stiq
     * Pictures fullscreen viewer's "Save PNG" — the only place a picture is written to disk, so
     * saving stays a deliberate act. Uses MediaStore (no WRITE_EXTERNAL_STORAGE needed on API 29+).
     */
    @ReactMethod
    fun savePng(pngBase64: String, name: String, promise: Promise) {
        Thread {
            try {
                val bytes = Base64.decode(pngBase64, Base64.DEFAULT)
                val safeName = (if (name.isBlank()) "stiq-picture" else name).replace(Regex("[^A-Za-z0-9_-]"), "_")
                val filename = "$safeName-${System.currentTimeMillis()}.png"
                val resolver = reactApplicationContext.contentResolver
                val values = android.content.ContentValues().apply {
                    put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, filename)
                    put(android.provider.MediaStore.Images.Media.MIME_TYPE, "image/png")
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                        put(android.provider.MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Stiq")
                    }
                }
                val uri = resolver.insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                    ?: throw Exception("could not create image file")
                resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw Exception("could not open output")
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("SAVE_ERROR", e.message ?: "could not save image")
            }
        }.start()
    }

    /**
     * Rotate/flip a decoded bitmap per its EXIF orientation tag (JPEG). BitmapFactory ignores EXIF,
     * but RN's image view (Fresco) applies it, so the pixel engine must too or the framing preview
     * and the pixelated result won't match. A missing/normal tag is a no-op.
     */
    private fun applyExifOrientation(bmp: Bitmap, bytes: ByteArray): Bitmap {
        return try {
            val exif = ExifInterface(ByteArrayInputStream(bytes))
            val m = Matrix()
            when (exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
                ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
                ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
                ExifInterface.ORIENTATION_TRANSPOSE -> { m.postRotate(90f); m.postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_TRANSVERSE -> { m.postRotate(-90f); m.postScale(-1f, 1f) }
                else -> return bmp
            }
            val rotated = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
            if (rotated != bmp) bmp.recycle()
            rotated
        } catch (e: Exception) {
            bmp
        }
    }

    private fun scaleWithin(src: Bitmap, maxDim: Int): Bitmap {
        val w = src.width
        val h = src.height
        if (w <= maxDim && h <= maxDim) return src
        val ratio = maxDim.toDouble() / maxOf(w, h)
        val nw = maxOf(1, (w * ratio).toInt())
        val nh = maxOf(1, (h * ratio).toInt())
        return Bitmap.createScaledBitmap(src, nw, nh, true)
    }

    private fun makeThumb(src: Bitmap, maxDim: Int): Bitmap {
        val w = src.width
        val h = src.height
        val ratio = maxDim.toDouble() / maxOf(w, h)
        val nw = maxOf(1, (w * ratio).toInt())
        val nh = maxOf(1, (h * ratio).toInt())
        return Bitmap.createScaledBitmap(src, nw, nh, true)
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return digest.joinToString("") { "%02x".format(it) }
    }
}
