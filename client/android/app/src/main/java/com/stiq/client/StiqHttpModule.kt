package com.stiq.client

import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/**
 * StiqHttpModule — a single HTTP(S) request tunnelled through Tor's SOCKS5 proxy.
 *
 * This is the native half of src/media/torHttp.ts. It mirrors StiqSocketModule's proven,
 * leak-free approach: a raw java.net.Socket to the local Tor SOCKS port, a hand-rolled SOCKS5
 * CONNECT with the .onion/clearnet host sent to the proxy for REMOTE resolution (ATYP=domain
 * → no local DNS leak), and for https an SSLSocket layered on top (SNI + system trust store +
 * hostname verification). It then writes a minimal HTTP/1.1 request and reads one response,
 * capped at maxBytes.
 *
 * Why not OkHttp: StiqSocketModule documents that OkHttp's WebSocket over a SOCKS-proxied
 * .onion silently stops delivering frames. We keep all proxied I/O on raw sockets for the same
 * reason and to guarantee no connection escapes the proxy.
 *
 * Circuit isolation: socksUser/socksPass are passed as SOCKS5 username/password. Tor's
 * IsolateSOCKSAuth (on by default) gives each distinct credential pair its own circuit, so a
 * link/image fetch never shares a circuit with the relay stream or with another link.
 *
 * The module follows NO redirects and resolves NO DNS itself — torHttp.ts orchestrates
 * redirects so policy (onion-only, caps) is re-checked on every hop.
 */
class StiqHttpModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "StiqHttp"

    // Shared bounded worker pool instead of an unbounded thread-per-request. Requests are
    // independent (each gets its own Tor circuit via SOCKS auth), so ordering is irrelevant and
    // concurrency is fine; the cap keeps a burst of link/image fetches from spawning dozens of
    // threads that each block for the full Tor timeout. Idle threads are reaped after 30s.
    private val pool = ThreadPoolExecutor(
        0, 4, 30L, TimeUnit.SECONDS, java.util.concurrent.LinkedBlockingQueue(),
    ) { r -> Thread(r, "StiqHttp").apply { isDaemon = true } }

    @ReactMethod
    fun request(opts: ReadableMap, promise: Promise) {
        pool.execute {
            var socket: Socket? = null
            try {
                val method = opts.getString("method") ?: "GET"
                val urlStr = opts.getString("url") ?: throw Exception("missing url")
                val socksHost = opts.getString("socksHost") ?: "127.0.0.1"
                val socksPort = if (opts.hasKey("socksPort")) opts.getInt("socksPort") else 9050
                val socksUser = opts.getString("socksUser") ?: ""
                val socksPass = opts.getString("socksPass") ?: ""
                val maxBytes = if (opts.hasKey("maxBytes")) opts.getInt("maxBytes") else 5 * 1024 * 1024
                val timeoutMs = if (opts.hasKey("timeoutMs")) opts.getInt("timeoutMs") else 30_000
                val bodyB64 = opts.getString("bodyBase64") ?: ""
                val headerMap = opts.getMap("headers")

                val uri = URI(urlStr)
                val https = uri.scheme.equals("https", ignoreCase = true)
                val host = uri.host ?: throw Exception("bad url host")
                val port = if (uri.port > 0) uri.port else if (https) 443 else 80
                val path = buildString {
                    append(if (uri.rawPath.isNullOrEmpty()) "/" else uri.rawPath)
                    if (!uri.rawQuery.isNullOrEmpty()) append("?").append(uri.rawQuery)
                }

                // ── Raw TCP to Tor's SOCKS port, then SOCKS5 CONNECT to the remote host ──
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

                // ── Optionally layer TLS (https). The SSLSocket created over the proxied raw
                //    socket carries SNI=host and is verified against the system trust store. ──
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

                writeRequest(output, method, host, port, path, https, headerMap, bodyB64)
                val (status, headers) = readStatusAndHeaders(input)
                val body =
                    if (method.equals("HEAD", ignoreCase = true) || status == 204 || status == 304) {
                        ByteArray(0)
                    } else {
                        readBody(input, headers, maxBytes)
                    }

                val result = WritableNativeMap().apply {
                    putInt("status", status)
                    putMap("headers", WritableNativeMap().apply {
                        for ((k, v) in headers) putString(k, v)
                    })
                    putString("bodyBase64", Base64.encodeToString(body, Base64.NO_WRAP))
                }
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("HTTP_ERROR", e.message ?: "request failed")
            } finally {
                try { socket?.close() } catch (_: Exception) {}
            }
        }
    }

    // ── SOCKS5 (RFC 1928) + optional username/password auth (RFC 1929) ──────────────────────

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
            output.write(byteArrayOf(0x05, 0x02, 0x00, 0x02)) // offer NO-AUTH + USER/PASS
        } else {
            output.write(byteArrayOf(0x05, 0x01, 0x00)) // NO-AUTH only
        }
        output.flush()
        val sel = readFully(input, 2)
        if (sel[0].toInt() != 0x05) throw Exception("bad SOCKS version")
        when (sel[1].toInt() and 0xff) {
            0x00 -> {} // NO-AUTH accepted
            0x02 -> {
                val u = user.toByteArray(Charsets.UTF_8)
                val p = pass.toByteArray(Charsets.UTF_8)
                val req = ByteArray(3 + u.size + p.size)
                req[0] = 0x01 // auth subnegotiation version
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

        // CONNECT, ATYP=domain → Tor resolves the host (no local DNS leak).
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

    // ── HTTP/1.1 ────────────────────────────────────────────────────────────────────────────

    private fun writeRequest(
        output: OutputStream,
        method: String,
        host: String,
        port: Int,
        path: String,
        https: Boolean,
        headers: ReadableMap?,
        bodyB64: String,
    ) {
        val body = if (bodyB64.isNotEmpty()) Base64.decode(bodyB64, Base64.DEFAULT) else ByteArray(0)
        val hostHeader = if ((https && port == 443) || (!https && port == 80)) host else "$host:$port"
        val sb = StringBuilder()
        sb.append("$method $path HTTP/1.1\r\n")
        sb.append("Host: $hostHeader\r\n")
        var hasUa = false
        if (headers != null) {
            val it = headers.keySetIterator()
            while (it.hasNextKey()) {
                val k = it.nextKey()
                val v = headers.getString(k) ?: continue
                // Never forward identity-leaking headers even if a caller set them.
                if (k.equals("Referer", true) || k.equals("Cookie", true) || k.equals("Host", true)) continue
                if (k.equals("User-Agent", true)) hasUa = true
                sb.append("$k: $v\r\n")
            }
        }
        if (!hasUa) sb.append("User-Agent: Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0\r\n")
        if (body.isNotEmpty()) sb.append("Content-Length: ${body.size}\r\n")
        sb.append("Connection: close\r\n")
        sb.append("\r\n")
        output.write(sb.toString().toByteArray(Charsets.US_ASCII))
        if (body.isNotEmpty()) output.write(body)
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
            headers[key] = value // last value wins (fine for our needs: location, content-*)
        }
        return Pair(status, headers)
    }

    private fun readBody(input: InputStream, headers: Map<String, String>, maxBytes: Int): ByteArray {
        val chunked = headers["transfer-encoding"]?.contains("chunked", true) == true
        val len = headers["content-length"]?.toIntOrNull()
        val gzip = headers["content-encoding"]?.contains("gzip", true) == true

        // Fast path: a known Content-Length and no chunked framing lets us read straight into a
        // single right-sized buffer — no ByteArrayOutputStream growth-and-copy round-trip. This is
        // the common case for images and reader-mode pages.
        val bytes: ByteArray
        if (!chunked && len != null) {
            if (len > maxBytes) throw Exception("response exceeds $maxBytes bytes")
            bytes = if (len > 0) readFully(input, len) else ByteArray(0)
        } else {
            val raw = ByteArrayOutputStream()
            if (chunked) {
                while (true) {
                    val sizeLine = readLine(input).trim()
                    val size = sizeLine.split(";")[0].toIntOrNull(16) ?: break
                    if (size == 0) break
                    if (raw.size() + size > maxBytes) throw Exception("response exceeds $maxBytes bytes")
                    raw.write(readFully(input, size))
                    readLine(input) // trailing CRLF after each chunk
                }
            } else {
                // No length and not chunked: read until close, capped.
                val buf = ByteArray(8192)
                while (true) {
                    val r = input.read(buf)
                    if (r == -1) break
                    if (raw.size() + r > maxBytes) throw Exception("response exceeds $maxBytes bytes")
                    raw.write(buf, 0, r)
                }
            }
            bytes = raw.toByteArray()
        }

        if (gzip) {
            val inflated = GZIPInputStream(bytes.inputStream()).readBytes()
            if (inflated.size > maxBytes) throw Exception("decompressed response exceeds $maxBytes bytes")
            return inflated
        }
        return bytes
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
}
