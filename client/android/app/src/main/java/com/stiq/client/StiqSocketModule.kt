package com.stiq.client

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.BufferedInputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Raw WebSockets routed through Tor's SOCKS5 proxy.
 *
 * The React Native module is process-global, but STIQ uses a long-lived feed socket alongside
 * short-lived enrollment and token-draw sockets. Every JS wrapper therefore supplies a socketId;
 * native state and emitted events are isolated by that id.
 *
 * Circuit isolation (audit #49): each connect passes a per-session SOCKS username/password. Tor's
 * IsolateSOCKSAuth (on by default) gives every distinct credential pair its own circuit, so the
 * long-lived feed/publish socket, the onboarding enrollment socket, and the token-draw socket are
 * NOT multiplexed onto one shared circuit — matching StiqHttpModule's proven isolation model. When
 * no credentials are supplied the handshake falls back to NO-AUTH for backward compatibility.
 */
class StiqSocketModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "StiqSocket"

    private val logTag = "StiqSocket"
    private val rng = SecureRandom()

    private class Connection {
        val writeLock = Any()
        @Volatile var closed = false
        var socket: Socket? = null
        var out: OutputStream? = null
        var writer: ExecutorService? = null
    }

    private val connections = ConcurrentHashMap<String, Connection>()

    @ReactMethod
    fun connect(
        socketId: String,
        url: String,
        socksHost: String,
        socksPort: Int,
        socksUser: String?,
        socksPass: String?,
        promise: Promise,
    ) {
        val connection = Connection()
        connections.put(socketId, connection)?.let(::closeConnection)
        android.util.Log.i(logTag, "$socketId connect start")

        Thread {
            try {
                val uri = URI(url)
                val host = uri.host ?: throw Exception("WebSocket URL has no host")
                val port = if (uri.port > 0) uri.port else 80
                val path = if (uri.rawPath.isNullOrEmpty()) "/" else uri.rawPath

                val socket = Socket()
                synchronized(connection.writeLock) {
                    if (connection.closed || connections[socketId] !== connection) {
                        try { socket.close() } catch (_: Exception) {}
                        return@Thread
                    }
                    connection.socket = socket
                }

                socket.connect(InetSocketAddress(socksHost, socksPort), 30_000)
                socket.soTimeout = 0
                val input = BufferedInputStream(socket.getInputStream())
                val output = socket.getOutputStream()

                socks5Connect(input, output, host, port, socksUser ?: "", socksPass ?: "")
                wsHandshake(input, output, host, port, path)

                synchronized(connection.writeLock) {
                    if (connection.closed || connections[socketId] !== connection) {
                        try { socket.close() } catch (_: Exception) {}
                        return@Thread
                    }
                    connection.out = output
                    connection.writer = Executors.newSingleThreadExecutor { runnable ->
                        Thread(runnable, "StiqSocket-write-$socketId").apply { isDaemon = true }
                    }
                }

                android.util.Log.i(logTag, "$socketId websocket open")
                emit(socketId, "open", null)
                promise.resolve(null)
                readLoop(input, socketId, connection)
            } catch (e: Exception) {
                // Reason inline, not just in the throwable dump: the field-diagnosis grep matches one
                // line per socket, and the SOCKS cause (see SocksReply) is the whole point of it.
                android.util.Log.e(logTag, "$socketId connect failed: ${e.message}", e)
                if (connections.remove(socketId, connection)) {
                    emit(socketId, "error", e.message ?: "connect failed")
                }
                closeConnection(connection)
                try {
                    promise.reject("WS_ERROR", e.message ?: "connect failed")
                } catch (_: Exception) {
                    // The JS promise may already have been abandoned by a local close.
                }
            }
        }.start()
    }

    @ReactMethod
    fun send(socketId: String, message: String, promise: Promise) {
        val connection = connections[socketId]
        if (connection == null || connection.closed) {
            promise.reject("WS_CLOSED", "socket not open")
            return
        }

        val writer: ExecutorService
        val output: OutputStream
        synchronized(connection.writeLock) {
            val currentWriter = connection.writer
            val currentOutput = connection.out
            if (connection.closed || currentWriter == null || currentOutput == null) {
                promise.reject("WS_CLOSED", "socket not open")
                return
            }
            writer = currentWriter
            output = currentOutput
        }

        try {
            writer.execute {
                try {
                    synchronized(connection.writeLock) {
                        if (
                            connection.closed ||
                            connections[socketId] !== connection ||
                            connection.out !== output
                        ) {
                            return@execute
                        }
                        android.util.Log.d(
                            logTag,
                            "$socketId send ${nostrMessageType(message)} bytes=${message.toByteArray(Charsets.UTF_8).size}",
                        )
                        writeFrame(output, 0x1, message.toByteArray(Charsets.UTF_8))
                    }
                } catch (e: Exception) {
                    android.util.Log.e(logTag, "$socketId send failed", e)
                    if (connections.remove(socketId, connection)) {
                        emit(socketId, "error", e.message ?: "send failed")
                    }
                    closeConnection(connection)
                }
            }
            // Match the old bridge contract: queueing is success; I/O failures arrive as events.
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("WS_CLOSED", e.message ?: "send failed")
        }
    }

    @ReactMethod
    fun close(socketId: String, promise: Promise) {
        connections.remove(socketId)?.let(::closeConnection)
        promise.resolve(null)
    }

    @ReactMethod
    fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {}

    @ReactMethod
    fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Int) {}

    private fun socks5Connect(
        input: InputStream,
        output: OutputStream,
        host: String,
        port: Int,
        user: String,
        pass: String,
    ) {
        // REQUIRE USER/PASS (RFC 1929). This module exists to GUARANTEE per-session circuit
        // isolation: Tor's IsolateSOCKSAuth gives each distinct SOCKS username+password its own
        // circuit (audit #49). A NO-AUTH stream carries no isolation signature, so two sessions
        // that took a NO-AUTH path could silently collapse onto the SAME circuit — an anonymity
        // failure. Every real caller supplies a non-empty socketId/circuitTag as both user and pass
        // (torSocket.ts, torHttp.ts), so an empty credential means a caller bug; fail LOUD and
        // debuggable rather than quietly de-isolating.
        if (user.isEmpty() || pass.isEmpty()) {
            throw Exception("SOCKS isolation credentials required")
        }
        output.write(byteArrayOf(0x05, 0x02, 0x00, 0x02)) // NO-AUTH + USER/PASS
        output.flush()
        val selected = readFully(input, 2)
        if (selected[0].toInt() != 0x05) throw Exception("bad SOCKS version")
        when (selected[1].toInt() and 0xff) {
            0x00 -> {} // NO-AUTH accepted
            0x02 -> {
                val u = user.toByteArray(Charsets.UTF_8)
                val p = pass.toByteArray(Charsets.UTF_8)
                val auth = ByteArray(3 + u.size + p.size)
                auth[0] = 0x01 // auth subnegotiation version
                auth[1] = u.size.toByte()
                System.arraycopy(u, 0, auth, 2, u.size)
                auth[2 + u.size] = p.size.toByte()
                System.arraycopy(p, 0, auth, 3 + u.size, p.size)
                output.write(auth)
                output.flush()
                val ar = readFully(input, 2)
                if (ar[1].toInt() != 0x00) throw Exception("SOCKS auth failed")
            }
            else -> throw Exception("SOCKS auth refused")
        }

        val hostBytes = host.toByteArray(Charsets.US_ASCII)
        val request = ByteArray(5 + hostBytes.size + 2)
        request[0] = 0x05
        request[1] = 0x01
        request[2] = 0x00
        request[3] = 0x03
        request[4] = hostBytes.size.toByte()
        System.arraycopy(hostBytes, 0, request, 5, hostBytes.size)
        request[5 + hostBytes.size] = ((port shr 8) and 0xff).toByte()
        request[6 + hostBytes.size] = (port and 0xff).toByte()
        output.write(request)
        output.flush()

        val reply = readFully(input, 4)
        if (reply[1].toInt() != 0x00) {
            throw Exception(SocksReply.failure(reply[1]))
        }
        when (reply[3].toInt()) {
            0x01 -> readFully(input, 6)
            0x04 -> readFully(input, 18)
            0x03 -> {
                val length = readFully(input, 1)[0].toInt() and 0xff
                readFully(input, length + 2)
            }
            else -> throw Exception("SOCKS bad ATYP")
        }
    }

    private fun wsHandshake(
        input: InputStream,
        output: OutputStream,
        host: String,
        port: Int,
        path: String,
    ) {
        val key = ByteArray(16).also { rng.nextBytes(it) }
        val keyB64 = android.util.Base64.encodeToString(key, android.util.Base64.NO_WRAP)
        val hostHeader = if (port == 80) host else "$host:$port"
        val request = "GET $path HTTP/1.1\r\n" +
            "Host: $hostHeader\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Key: $keyB64\r\n" +
            "Sec-WebSocket-Version: 13\r\n\r\n"
        output.write(request.toByteArray(Charsets.US_ASCII))
        output.flush()

        val headers = StringBuilder()
        while (!headers.endsWith("\r\n\r\n")) {
            val next = input.read()
            if (next == -1) throw Exception("WS handshake EOF")
            headers.append(next.toChar())
        }
        val status = headers.lineSequence().firstOrNull() ?: ""
        if (!status.contains("101")) throw Exception("WS upgrade failed: $status")
    }

    private fun readLoop(input: InputStream, socketId: String, connection: Connection) {
        val message = java.io.ByteArrayOutputStream()
        try {
            while (!connection.closed && connections[socketId] === connection) {
                val byte0 = input.read()
                if (byte0 == -1) break
                val opcode = byte0 and 0x0f
                val final = (byte0 and 0x80) != 0
                val byte1 = input.read()
                if (byte1 == -1) break
                val masked = (byte1 and 0x80) != 0
                var length = (byte1 and 0x7f).toLong()
                if (length == 126L) {
                    val extended = readFully(input, 2)
                    length =
                        ((extended[0].toInt() and 0xff).toLong() shl 8) or
                        (extended[1].toInt() and 0xff).toLong()
                } else if (length == 127L) {
                    val extended = readFully(input, 8)
                    length = 0
                    for (value in extended) {
                        length = (length shl 8) or (value.toInt() and 0xff).toLong()
                    }
                }
                if (length > Int.MAX_VALUE) throw Exception("WS frame too large")
                val mask = if (masked) readFully(input, 4) else null
                val payload = readFully(input, length.toInt())
                if (mask != null) {
                    for (index in payload.indices) {
                        payload[index] =
                            (payload[index].toInt() xor mask[index % 4].toInt()).toByte()
                    }
                }

                when (opcode) {
                    0x1, 0x0 -> {
                        message.write(payload)
                        if (final) {
                            val text = message.toString("UTF-8")
                            message.reset()
                            if (!connection.closed && connections[socketId] === connection) {
                                android.util.Log.d(
                                    logTag,
                                    "$socketId recv ${nostrMessageType(text)} bytes=${text.toByteArray(Charsets.UTF_8).size}",
                                )
                                emit(socketId, "message", text)
                            }
                        }
                    }
                    0x9 -> synchronized(connection.writeLock) {
                        val output = connection.out
                        if (
                            output != null &&
                            !connection.closed &&
                            connections[socketId] === connection
                        ) {
                            writeFrame(output, 0x0a, payload)
                        }
                    }
                    0x8 -> break
                    // Pong and unknown control frames need no action.
                }
            }
        } catch (e: Exception) {
            android.util.Log.e(logTag, "$socketId read failed", e)
            // A read failure is reported as a close, matching the existing JS reconnect path.
        }

        if (connections.remove(socketId, connection)) {
            android.util.Log.i(logTag, "$socketId websocket closed")
            emit(socketId, "close", null)
        }
        closeConnection(connection)
    }

    /** Write one masked client frame. Caller holds this connection's writeLock. */
    private fun writeFrame(output: OutputStream, opcode: Int, payload: ByteArray) {
        val header = java.io.ByteArrayOutputStream()
        header.write(0x80 or opcode)
        val length = payload.size
        when {
            length < 126 -> header.write(0x80 or length)
            length < 65536 -> {
                header.write(0x80 or 126)
                header.write((length shr 8) and 0xff)
                header.write(length and 0xff)
            }
            else -> {
                header.write(0x80 or 127)
                for (index in 7 downTo 0) {
                    header.write(((length.toLong() shr (8 * index)) and 0xff).toInt())
                }
            }
        }
        val mask = ByteArray(4).also { rng.nextBytes(it) }
        header.write(mask)
        val masked = ByteArray(length)
        for (index in 0 until length) {
            masked[index] =
                (payload[index].toInt() xor mask[index % 4].toInt()).toByte()
        }
        output.write(header.toByteArray())
        output.write(masked)
        output.flush()
    }

    private fun readFully(input: InputStream, length: Int): ByteArray {
        val buffer = ByteArray(length)
        var offset = 0
        while (offset < length) {
            val read = input.read(buffer, offset, length - offset)
            if (read == -1) throw Exception("EOF")
            offset += read
        }
        return buffer
    }

    private fun closeConnection(connection: Connection) {
        val writer: ExecutorService?
        val socket: Socket?
        synchronized(connection.writeLock) {
            if (connection.closed) return
            connection.closed = true
            writer = connection.writer
            socket = connection.socket
            connection.writer = null
            connection.socket = null
            connection.out = null
        }
        writer?.shutdownNow()
        try {
            socket?.close()
        } catch (_: Exception) {
            // Best-effort teardown.
        }
    }

    /** Return only the Nostr envelope type for diagnostics; never log event content or identifiers. */
    private fun nostrMessageType(message: String): String =
        Regex("""^\s*\[\s*"([A-Z-]+)"""")
            .find(message)
            ?.groupValues
            ?.getOrNull(1)
            ?: "UNKNOWN"

    private fun emit(socketId: String, type: String, data: String?) {
        val event = WritableNativeMap()
        event.putString("socketId", socketId)
        event.putString("type", type)
        if (data != null) event.putString("data", data)
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("StiqSocket", event)
    }
}
