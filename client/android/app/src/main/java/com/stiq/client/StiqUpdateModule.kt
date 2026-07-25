package com.stiq.client

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.security.MessageDigest
import java.security.cert.X509Certificate
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.jar.JarFile
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/**
 * StiqUpdate — the native half of STIQ's keyless, Tor-only in-app updater (T9).
 *
 * The updater NEVER trusts a store: it streams a signed release index and APK from the community's
 * update onion over Tor, verifies the JAR signer against a PINNED cert SHA-256, checks the APK's own
 * signing cert matches (same-signer, so an update can only be signed by the key that signed the
 * running build), then hands the APK to the OS PackageInstaller (which shows its own confirm UI).
 *
 * Transport reuses StiqHttpModule's proven leak-free SOCKS5 approach verbatim (raw socket to Tor's
 * SOCKS port, SOCKS5 CONNECT with ATYP=domain so Tor resolves the host — no local DNS leak, optional
 * TLS with SNI + system trust + hostname verification), but STREAMS the body straight to a file under
 * cacheDir/updates while folding it through a SHA-256 digest and a hard maxBytes cap — a multi-MB APK
 * never gets base64'd across the RN bridge.
 *
 * Device-only contract (jest-absent; JS side is faked in T9-S4):
 *   downloadToFile streams a >20MB file over Tor, returns a matching sha256, rejects on overflow/mismatch.
 *   readSignedIndex rejects an index-v1.jar signed by any cert other than the pinned one.
 *   verifyApkSigner returns valid=false for a foreign-key APK, valid=true + versionCode for the app key.
 *   installApk launches the OS PackageInstaller confirm dialog and resolves(true) once commit is issued.
 */
class StiqUpdateModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "StiqUpdate"

    // Bounded worker pool (mirrors StiqHttpModule): downloads/verification are independent and
    // long-blocking, so keep them off the RN bridge thread but capped so a burst can't spawn dozens.
    private val pool = ThreadPoolExecutor(
        0, 4, 30L, TimeUnit.SECONDS, LinkedBlockingQueue(),
    ) { r -> Thread(r, "StiqUpdate").apply { isDaemon = true } }

    @Volatile private var installReceiverRegistered = false

    // ── Version identity ─────────────────────────────────────────────────────────────────────

    @ReactMethod
    fun appVersionName(promise: Promise) {
        pool.execute {
            try {
                promise.resolve(BuildConfig.VERSION_NAME)
            } catch (e: Exception) {
                promise.reject("VERSION_ERROR", e.message ?: "version name failed")
            }
        }
    }

    @ReactMethod
    fun appVersionCode(promise: Promise) {
        pool.execute {
            try {
                promise.resolve(BuildConfig.VERSION_CODE.toDouble())
            } catch (e: Exception) {
                promise.reject("VERSION_ERROR", e.message ?: "version code failed")
            }
        }
    }

    @ReactMethod
    fun appPackageName(promise: Promise) {
        pool.execute {
            try {
                promise.resolve(reactApplicationContext.packageName)
            } catch (e: Exception) {
                promise.reject("VERSION_ERROR", e.message ?: "package name failed")
            }
        }
    }

    // ── Streamed Tor download ────────────────────────────────────────────────────────────────

    /**
     * opts = {url, socksHost?, socksPort?, socksUser?, socksPass?, timeoutMs?, maxBytes?, expectedSha256?}
     * Streams the response body to cacheDir/updates/<sanitized-name>, folding it through SHA-256 and
     * capping at maxBytes. Rejects on non-2xx, overflow, or (when given) a sha mismatch. Resolves
     * {path, sha256, size}.
     */
    @ReactMethod
    fun downloadToFile(opts: ReadableMap, promise: Promise) {
        pool.execute {
            var socket: Socket? = null
            var outFile: File? = null
            try {
                val urlStr = opts.getString("url") ?: throw Exception("missing url")
                val socksHost = opts.getString("socksHost") ?: "127.0.0.1"
                val socksPort = if (opts.hasKey("socksPort")) opts.getInt("socksPort") else 9050
                val socksUser = opts.getString("socksUser") ?: ""
                val socksPass = opts.getString("socksPass") ?: ""
                val timeoutMs = if (opts.hasKey("timeoutMs")) opts.getInt("timeoutMs") else 60_000
                val maxBytes = if (opts.hasKey("maxBytes")) opts.getDouble("maxBytes").toLong() else 100L * 1024 * 1024
                val expectedSha = opts.getString("expectedSha256")?.lowercase()

                val uri = URI(urlStr)
                val https = uri.scheme.equals("https", ignoreCase = true)
                val host = uri.host ?: throw Exception("bad url host")
                val port = if (uri.port > 0) uri.port else if (https) 443 else 80
                val path = buildString {
                    append(if (uri.rawPath.isNullOrEmpty()) "/" else uri.rawPath)
                    if (!uri.rawQuery.isNullOrEmpty()) append("?").append(uri.rawQuery)
                }

                val raw = Socket()
                socket = raw
                raw.connect(InetSocketAddress(socksHost, socksPort), timeoutMs)
                raw.soTimeout = timeoutMs
                socks5Connect(
                    BufferedInputStream(raw.getInputStream()),
                    raw.getOutputStream(),
                    host,
                    port,
                    socksUser,
                    socksPass,
                )

                val conn: Socket = if (https) {
                    val factory = SSLSocketFactory.getDefault() as SSLSocketFactory
                    val ssl = factory.createSocket(raw, host, port, true) as SSLSocket
                    ssl.soTimeout = timeoutMs
                    ssl.startHandshake()
                    val verifier = HttpsURLConnection.getDefaultHostnameVerifier()
                    if (!verifier.verify(host, ssl.session)) {
                        throw Exception("TLS hostname verification failed for $host")
                    }
                    socket = ssl
                    ssl
                } else {
                    raw
                }

                val input = BufferedInputStream(conn.getInputStream())
                val output = conn.getOutputStream()
                writeGet(output, host, port, path, https)

                val (status, headers) = readStatusAndHeaders(input)
                if (status !in 200..299) throw Exception("HTTP $status")

                val dir = File(reactApplicationContext.cacheDir, "updates").apply { mkdirs() }
                val safeName = sanitizeName(uri.rawPath?.substringAfterLast('/'))
                outFile = File(dir, safeName)

                val digest = MessageDigest.getInstance("SHA-256")
                val size = streamBodyToFile(input, headers, outFile, digest, maxBytes)
                val sha = toHex(digest.digest())

                if (expectedSha != null && expectedSha != sha) {
                    outFile.delete()
                    promise.reject("SHA_MISMATCH", "expected $expectedSha got $sha")
                    return@execute
                }

                val result = WritableNativeMap().apply {
                    putString("path", outFile.absolutePath)
                    putString("sha256", sha)
                    putDouble("size", size.toDouble())
                }
                promise.resolve(result)
            } catch (e: Exception) {
                try { outFile?.delete() } catch (_: Exception) {}
                promise.reject("DOWNLOAD_ERROR", e.message ?: "download failed")
            } finally {
                try { socket?.close() } catch (_: Exception) {}
            }
        }
    }

    // ── Signed index verification ────────────────────────────────────────────────────────────

    /**
     * Open a JAR-signed index (index-v1.jar) with verification ON, force-read every signed content
     * entry so its signature is checked, and require each entry's LEAF signer cert SHA-256 to equal
     * the pinned expectedCertSha256. Any unsigned or foreign-signed entry rejects INDEX_UNSIGNED.
     * Resolves {jsonBase64} with the base64 of the 'index-v1.json' entry bytes.
     */
    @ReactMethod
    fun readSignedIndex(path: String, expectedCertSha256: String, promise: Promise) {
        pool.execute {
            try {
                val expected = expectedCertSha256.lowercase()
                var indexBytes: ByteArray? = null
                JarFile(File(path), true).use { jar ->
                    val entries = jar.entries()
                    while (entries.hasMoreElements()) {
                        val entry = entries.nextElement()
                        if (entry.isDirectory) continue
                        val name = entry.name
                        if (name.startsWith("META-INF/")) continue
                        // Fully reading the entry is what forces JarFile to verify its signature and
                        // populate entry.certificates.
                        val bytes = jar.getInputStream(entry).use { it.readBytes() }
                        val certs = entry.certificates ?: throw Exception("unsigned entry: $name")
                        val leaf = certs.firstOrNull() as? X509Certificate
                            ?: throw Exception("no X509 signer for $name")
                        if (toHex(sha256(leaf.encoded)) != expected) {
                            throw Exception("signer mismatch on $name")
                        }
                        if (name == "index-v1.json") indexBytes = bytes
                    }
                }
                val idx = indexBytes ?: throw Exception("index-v1.json entry missing")
                val result = WritableNativeMap().apply {
                    putString("jsonBase64", Base64.encodeToString(idx, Base64.NO_WRAP))
                }
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("INDEX_UNSIGNED", e.message ?: "index verification failed")
            }
        }
    }

    /**
     * Read an APK archive's signing cert and compare its SHA-256 to the pinned expectedCertSha256
     * (same-signer gate). Does NOT install. Resolves {valid, versionCode, versionName, packageName}.
     */
    @ReactMethod
    fun verifyApkSigner(path: String, expectedCertSha256: String, promise: Promise) {
        pool.execute {
            try {
                val expected = expectedCertSha256.lowercase()
                val pm = reactApplicationContext.packageManager
                val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    PackageManager.GET_SIGNING_CERTIFICATES
                } else {
                    @Suppress("DEPRECATION") PackageManager.GET_SIGNATURES
                }
                val info = pm.getPackageArchiveInfo(path, flags) ?: throw Exception("cannot read apk")

                val signerBytes: ByteArray = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    val si = info.signingInfo ?: throw Exception("no signingInfo")
                    (si.apkContentsSigners?.firstOrNull() ?: throw Exception("no apk signer")).toByteArray()
                } else {
                    @Suppress("DEPRECATION")
                    (info.signatures?.firstOrNull() ?: throw Exception("no apk signer")).toByteArray()
                }
                val valid = toHex(sha256(signerBytes)) == expected

                val pkg = info.packageName ?: info.applicationInfo?.packageName ?: ""
                val versionName = info.versionName ?: ""
                val versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    info.longVersionCode
                } else {
                    @Suppress("DEPRECATION") info.versionCode.toLong()
                }

                val result = WritableNativeMap().apply {
                    putBoolean("valid", valid)
                    putDouble("versionCode", versionCode.toDouble())
                    putString("versionName", versionName)
                    putString("packageName", pkg)
                }
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("VERIFY_ERROR", e.message ?: "verify failed")
            }
        }
    }

    // ── Install ──────────────────────────────────────────────────────────────────────────────

    /**
     * Stream the (already verified) APK into a PackageInstaller MODE_FULL_INSTALL session and commit.
     * The OS shows its own install-confirm UI; the user must have granted "install unknown apps"
     * first (JS checks canRequestPackageInstalls). Resolves(true) as soon as commit is issued — the
     * final result arrives via the system UI, so we do not block on it.
     */
    @ReactMethod
    fun installApk(path: String, promise: Promise) {
        pool.execute {
            try {
                val ctx = reactApplicationContext
                val file = File(path)
                if (!file.exists()) throw Exception("apk not found: $path")

                val installer = ctx.packageManager.packageInstaller
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
                val sessionId = installer.createSession(params)
                installer.openSession(sessionId).use { session ->
                    session.openWrite("stiq_update.apk", 0, file.length()).use { out ->
                        FileInputStream(file).use { it.copyTo(out) }
                        session.fsync(out)
                    }
                    registerInstallStatusReceiver(ctx)
                    val statusIntent = Intent(INSTALL_STATUS_ACTION).setPackage(ctx.packageName)
                    val piFlags = PendingIntent.FLAG_UPDATE_CURRENT or
                        (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
                    val pending = PendingIntent.getBroadcast(ctx, sessionId, statusIntent, piFlags)
                    session.commit(pending.intentSender)
                }
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("INSTALL_ERROR", e.message ?: "install failed")
            }
        }
    }

    /**
     * Register (once) a runtime receiver that surfaces the PackageInstaller confirm dialog: on the
     * STATUS_PENDING_USER_ACTION callback it launches the OS-supplied confirm intent. Runtime-only, so
     * no manifest receiver is needed.
     */
    private fun registerInstallStatusReceiver(ctx: Context) {
        if (installReceiverRegistered) return
        installReceiverRegistered = true
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) {
                val status = intent.getIntExtra(
                    PackageInstaller.EXTRA_STATUS,
                    PackageInstaller.STATUS_FAILURE,
                )
                if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                    val confirm: Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                    } else {
                        @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
                    }
                    confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    if (confirm != null) c.startActivity(confirm)
                }
            }
        }
        val filter = IntentFilter(INSTALL_STATUS_ACTION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            ctx.registerReceiver(receiver, filter)
        }
    }

    // ── SOCKS5 (RFC 1928) + optional user/pass (RFC 1929) — copied from StiqHttpModule ─────────

    private fun socks5Connect(
        input: InputStream,
        output: OutputStream,
        host: String,
        port: Int,
        user: String,
        pass: String,
    ) {
        val useAuth = user.isNotEmpty() || pass.isNotEmpty()
        if (useAuth) {
            output.write(byteArrayOf(0x05, 0x02, 0x00, 0x02))
        } else {
            output.write(byteArrayOf(0x05, 0x01, 0x00))
        }
        output.flush()
        val sel = readFully(input, 2)
        if (sel[0].toInt() != 0x05) throw Exception("bad SOCKS version")
        when (sel[1].toInt() and 0xff) {
            0x00 -> {}
            0x02 -> {
                val u = user.toByteArray(Charsets.UTF_8)
                val p = pass.toByteArray(Charsets.UTF_8)
                val req = ByteArray(3 + u.size + p.size)
                req[0] = 0x01
                req[1] = u.size.toByte()
                System.arraycopy(u, 0, req, 2, u.size)
                req[2 + u.size] = p.size.toByte()
                System.arraycopy(p, 0, req, 3 + u.size, p.size)
                output.write(req); output.flush()
                val ar = readFully(input, 2)
                if (ar[1].toInt() != 0x00) throw Exception("SOCKS auth failed")
            }
            else -> throw Exception("SOCKS auth method refused")
        }

        val h = host.toByteArray(Charsets.US_ASCII)
        val req = ByteArray(4 + 1 + h.size + 2)
        req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03
        req[4] = h.size.toByte()
        System.arraycopy(h, 0, req, 5, h.size)
        req[5 + h.size] = ((port shr 8) and 0xff).toByte()
        req[6 + h.size] = (port and 0xff).toByte()
        output.write(req); output.flush()

        val rep = readFully(input, 4)
        if (rep[1].toInt() != 0x00) throw Exception(SocksReply.failure(rep[1]))
        when (rep[3].toInt()) {
            0x01 -> readFully(input, 6)
            0x04 -> readFully(input, 18)
            0x03 -> { val l = readFully(input, 1)[0].toInt() and 0xff; readFully(input, l + 2) }
            else -> throw Exception("SOCKS bad ATYP")
        }
    }

    // ── HTTP/1.1 GET + streamed body ───────────────────────────────────────────────────────────

    private fun writeGet(output: OutputStream, host: String, port: Int, path: String, https: Boolean) {
        val hostHeader = if ((https && port == 443) || (!https && port == 80)) host else "$host:$port"
        val sb = StringBuilder()
        sb.append("GET $path HTTP/1.1\r\n")
        sb.append("Host: $hostHeader\r\n")
        // Pinned generic UA; no Referer/Cookie (identity hygiene, matches StiqHttpModule).
        sb.append("User-Agent: Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0\r\n")
        sb.append("Accept: */*\r\n")
        sb.append("Connection: close\r\n")
        sb.append("\r\n")
        output.write(sb.toString().toByteArray(Charsets.US_ASCII))
        output.flush()
    }

    private fun readStatusAndHeaders(input: InputStream): Pair<Int, Map<String, String>> {
        val statusLine = readLine(input)
        val parts = statusLine.split(" ", limit = 3)
        if (parts.size < 2) throw Exception("bad status line: $statusLine")
        val status = parts[1].toIntOrNull() ?: throw Exception("bad status code")
        val headers = LinkedHashMap<String, String>()
        while (true) {
            val line = readLine(input)
            if (line.isEmpty()) break
            val idx = line.indexOf(':')
            if (idx <= 0) continue
            val key = line.substring(0, idx).trim().lowercase()
            val value = line.substring(idx + 1).trim()
            headers[key] = value
        }
        return Pair(status, headers)
    }

    /** Stream body → file, folding through the digest, enforcing maxBytes. Returns bytes written. */
    private fun streamBodyToFile(
        input: InputStream,
        headers: Map<String, String>,
        outFile: File,
        digest: MessageDigest,
        maxBytes: Long,
    ): Long {
        val chunked = headers["transfer-encoding"]?.contains("chunked", true) == true
        val len = headers["content-length"]?.toLongOrNull()
        var total = 0L
        FileOutputStream(outFile).use { fos ->
            val out = BufferedOutputStream(fos)
            if (chunked) {
                while (true) {
                    val sizeLine = readLine(input).trim()
                    val size = sizeLine.split(";")[0].toLongOrNull(16) ?: break
                    if (size == 0L) break
                    total = copyN(input, size, out, digest, maxBytes, total)
                    readLine(input) // trailing CRLF after each chunk
                }
            } else if (len != null) {
                if (len > maxBytes) throw Exception("response exceeds $maxBytes bytes")
                total = copyN(input, len, out, digest, maxBytes, total)
            } else {
                // No length, not chunked: read until close, capped.
                val buf = ByteArray(16384)
                while (true) {
                    val r = input.read(buf)
                    if (r == -1) break
                    total += r
                    if (total > maxBytes) throw Exception("response exceeds $maxBytes bytes")
                    out.write(buf, 0, r); digest.update(buf, 0, r)
                }
            }
            out.flush()
        }
        return total
    }

    private fun copyN(
        input: InputStream,
        n: Long,
        out: OutputStream,
        digest: MessageDigest,
        maxBytes: Long,
        startTotal: Long,
    ): Long {
        var remaining = n
        var total = startTotal
        val buf = ByteArray(16384)
        while (remaining > 0) {
            val toRead = minOf(buf.size.toLong(), remaining).toInt()
            val r = input.read(buf, 0, toRead)
            if (r == -1) throw Exception("EOF before declared length")
            total += r
            if (total > maxBytes) throw Exception("response exceeds $maxBytes bytes")
            out.write(buf, 0, r); digest.update(buf, 0, r)
            remaining -= r
        }
        return total
    }

    // ── Low-level readers ────────────────────────────────────────────────────────────────────

    private fun readLine(input: InputStream): String {
        val sb = StringBuilder()
        while (true) {
            val b = input.read()
            if (b == -1) break
            if (b == '\n'.code) break
            if (b != '\r'.code) sb.append(b.toChar())
        }
        return sb.toString()
    }

    private fun readFully(input: InputStream, n: Int): ByteArray {
        val buf = ByteArray(n)
        var off = 0
        while (off < n) {
            val r = input.read(buf, off, n - off)
            if (r == -1) throw Exception("EOF")
            off += r
        }
        return buf
    }

    private fun sanitizeName(raw: String?): String {
        val base = if (raw.isNullOrEmpty()) "update.apk" else raw
        val safe = base.replace(Regex("[^A-Za-z0-9._-]"), "_")
        return if (safe.length > 128) safe.substring(safe.length - 128) else safe
    }

    private fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    private fun toHex(bytes: ByteArray): String {
        val hex = "0123456789abcdef"
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val i = b.toInt() and 0xff
            sb.append(hex[i shr 4]); sb.append(hex[i and 0x0f])
        }
        return sb.toString()
    }

    companion object {
        private const val INSTALL_STATUS_ACTION = "com.stiq.client.ACTION_UPDATE_INSTALL_STATUS"
    }
}
