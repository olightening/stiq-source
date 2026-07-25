package com.stiq.client

import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ServiceConnection
import android.net.ConnectivityManager
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import IPtProxy.Controller
import IPtProxy.IPtProxy
import IPtProxy.OnTransportEvents
import org.torproject.jni.TorService
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.io.PrintWriter
import java.io.OutputStreamWriter
import java.util.concurrent.atomic.AtomicLong

/**
 * Reattach fast-path master switch (W2 change 1). When true, startTor() reattaches to a still-alive,
 * config-compatible :tor daemon (rebind + re-arm monitor + repoint PTs) instead of always tearing it
 * down and re-running tor_run_main. Flip to false for a single-line rollback to the previous
 * always-full-restart behavior. Any fingerprint mismatch or failed reattach step falls through to the
 * unchanged full-restart path regardless of this flag.
 */
private const val TOR_REATTACH = true

/**
 * StiqTorModule — bundled Tor daemon + obfs4/Snowflake via IPtProxy 5.x (PLAN.md Step 4).
 *
 * TorService runs in its OWN process (android:process=":tor" in AndroidManifest.xml) so that a
 * tor_run_main() abort (SIGABRT — tor's own assertion when re-entered before the previous run's
 * globals are freed) kills only that process, never this one. This module never casts the service
 * binder to TorService.LocalBinder (that would break across processes) — it only (a) binds/unbinds
 * purely to drive the service's lifecycle via BIND_AUTO_CREATE, (b) talks Tor's control protocol
 * over the filesystem-based ControlSocket (a Unix domain socket under app-private storage, which is
 * shared by every process of this app — not process-scoped), and (c) uses ServiceConnection's
 * onServiceDisconnected as an immediate signal that the :tor process died so we can settle state to
 * offline instead of waiting on the control-socket poll. IPtProxy's pluggable-transport SOCKS
 * listener stays in THIS (main) process; tor in :tor reaches it over 127.0.0.1, which is not
 * process-scoped on Android.
 *
 * Key layout (confirmed from logcat):
 *   TorService data dir : getDir("TorService", MODE_PRIVATE)  → app_TorService/
 *   torrc location      : app_TorService/torrc                 ← we write here
 *   Tor DataDirectory   : app_TorService/data/                 ← set in torrc
 *   Control socket      : app_TorService/data/ControlSocket    ← we connect here
 *   SOCKS port           : 9050                                ← TorService default
 */
class StiqTorModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "StiqTor"

    // ── State ──────────────────────────────────────────────────────────────────────────────

    companion object {
        /**
         * The IPtProxy pluggable-transport Controller — PROCESS-scoped, deliberately NOT an instance
         * field. IPtProxy/gomobile permits exactly ONE Controller per process (constructing a second
         * throws "trackGoRef called with Java refnum N"). As an instance field this lived only as long
         * as the module instance, but the Controller it pointed at lives as long as the PROCESS: an RN
         * module reload (dev reload, a re-created ReactContext) therefore stranded the still-registered
         * Controller inside gomobile while the new instance's field read null — so the new instance
         * tried to construct a second one and threw, permanently. No PT → no Tor for the rest of the
         * process's life, unrecoverable without a cold start. Hoisted here so every instance in this
         * process shares (and finds) the one Controller that actually exists.
         *
         * @Volatile: created/read on the lifecycle executor, also read from the JS/native-modules
         * thread (startTor/stopTor's pre-stop blocks).
         */
        @Volatile private var ptController: Controller? = null

        /**
         * The module instance IPtProxy transport-error callbacks are routed to. Required by the hoist
         * above: the Controller now outlives any single StiqTorModule, but the OnTransportEvents
         * closure it was constructed with belongs forever to whichever instance created it — after a
         * reload that instance's ReactApplicationContext is torn down, so emitting through it reaches
         * nothing (and can throw on the Go callback thread). Every startPt() re-points this at the live
         * instance, so a PT error always reaches the current one and the stale instance is released.
         */
        @Volatile private var ptEventTarget: StiqTorModule? = null
    }

    private var startPromise: Promise? = null
    private var startPromiseGeneration = 0L
    // Every start/stop gets a generation. A control-monitor thread may outlive stopService()
    // briefly; generation checks prevent that stale thread from mutating or resolving the next
    // cascade attempt.
    private val lifecycleGeneration = AtomicLong(0)
    private val controlMonitorGeneration = AtomicLong(0)
    // The current control-socket monitor's live LocalSocket. A superseding monitor closes this to
    // retire the prior generation's reader thread. Normally the old daemon is killed first (teardown
    // → EOF → the parked readLine() returns null → the thread exits), but the reattach fast-path
    // (tryReattach) arms a NEW monitor WITHOUT killing the still-alive daemon, so the old thread would
    // otherwise stay blocked in readLine() forever (a live daemon never sends EOF). Closing its socket
    // forces that read to throw so the (now non-current) thread falls out. @Volatile: set by the
    // monitor thread after auth, read+closed by whichever thread arms the next monitor.
    @Volatile private var controlMonitorSocket: LocalSocket? = null
    private val fixedSocksPort = 9050
    private var lastSocksPort = fixedSocksPort
    // Tor's HTTPTunnelPort (an HTTP CONNECT proxy) — used to route an opt-in full-page WebView
    // through Tor on Android. 0 until the control-socket monitor learns the real port.
    @Volatile private var lastHttpPort = 0
    // The running daemon's version string (from GETINFO version), learned by the control-socket
    // monitor before completeStart. Surfaced on the 'connected' event as `torVersion` when known;
    // null (and therefore omitted) until the monitor reads it, so older/edge builds still emit a
    // valid connected event. See src/tor/torVersion.ts for the JS-side >=0.4.8 guard.
    @Volatile private var lastTorVersion: String? = null
    // The config fingerprint (transport + dormancy + bridges + onion-auth hosts) of the start
    // currently in flight. Written to disk on a SUCCESSFUL connect (persistConfigFingerprint from
    // completeStart) so the NEXT startTor() can gate its reattach fast-path on config compatibility.
    @Volatile private var pendingConfigFingerprint: String? = null
    private var receiverRegistered = false
    // Default-network monitor: nudges the JS layer to reconnect promptly when the device switches
    // networks (Wi-Fi↔cellular, roaming). Best-effort — absent on any failure (e.g. missing
    // ACCESS_NETWORK_STATE) so it can only ever help recovery, never break a connection.
    @Volatile private var connectivityCallback: ConnectivityManager.NetworkCallback? = null
    @Volatile private var lastNetwork: Network? = null

    // Every startTor()/stopTor()'s actual native lifecycle work (bind/unbind, waiting for the prior
    // daemon to exit, stopping PT transports) runs on this SINGLE background thread, never in
    // parallel. Without this a start and a stop issued back-to-back (e.g. one TorManager instance's
    // connect() racing another's, or a rapid supersede) could interleave their native calls over the
    // same TorService/Controller/torrc file. The fast, synchronous parts (generation bump, promise
    // bookkeeping, receiver/network-monitor teardown) still happen immediately on the calling thread
    // so any in-flight monitor notices the new generation right away — only the slow/blocking work is
    // serialized here.
    private val lifecycleExecutor: java.util.concurrent.ExecutorService =
        java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "StiqTor-lifecycle") }

    // ── Service connection (bind/unbind TorService; status via control socket) ─────────────

    // The single main-thread Handler every activeServiceConnection access is serialized onto (see
    // below). One instance rather than a fresh Handler(Looper.getMainLooper()) per post — same looper,
    // same ordering, but it gives the confinement rule one named owner.
    private val mainHandler = Handler(Looper.getMainLooper())

    // The binding used for the CURRENTLY active bind, so stopTor() can unbindService() with the
    // exact same ServiceConnection instance it was bound with (required by the API). Recreated per
    // generation (see makeServiceConnection) so a late onServiceDisconnected callback can tell
    // whether it belongs to the bind we just tore down (expected) or the one currently live
    // (a genuine crash).
    //
    // THREAD CONFINEMENT: every read AND write of this field happens on the main thread (mainHandler),
    // and the only writers are the bind sites in startTor()/tryReattach() and
    // unbindActiveConnectionOnMain(). @Volatile alone never made this safe: the field is not read and
    // written atomically but in read-then-clear-then-unbind SEQUENCES, so stopTor() (native-modules
    // thread) and forceKillWedgedTorProcess() (lifecycle executor) could interleave with a
    // main-thread bind — two threads unbinding the SAME connection (IllegalArgumentException, or a
    // silently double-released binding), or a stopTor() clearing the field a nanosecond before a bind
    // stored a NEW connection into it, leaking that binding permanently and leaving stopTor() unable to
    // ever unbind it (BIND_AUTO_CREATE keeps the daemon alive → the next start's teardown barrier
    // wedges). Confining the whole sequence to one thread makes the sequences atomic with respect to
    // each other. @Volatile is kept only so a non-main reader (none today) can't see a torn value.
    @Volatile private var activeServiceConnection: ServiceConnection? = null

    /**
     * Read + forget the active binding, then unbind it. MUST be called on the main thread: this is the
     * only place activeServiceConnection is cleared, and the field is main-thread confined (see above).
     * Forgetting it before unbinding is what lets a late onServiceDisconnected for this generation be
     * recognized as the expected teardown rather than a crash (see makeServiceConnection). A no-op when
     * nothing is bound (a fresh module instance after a reload); never throws.
     */
    private fun unbindActiveConnectionOnMain() {
        val c = activeServiceConnection
        activeServiceConnection = null
        if (c != null) {
            try { reactContext.unbindService(c) } catch (_: Exception) {}
        }
    }

    /**
     * Run `block` on the main thread and BLOCK the calling thread until it has run, or until
     * `timeoutMs` elapses. Only for the lifecycle-executor paths that must OBSERVE a main-thread
     * mutation (an unbind) before they take their next step. Runs inline when already on the main
     * thread, so ordering for main-thread callers is unchanged.
     *
     * Deadlock-free by inspection: the main thread never blocks on the lifecycle executor — every
     * lifecycleExecutor.execute() is fire-and-forget — so the wait can only ever be on ordinary main
     * queue latency. The timeout is a belt-and-braces bound: on expiry the caller simply proceeds with
     * the same (racy) behavior it had before this confinement existed, never hanging.
     */
    private fun runOnMainBlocking(timeoutMs: Long, block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            block()
            return
        }
        val latch = java.util.concurrent.CountDownLatch(1)
        val posted = mainHandler.post {
            try { block() } finally { latch.countDown() }
        }
        // The looper is dead/quitting — the post will never run, so waiting on it would burn the full
        // timeout for nothing.
        if (!posted) return
        try {
            latch.await(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {}
    }

    /**
     * A fresh ServiceConnection bound to one lifecycle `generation`. onServiceDisconnected fires
     * ONLY when the system loses the connection to a still-bound service — i.e. the :tor process
     * crashed or was killed while we expected it running (a deliberate stopTor() unbinds first,
     * which never triggers this callback). Because TorService now runs in its own :tor process
     * (AndroidManifest android:process=":tor"), this is exactly the abort scenario the teardown
     * barrier exists to recover from: treat it as an immediate "tor died" signal instead of waiting
     * on the control-socket poll, so the reconnect cascade can start a FRESH :tor process (fresh
     * process = fresh globals = the tor_run_main-twice assert cannot recur).
     */
    private fun makeServiceConnection(generation: Long): ServiceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {}
        override fun onServiceDisconnected(name: ComponentName?) {
            // A stale callback for a generation we've already torn down ourselves (stopTor() bumps
            // lifecycleGeneration before unbinding) — the teardown was expected, not a crash.
            if (lifecycleGeneration.get() != generation) return
            android.util.Log.w("StiqTor", "onServiceDisconnected: :tor process died unexpectedly (gen=$generation)")
            handleTorProcessDeath(generation)
        }
    }

    // ── Global broadcast receiver (fast path; may not fire if TorService is a separate proc) ─

    private val globalStatusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val status = intent?.getStringExtra(TorService.EXTRA_STATUS) ?: return
            handleBroadcastStatus(status)
        }
    }

    private fun handleBroadcastStatus(status: String) {
        // Broadcasts carry no attempt id and can arrive late from the service we just stopped.
        // Use them only as cosmetic progress for the currently pending start. Readiness and death
        // are authoritative on the generation-bound control socket below.
        if (!hasPendingStart(lifecycleGeneration.get())) return
        when {
            status == TorService.STATUS_ON -> {
                // STATUS_ON fires when SOCKS is ready, which can be well before BOOTSTRAP=100.
                // Emitting 'connected' here causes the relay WebSocket to attempt the onion
                // before Tor has built circuits, hitting the 120-second timeout. The control
                // socket monitor already fires emitConnected() precisely at PROGRESS=100.
                emitBootstrapping(95, "Finalising…")
            }
            status == TorService.STATUS_STARTING -> emitBootstrapping(50, "Connecting…")
            // OFF/STOPPING is intentionally ignored here: explicit stopTor emits stopped itself,
            // while an unexpected daemon death is reported by the control monitor. Accepting an
            // untagged late OFF from attempt N would tear down attempt N+1.
        }
    }

    // ── Tor control socket ─────────────────────────────────────────────────────────────────

    /**
     * True if a LIVE tor control listener accepts a connection at this data dir. tor-android runs
     * tor_run_main() IN-PROCESS, so re-binding TorService (which re-runs tor_run_main) before the
     * previous tor has fully exited re-initializes tor over its still-live process globals and trips
     * the `hs_circuitmap_init` assertion — an abort that crashes the app and stalls onboarding. We
     * poll this between a stop and the next start to wait for the old daemon to actually go. A stale
     * ControlSocket FILE with no listener returns false (connect refused), so it reports only a
     * genuinely live tor.
     */
    private fun isTorControlAlive(torDataDir: File): Boolean {
        val socketFile = File(torDataDir, "ControlSocket")
        if (!socketFile.exists()) return false
        return try {
            val s = LocalSocket()
            s.connect(
                LocalSocketAddress(socketFile.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM)
            )
            s.close()
            true
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Last-resort recovery for the startTor() teardown barrier: the prior daemon's control socket
     * was still alive after the full 12s wait, meaning it is genuinely wedged rather than merely
     * slow to exit. Without this, a wedged :tor process blocks every subsequent reconnect
     * indefinitely (until the OS eventually reclaims the idle process on its own). Re-issue
     * stopService() (idempotent, in case the prior stopTor()'s request was somehow lost) and, if
     * the OS still reports the :tor child running, kill it directly.
     *
     * This is SAFE: TorService runs in its OWN process (android:process=":tor" in
     * AndroidManifest.xml), isolated from this (main) process specifically so a tor_run_main()
     * abort — or, now, a deliberate kill — can never take this process down with it. Killing our
     * own child process is exactly the wedged daemon the barrier is waiting on; there is nothing
     * else it could be.
     *
     * Fully guarded: any lookup/kill failure is logged and swallowed, never thrown out of the
     * lifecycle executor — the caller's subsequent isTorControlAlive() re-check and clean-fail
     * path is the backstop either way.
     */
    private fun forceKillWedgedTorProcess(generation: Long) {
        if (lifecycleGeneration.get() != generation) return
        android.util.Log.w("StiqTor", "startTor: forced-kill: prior tor still alive after teardown deadline; entering forced kill (gen=$generation)")
        try {
            // Unbind + forget the lingering prior binding FIRST. It was bound with BIND_AUTO_CREATE
            // and is normally only unbound by stopTor(); on a non-death 'error' path (an IPtProxy
            // Controller error, or the control-monitor's auth-timeout failStart) the daemon stays
            // alive AND still bound. A live BIND_AUTO_CREATE binding defeats stopService() — Android
            // would immediately RECREATE the service after we kill :tor, resurrecting the daemon we
            // just "confirmed gone" (kill→resurrect loop, or a fresh :tor booting on the STALE
            // on-disk torrc). Dropping the binding here lets stopService() + killProcess() make the
            // process stay dead. Its onServiceDisconnected is generation-guarded, so unbinding a
            // superseded connection is safe; forgetting it also prevents the later
            // activeServiceConnection reassignment from permanently leaking this reference.
            //
            // This runs on the lifecycle executor, so hop to the main thread (activeServiceConnection
            // is confined there) and BLOCK until it has actually run: killProcess() below must not
            // overtake the unbind, or we get exactly the resurrect loop described above. stopService
            // rides in the same block to preserve the unbind→stop order.
            runOnMainBlocking(2_000L) {
                unbindActiveConnectionOnMain()
                try {
                    reactContext.stopService(Intent(reactContext, StiqTorService::class.java))
                } catch (_: Exception) {}
            }

            val am = reactContext.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            val procs: MutableList<ActivityManager.RunningAppProcessInfo>? = am?.runningAppProcesses
            if (procs == null) {
                android.util.Log.w("StiqTor", "startTor: forced-kill: runningAppProcesses unavailable; nothing to kill")
                return
            }
            var killedAny = false
            for (p in procs) {
                if (p.processName?.endsWith(":tor") == true) {
                    try {
                        android.util.Log.w("StiqTor", "startTor: forced-kill: killing wedged :tor process pid=${p.pid} (${p.processName})")
                        Process.killProcess(p.pid)
                        killedAny = true
                    } catch (e: Exception) {
                        android.util.Log.w("StiqTor", "startTor: forced-kill: killProcess failed for pid=${p.pid}", e)
                    }
                }
            }
            if (!killedAny) {
                android.util.Log.w("StiqTor", "startTor: forced-kill: no :tor child process found to kill")
            }
        } catch (e: Exception) {
            android.util.Log.w("StiqTor", "startTor: forced-kill: unexpected failure", e)
        }
    }

    private fun startControlSocketMonitor(torDataDir: File, generation: Long) {
        if (lifecycleGeneration.get() != generation) return
        controlMonitorGeneration.set(generation)
        // Retire any prior-generation monitor still parked in readLine() (see field doc): closing its
        // socket unblocks that thread so it exits instead of leaking. No-op when the previous monitor
        // already exited on its own (socket closed → this close is swallowed).
        controlMonitorSocket?.let { old -> try { old.close() } catch (_: Exception) {} }
        controlMonitorSocket = null

        Thread {
            val socketFile = File(torDataDir, "ControlSocket")
            val cookieFile = File(torDataDir, "control_auth_cookie")

            // Connect + authenticate with retry. The ControlSocket file can exist as a STALE
            // leftover from a previous run before the current tor reopens its listener, so a
            // single connect attempt hits ECONNREFUSED and the monitor would die — leaving JS
            // to time out even though tor comes up moments later (this bites the fast direct
            // path hardest). Retry until tor's control listener actually accepts us, or the
            // 45 s deadline passes.
            val deadline = System.currentTimeMillis() + 45_000
            var localSock: LocalSocket? = null
            var out: PrintWriter? = null
            var inBuf: BufferedReader? = null

            fun cmd(line: String): List<String> {
                val o = out!!; val i = inBuf!!
                o.print("$line\r\n"); o.flush()
                val reply = mutableListOf<String>()
                while (true) {
                    val l = i.readLine() ?: break
                    reply.add(l)
                    if (l.length >= 4 && l[3] == ' ') break  // final reply line
                }
                return reply
            }

            while (isMonitorCurrent(generation) && System.currentTimeMillis() < deadline) {
                if (!socketFile.exists()) {
                    try { Thread.sleep(300) } catch (_: InterruptedException) { return@Thread }
                    continue
                }
                try {
                    val s = LocalSocket()
                    s.connect(
                        LocalSocketAddress(socketFile.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM)
                    )
                    out = PrintWriter(OutputStreamWriter(s.outputStream, Charsets.US_ASCII))
                    inBuf = BufferedReader(InputStreamReader(s.inputStream, Charsets.US_ASCII))

                    // Try NULL auth, then cookie auth.
                    var auth = cmd("AUTHENTICATE \"\"")
                    if (auth.isEmpty() || !auth[0].startsWith("250")) {
                        if (cookieFile.exists()) {
                            val hex = cookieFile.readBytes().joinToString("") { "%02x".format(it) }
                            auth = cmd("AUTHENTICATE $hex")
                        }
                    }
                    if (auth.isNotEmpty() && auth[0].startsWith("250")) {
                        localSock = s
                        break // connected + authenticated
                    }
                    // Connected but auth not accepted yet — retry.
                    try { s.close() } catch (_: Exception) {}
                    out = null; inBuf = null
                } catch (_: Exception) {
                    // Listener not accepting yet (stale socket / not bound) — wait and retry.
                    out = null; inBuf = null
                }
                try { Thread.sleep(300) } catch (_: InterruptedException) { return@Thread }
            }

            if (localSock == null || !isMonitorCurrent(generation)) {
                // Superseded AFTER a successful connect+auth (localSock non-null): nothing below will
                // ever publish this socket to controlMonitorSocket or read from it, so without this
                // close the authenticated LocalSocket — and its fd, and tor's matching control
                // connection — leaks for the life of the process, once per superseded start. A no-op
                // when we got here on the deadline path (localSock still null).
                try { localSock?.close() } catch (_: Exception) {}
                if (isMonitorCurrent(generation)) {
                    android.util.Log.e("StiqTor", "monitor: could not connect/auth to ControlSocket within deadline")
                    failStart(generation, "Tor control connection unavailable")
                }
                controlMonitorGeneration.compareAndSet(generation, 0)
                return@Thread
            }
            android.util.Log.i("StiqTor", "monitor: authenticated")
            // Publish this generation's socket so a later superseding monitor (notably a reattach that
            // doesn't kill the daemon) can close it to unblock the readLine() park loop below.
            controlMonitorSocket = localSock

            try {

                // Query actual SOCKS port (needed when SOCKSPort is "auto").
                val socksInfo = cmd("GETINFO net/listeners/socks")
                val socksPort = socksInfo
                    .firstOrNull { it.startsWith("250") }
                    ?.let { Regex(":(\\d+)").find(it)?.groupValues?.get(1)?.toIntOrNull() }
                    ?: lastSocksPort
                lastSocksPort = socksPort

                // Query the HTTPTunnelPort the same way, for the opt-in full-page WebView proxy.
                lastHttpPort = cmd("GETINFO net/listeners/httptunnel")
                    .firstOrNull { it.startsWith("250") }
                    ?.let { Regex(":(\\d+)").find(it)?.groupValues?.get(1)?.toIntOrNull() }
                    ?: lastHttpPort

                // Learn the running daemon's version so the 'connected' event can carry it (the JS
                // layer uses it to warn when the bundled tor is older than the onion-service PoW
                // floor >=0.4.8). Reply looks like '250-version=0.4.9.11 (git-...)' then '250 OK';
                // an unparseable/absent reply simply leaves lastTorVersion null (omitted downstream).
                // Read BEFORE SETEVENTS/bootstrap-phase so both the fast-path and streamed-progress
                // completeStart() calls below already see it.
                val verReply = cmd("GETINFO version")
                lastTorVersion = verReply
                    .firstOrNull { it.contains("version=") }
                    ?.let {
                        Regex("version=([0-9]+\\.[0-9]+\\.[0-9]+(?:\\.[0-9]+)?)").find(it)
                            ?.groupValues?.get(1)
                    }

                cmd("SETEVENTS STATUS_CLIENT")

                // Direct Tor bootstraps in seconds — often reaching 100% BEFORE we finish
                // subscribing above. Async STATUS_CLIENT events only cover progress that
                // happens AFTER SETEVENTS, so a fast connect would never be reported and JS
                // would time out despite Tor being up. Query the current phase once to catch a
                // bootstrap that already completed (or is already in progress).
                run {
                    val phase = cmd("GETINFO status/bootstrap-phase")
                        .firstOrNull { it.contains("BOOTSTRAP") && it.contains("PROGRESS=") }
                    if (phase != null) {
                        val pct = Regex("PROGRESS=(\\d+)").find(phase)?.groupValues?.get(1)?.toIntOrNull() ?: 0
                        if (pct >= 100) {
                            completeStart(generation, lastSocksPort)
                        } else if (pct > 0) {
                            emitBootstrapping(pct, "Connecting")
                        }
                    }
                }

                // Stream events until the control connection drops or we're told to stop.
                // Crucially, we keep the socket open AFTER reaching 100% so an unexpected Tor
                // death (the OS killing the service in the background, a circuit collapse) is
                // detected and reported. Without this the monitor exited at 100% and nothing
                // watched Tor afterwards, so JS kept showing a stale "connected" and never
                // reconnected.
                while (isMonitorCurrent(generation)) {
                    val line = inBuf!!.readLine()
                    if (line == null) {
                        // null = the control socket closed = the Tor process is gone. Only
                        // report it if we didn't ask for the stop ourselves (stopTor invalidates
                        // this generation first), so JS goes offline and reconnects.
                        if (isMonitorCurrent(generation)) {
                            emitError("tor control connection lost")
                            resolveStart(generation)
                        }
                        break
                    }
                    // 650 STATUS_CLIENT NOTICE BOOTSTRAP PROGRESS=100 TAG=done SUMMARY=Done
                    if (!line.contains("BOOTSTRAP") || !line.contains("PROGRESS=")) continue
                    val pct = Regex("PROGRESS=(\\d+)").find(line)?.groupValues?.get(1)?.toIntOrNull() ?: 0
                    val summary = Regex("SUMMARY=(.+)").find(line)?.groupValues?.get(1)?.trimEnd() ?: "Connecting"
                    if (pct >= 100) {
                        completeStart(generation, lastSocksPort)
                        // Do NOT break — stay connected to the control socket so we notice if
                        // Tor dies later.
                    } else if (pct > 0) {
                        emitBootstrapping(pct, summary)
                    }
                }

                try { out?.print("QUIT\r\n"); out?.flush() } catch (_: Exception) {}
                try { localSock.close() } catch (_: Exception) {}
            } catch (e: Exception) {
                if (isMonitorCurrent(generation)) {
                    android.util.Log.e("StiqTor", "monitor failed", e)
                    failStart(generation, e.message ?: "Tor control monitor failed")
                }
            }

            // Drop the shared reference if it still points at our (now-closed) socket, so we don't
            // hold a dead socket object until the next monitor supersedes it.
            if (controlMonitorSocket === localSock) controlMonitorSocket = null
            controlMonitorGeneration.compareAndSet(generation, 0)
        }.start()
    }

    // ── React methods ──────────────────────────────────────────────────────────────────────

    @ReactMethod
    fun startTor(config: ReadableMap, promise: Promise) {
        android.util.Log.i("StiqTor", "startTor() called transport=${config.getString("transport")}")
        val generation = beginStart(promise)
        emitStarting()
        registerNetworkMonitor()

        // Stop any running pluggable transport before starting a new one — prevents a
        // port-conflict when startTor is called again without a prior stopTor. We must NOT
        // discard the Controller itself: IPtProxy/gomobile allows only ONE Controller per
        // process (constructing a second throws "trackGoRef called with Java refnum N"), so
        // it is created once in startPt() and reused for the lifetime of the process.
        try {
            ptController?.stop(IPtProxy.Obfs4)
            ptController?.stop(IPtProxy.Snowflake)
            ptController?.stop(IPtProxy.Webtunnel)
        } catch (_: Exception) {}

        // Serialized on lifecycleExecutor: this body can never run concurrently with a stopTor()'s
        // (or another startTor()'s) native lifecycle work, closing the race where two overlapping
        // native calls could stack half-torn-down/half-started state on the shared TorService/
        // Controller/torrc file.
        lifecycleExecutor.execute {
            try {
                val transport = config.getString("transport") ?: "obfs4"

                // TorService reads its torrc from getDir("TorService", MODE_PRIVATE)/torrc.
                val torServiceDir = reactContext.getDir("TorService", Context.MODE_PRIVATE)
                val torDataDir = File(torServiceDir, "data").also { it.mkdirs() }
                // PT state now lives under the PERSISTENT TorService dir (change 6) so it survives an
                // OS cache wipe — cacheDir can be cleared at any time, which used to drop the PT's
                // state (obfs4 cert cache, snowflake broker state) mid-session.
                val ptStateDir = File(torServiceDir, "pt").also { it.mkdirs() }
                val bridgeLines = config.getArray("bridgeLines")
                val dormancy = config.hasKey("dormancy") && config.getBoolean("dormancy")

                // Config fingerprint for the reattach compatibility gate (change 1). Uniquely
                // identifies a compatible RUNNING daemon: transport + dormancy + bridge set +
                // onion-auth host set — all baked into torrc at boot (or read only at boot, for
                // ClientOnionAuthDir), so a change to any of them requires a real restart. Persisted
                // on each successful connect (completeStart → persistConfigFingerprint).
                val configFingerprint = computeConfigFingerprint(transport, dormancy, bridgeLines, config)
                pendingConfigFingerprint = configFingerprint

                // ── Reattach fast-path (TOR_REATTACH, single-line rollback) ──────────────────────
                // A prior :tor daemon is still alive (JS module reload, or foreground return with the
                // daemon surviving in the background). If the requested config MATCHES the running
                // daemon's persisted fingerprint, skip the wait-for-exit / force-kill / full
                // tor_run_main restart entirely: rebind the service, re-arm the control monitor, wake
                // it (SIGNAL ACTIVE) and repoint its PTs. A fingerprint mismatch, OR any failing
                // reattach step (tryReattach returns false), falls through to the UNCHANGED
                // full-restart path below.
                if (TOR_REATTACH && lifecycleGeneration.get() == generation && isTorControlAlive(torDataDir)) {
                    val persisted = try {
                        val f = File(torServiceDir, "config_fingerprint")
                        if (f.exists()) f.readText() else null
                    } catch (_: Exception) { null }
                    if (persisted != null && persisted == configFingerprint) {
                        if (tryReattach(generation, transport, torServiceDir, torDataDir, ptStateDir)) {
                            return@execute
                        }
                        android.util.Log.w("StiqTor", "startTor: reattach failed; falling through to full restart (gen=$generation)")
                    } else {
                        android.util.Log.i("StiqTor", "startTor: reattach skipped (fingerprint mismatch/absent); full restart (gen=$generation)")
                    }
                }

                // Teardown barrier (prevents the hs_circuitmap abort on reconnect/transport switch):
                // a preceding stopTor() unbinds + stopService() but tor_run_main() exits
                // asynchronously on TorService's own thread. Re-binding before it has freed tor's
                // process globals re-inits tor over a live the_hs_circuitmap and aborts. Wait for the
                // old control listener to refuse connections (tor gone) before re-binding. Bounded so
                // a wedged shutdown can't hang startup.
                val teardownDeadline = System.currentTimeMillis() + 12_000
                while (isTorControlAlive(torDataDir) && System.currentTimeMillis() < teardownDeadline) {
                    android.util.Log.i("StiqTor", "startTor: waiting for prior tor to exit…")
                    try { Thread.sleep(200) } catch (_: InterruptedException) { return@execute }
                }
                if (lifecycleGeneration.get() != generation) return@execute
                if (isTorControlAlive(torDataDir)) {
                    // The prior daemon never released its control socket within the deadline —
                    // it is genuinely wedged, not merely slow. Binding now would re-invoke
                    // tor_run_main() over its still-live process globals and trip the exact abort
                    // this barrier exists to prevent — do NOT "proceed anyway" yet. Before giving
                    // up, force-kill the wedged :tor process (our own isolated child process — see
                    // forceKillWedgedTorProcess) and give the barrier one short extra window; only
                    // fail clean if it is still alive after that. Without this, a genuinely wedged
                    // :tor process would otherwise block every reconnect attempt until the OS
                    // eventually reclaims the idle process on its own.
                    android.util.Log.w("StiqTor", "startTor: prior tor did not exit within teardown deadline")
                    forceKillWedgedTorProcess(generation)
                    if (lifecycleGeneration.get() != generation) return@execute

                    val forcedDeadline = System.currentTimeMillis() + 3_000
                    while (isTorControlAlive(torDataDir) && System.currentTimeMillis() < forcedDeadline) {
                        try { Thread.sleep(200) } catch (_: InterruptedException) { return@execute }
                    }
                    if (lifecycleGeneration.get() != generation) return@execute

                    if (isTorControlAlive(torDataDir)) {
                        // Still alive even after the forced kill attempt — fail this attempt
                        // cleanly, exactly as before this fix; the JS cascade's retry/backoff will
                        // try again (and with process isolation, the control-socket monitor /
                        // onServiceDisconnected reports it as a death once the process is truly
                        // gone).
                        android.util.Log.e("StiqTor", "startTor: prior tor still alive after forced kill; failing clean")
                        failStart(generation, "prior tor daemon did not exit in time; not safe to restart yet")
                        return@execute
                    }
                    android.util.Log.i("StiqTor", "startTor: prior tor confirmed gone after forced kill; proceeding with start")
                }

                // Always start a pluggable transport, even in 'direct' mode where the torrc
                // won't reference it. Skipping it made the FIRST TorService bind of the
                // process never actually launch tor (no GoLog, 60s stall) — the PT startup
                // does native init / adds the ~1.5s settle that TorService needs before tor
                // comes up. In direct mode the PT process simply runs unused. (obfs4 PT is the
                // lightweight default used purely for this warm-up.)
                val ptTransport = if (transport == "direct") "obfs4" else transport
                val ptPort = startPt(ptTransport, ptStateDir.absolutePath)
                if (lifecycleGeneration.get() != generation) {
                    try {
                        ptController?.stop(IPtProxy.Obfs4)
                        ptController?.stop(IPtProxy.Snowflake)
                        ptController?.stop(IPtProxy.Webtunnel)
                    } catch (_: Exception) {}
                    return@execute
                }
                android.util.Log.i(
                    "StiqTor",
                    if (transport == "direct") "direct mode (pt warmed port=$ptPort); binding TorService"
                    else "startPt ok port=$ptPort; binding TorService",
                )

                if (transport != "direct" && (bridgeLines == null || bridgeLines.size() == 0)) {
                    throw IllegalArgumentException("bridgeLines is required for $transport")
                }

                // v3 onion client authorization (lever 2): if the community provisioned a shared
                // reach credential, materialize <onion_auth>/<host>.auth_private BEFORE boot so Tor
                // can resolve the members-only relay's auth-gated descriptor. The JS layer
                // (src/tor/onionAuth.ts) has already validated the host + key shape.
                val onionAuthDirBase = File(torServiceDir, "onion_auth")
                var wroteAnyOnionAuth = false
                val primaryAuthWritten: String? = config.getMap("onionAuth")?.let { auth ->
                    val host = auth.getString("onionHost")
                    val key = auth.getString("privKeyBase32")
                    if (host.isNullOrBlank() || key.isNullOrBlank()) {
                        null
                    } else {
                        val dir = onionAuthDirBase.also { it.mkdirs(); it.setReadable(false, false); it.setReadable(true, true); it.setExecutable(true, true) }
                        File(dir, "$host.auth_private").writeText("$host:descriptor:x25519:$key\n")
                        wroteAnyOnionAuth = true
                        dir.absolutePath
                    }
                }
                // Additional SECONDARY-mirror credentials (P2 §1.7 multi-relay client transport):
                // every entry gets its own <host>.auth_private in the SAME ClientOnionAuthDir, so one
                // dir can resolve the primary's onion AND every mirror's auth-gated onion. Absent/
                // empty → no secondary mirrors carry their own auth, unchanged from before.
                config.getArray("onionAuthExtra")?.let { extra ->
                    for (i in 0 until extra.size()) {
                        val entry = extra.getMap(i) ?: continue
                        val host = entry.getString("onionHost")
                        val key = entry.getString("privKeyBase32")
                        if (host.isNullOrBlank() || key.isNullOrBlank()) continue
                        val dir = onionAuthDirBase.also { it.mkdirs(); it.setReadable(false, false); it.setReadable(true, true); it.setExecutable(true, true) }
                        File(dir, "$host.auth_private").writeText("$host:descriptor:x25519:$key\n")
                        wroteAnyOnionAuth = true
                    }
                }
                val onionAuthDir: String? = if (wroteAnyOnionAuth) onionAuthDirBase.absolutePath else primaryAuthWritten

                // dormancy (hoisted above for the fingerprint): flag-gated (TOR_DORMANCY, ship-dark).
                // When true the torrc idles circuits (SIGNAL DORMANT lifecycle) instead of force-
                // killing the daemon; absent/false → the existing force-kill liveness lines emitted
                // byte-for-byte (see buildTorrc's else branch).
                val torrc = buildTorrc(transport, ptPort, torDataDir.absolutePath, bridgeLines, onionAuthDir, dormancy)
                if (!writeTorrcIfCurrent(generation, File(torServiceDir, "torrc"), torrc)) {
                    return@execute
                }

                // Start monitoring the control socket BEFORE binding (it waits for the socket
                // file to appear, so the ordering doesn't matter).
                startControlSocketMonitor(torDataDir, generation)

                val intent = Intent(reactContext, StiqTorService::class.java)
                    .putExtra("org.torproject.android.intent.extra.PACKAGE_NAME", reactContext.packageName)
                    .putExtra("org.torproject.android.intent.extra.SERVICE_PACKAGE_NAME", reactContext.packageName)

                mainHandler.post {
                    if (lifecycleGeneration.get() != generation) return@post
                    // Register the global broadcast receiver as a fast path.
                    registerStatusReceiver()
                    // startForegroundService (API 26+, change 2) so a BACKGROUND-initiated start (the
                    // WorkManager/push wake path) is allowed; StiqTorService.onCreate then promotes to
                    // foreground within the OS deadline with a neutral IMPORTANCE_MIN notification. A
                    // background-start refusal is swallowed — bindService(BIND_AUTO_CREATE) starts the
                    // service anyway (as a plain bound service, exactly as before).
                    startTorServiceForegroundGuarded(intent)

                    try {
                        val connection = makeServiceConnection(generation)
                        activeServiceConnection = connection
                        reactContext.bindService(intent, connection, Context.BIND_AUTO_CREATE)
                    } catch (e: Exception) {
                        failStart(generation, "service bind failed: ${e.message}")
                    }
                }

            } catch (e: Throwable) {
                android.util.Log.e("StiqTor", "startTor failed", e)
                failStart(generation, e.message ?: "startTor failed")
            }
        }
    }

    @ReactMethod
    fun stopTor(promise: Promise) {
        android.util.Log.i("StiqTor", "stopTor() called")
        // Fast, synchronous invalidation first — bumping the generation and clearing bookkeeping
        // immediately means any in-flight startTor() body notices right away at its next checkpoint,
        // regardless of how long the actual native teardown below takes.
        val generation = lifecycleGeneration.incrementAndGet()
        controlMonitorGeneration.set(0)
        resolveAnyStart()
        unregisterNetworkMonitor()
        if (receiverRegistered) {
            try { reactContext.unregisterReceiver(globalStatusReceiver) } catch (_: Exception) {}
            receiverRegistered = false
        }
        // Unbind first, then stop — order matters: stopService() without an active binding
        // can be a no-op if the service was only started via bindService(). Use the exact
        // ServiceConnection instance we bound with and forget it, so a later onServiceDisconnected
        // for THIS generation is recognized as the expected teardown (see makeServiceConnection),
        // not reported as a crash.
        //
        // Hopped to the main thread because @ReactMethod bodies run on the native-modules thread and
        // activeServiceConnection is main-thread confined — this unbind would otherwise race
        // startTor()/tryReattach()'s main-thread bind. Non-blocking: nothing below depends on the
        // unbind having already happened (the executor poll below allows the daemon a full 10 s to
        // exit, orders of magnitude more than a main-queue hop), so the JS caller is not made to wait
        // on main-thread latency.
        mainHandler.post {
            unbindActiveConnectionOnMain()
            try { reactContext.stopService(Intent(reactContext, StiqTorService::class.java)) } catch (_: Exception) {}
        }
        // Stop the transports but KEEP the Controller instance — it is a process singleton
        // (only one allowed per process) and must survive for the next startTor().
        try {
            ptController?.stop(IPtProxy.Obfs4)
            ptController?.stop(IPtProxy.Snowflake)
            ptController?.stop(IPtProxy.Webtunnel)
        } catch (_: Exception) {}

        // Do NOT resolve until tor is confirmed gone (or a generous bound elapses). Resolving
        // immediately here used to let every reconnect path (community switch, mode-apply/Retry,
        // transport escalation, the bridge ladder, scheduleRetry) race the real shutdown — the next
        // startTor() would then re-bind while the old tor_run_main() was still tearing down and trip
        // the abort this whole barrier exists to prevent. Serialized on lifecycleExecutor so this
        // poll can never overlap a startTor() body's native work.
        lifecycleExecutor.execute {
            val torDataDir = File(reactContext.getDir("TorService", Context.MODE_PRIVATE), "data")
            val deadline = System.currentTimeMillis() + 10_000
            while (isTorControlAlive(torDataDir) && System.currentTimeMillis() < deadline) {
                try { Thread.sleep(200) } catch (_: InterruptedException) { break }
            }
            if (isTorControlAlive(torDataDir)) {
                // Bounded wait exhausted — log it, but still resolve rather than hang the JS caller
                // forever. The startTor() teardown barrier (which now fails cleanly instead of
                // "proceeding anyway") is the backstop if the stale daemon is still alive by the next
                // start attempt.
                android.util.Log.w(
                    "StiqTor",
                    "stopTor: prior tor did not confirm exit within bound (gen=$generation); resolving anyway",
                )
            }
            emitStopped()
            promise.resolve(null)
        }
    }

    /**
     * Shared by the control-socket monitor's "socket closed" branch and onServiceDisconnected: the
     * :tor process is gone when we did not ask for it to be. Settle whatever is pending for this
     * generation to offline/error so the JS reconnect cascade starts a FRESH :tor process rather than
     * being left waiting on a promise or a stale "connected" state that no longer reflects reality.
     */
    private fun handleTorProcessDeath(generation: Long) {
        controlMonitorGeneration.compareAndSet(generation, 0)
        if (hasPendingStart(generation)) {
            failStart(generation, "tor process died unexpectedly")
        } else {
            // No start is pending for this generation — either we were connected, or idle. Either
            // way JS should hear about the drop; a live connection's TorManager treats an unexpected
            // 'error' event the same as any other daemon death and reconnects.
            emitError("tor process died unexpectedly")
        }
    }

    // ── Default-network monitor ──────────────────────────────────────────────────────────────

    /**
     * Watch the device's DEFAULT network and nudge the JS layer when it switches (Wi-Fi↔cellular,
     * roaming). On a switch the live Tor circuits + relay socket are dead, but a blocking read
     * won't notice for up to the relay watchdog (~90s); a proactive nudge lets JS bounce the relay
     * (→ NEWNYM → fresh circuits) within seconds. Best-effort and fully guarded: any failure leaves
     * the app exactly as before (the watchdog + JS reconnect still recover, just slower). The JS
     * side ignores the nudge unless Tor is actually connected, so a spurious event is harmless.
     */
    private fun registerNetworkMonitor() {
        if (connectivityCallback != null) return
        val cm = reactContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val prev = lastNetwork
                lastNetwork = network
                // The first callback after registering is the baseline; only a genuine change of
                // the default network nudges JS.
                if (prev != null && prev != network) {
                    emitNetworkChanged()
                }
            }
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            connectivityCallback = cb
        } catch (_: Exception) {
            connectivityCallback = null
        }
    }

    private fun unregisterNetworkMonitor() {
        val cb = connectivityCallback ?: return
        connectivityCallback = null
        lastNetwork = null
        val cm = reactContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return
        try { cm.unregisterNetworkCallback(cb) } catch (_: Exception) {}
    }

    /**
     * Coarse transport class of the device's current default network. Privacy-preserving: reads
     * ONLY the transport TYPE from NetworkCapabilities (never SSID/BSSID/WifiInfo), so it requires
     * no location permission and cannot fingerprint the specific network. VPN is reported first so
     * a Wi-Fi/cellular underlay behind a VPN is still classified "vpn". Returns "unknown" whenever
     * the capabilities can't be read (no active network, missing ACCESS_NETWORK_STATE, etc.).
     */
    private fun currentNetworkClass(): String {
        val cm = reactContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return "unknown"
        val active = cm.activeNetwork ?: return "unknown"
        val caps = cm.getNetworkCapabilities(active) ?: return "unknown"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
    }

    /**
     * Open a short-lived control connection and send a single `SIGNAL <signal>`. Shared by
     * newCircuit() (NEWNYM) and the flag-gated dormancy controls (DORMANT/ACTIVE). Does the same
     * NULL-then-cookie AUTHENTICATE the control-socket monitor uses, then QUITs and closes.
     *
     * Fully guarded — NEVER throws (every failure is swallowed): a signal is best-effort, and a
     * missing/half-open socket must not crash the caller's worker thread. Note this deliberately
     * does NOT touch lifecycleGeneration, the ServiceConnection, or stopService — SIGNAL DORMANT
     * idles circuits while keeping the daemon and the control-socket monitor alive, so the teardown
     * barrier / hs_circuitmap protections are untouched.
     */
    private fun sendControlSignal(signal: String) {
        try {
            val torDataDir = File(reactContext.getDir("TorService", Context.MODE_PRIVATE), "data")
            val socketFile = File(torDataDir, "ControlSocket")
            val cookieFile = File(torDataDir, "control_auth_cookie")
            if (socketFile.exists()) {
                val sock = LocalSocket()
                sock.connect(LocalSocketAddress(socketFile.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM))
                val out = PrintWriter(OutputStreamWriter(sock.outputStream, Charsets.US_ASCII))
                val inBuf = BufferedReader(InputStreamReader(sock.inputStream, Charsets.US_ASCII))
                fun cmd(line: String): String {
                    out.print("$line\r\n"); out.flush()
                    return inBuf.readLine() ?: ""
                }
                var auth = cmd("AUTHENTICATE \"\"")
                if (!auth.startsWith("250") && cookieFile.exists()) {
                    val hex = cookieFile.readBytes().joinToString("") { "%02x".format(it) }
                    auth = cmd("AUTHENTICATE $hex")
                }
                if (auth.startsWith("250")) {
                    cmd("SIGNAL $signal")
                }
                try { out.print("QUIT\r\n"); out.flush() } catch (_: Exception) {}
                try { sock.close() } catch (_: Exception) {}
            }
        } catch (_: Exception) {}
    }

    /**
     * Open a short-lived control connection and apply a single `SETCONF <assignment>`. Used by the
     * reattach fast-path to repoint a live daemon at a freshly-started pluggable-transport SOCKS port
     * (the PT listener lives in THIS main process; after a module/process reload it is gone even
     * though the :tor daemon survives, so the daemon's ClientTransportPlugin must be re-pointed at the
     * new port). Returns true ONLY on a 250 reply. Returns false on any failure — a missing socket, an
     * auth failure, a non-250 reply (e.g. a Tor version that treats ClientTransportPlugin as
     * immutable), or any exception — so the caller can fall through to a full restart. Never throws.
     */
    private fun sendControlSetConf(assignment: String): Boolean {
        return try {
            val torDataDir = File(reactContext.getDir("TorService", Context.MODE_PRIVATE), "data")
            val socketFile = File(torDataDir, "ControlSocket")
            val cookieFile = File(torDataDir, "control_auth_cookie")
            if (!socketFile.exists()) return false
            val sock = LocalSocket()
            sock.connect(LocalSocketAddress(socketFile.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM))
            val out = PrintWriter(OutputStreamWriter(sock.outputStream, Charsets.US_ASCII))
            val inBuf = BufferedReader(InputStreamReader(sock.inputStream, Charsets.US_ASCII))
            fun cmd(line: String): String {
                out.print("$line\r\n"); out.flush()
                return inBuf.readLine() ?: ""
            }
            var auth = cmd("AUTHENTICATE \"\"")
            if (!auth.startsWith("250") && cookieFile.exists()) {
                val hex = cookieFile.readBytes().joinToString("") { "%02x".format(it) }
                auth = cmd("AUTHENTICATE $hex")
            }
            var ok = false
            if (auth.startsWith("250")) {
                ok = cmd("SETCONF $assignment").startsWith("250")
            }
            try { out.print("QUIT\r\n"); out.flush() } catch (_: Exception) {}
            try { sock.close() } catch (_: Exception) {}
            ok
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Ask Tor for fresh circuits (SIGNAL NEWNYM). Onion rendezvous circuits on a throttling
     * network are a lottery — many time out, a few work. When the relay socket can't reach the
     * onion the JS layer calls this between retries so each attempt rides a NEW circuit instead
     * of reusing the dead one. Opens a short-lived control connection; never throws.
     */
    @ReactMethod
    fun newCircuit(promise: Promise) {
        Thread {
            sendControlSignal("NEWNYM")
            android.util.Log.i("StiqTor", "newCircuit: NEWNYM sent")
            promise.resolve(null)
        }.start()
    }

    /**
     * Flag-gated (TOR_DORMANCY) dormancy control: SIGNAL DORMANT idles Tor's circuits/padding to
     * save battery when the app backgrounds, while KEEPING the daemon + control connection alive.
     * It does NOT stop TorService, does NOT touch lifecycleGeneration, and leaves the control-socket
     * monitor attached so a real daemon death is still detected. Best-effort; never throws.
     */
    @ReactMethod
    fun setDormant(promise: Promise) {
        Thread {
            sendControlSignal("DORMANT")
            android.util.Log.i("StiqTor", "setDormant: SIGNAL DORMANT sent")
            promise.resolve(null)
        }.start()
    }

    /**
     * Flag-gated (TOR_DORMANCY) dormancy control: SIGNAL ACTIVE wakes Tor from the dormant state
     * (foreground return) so it rebuilds circuits promptly. Best-effort; never throws.
     */
    @ReactMethod
    fun setActive(promise: Promise) {
        Thread {
            sendControlSignal("ACTIVE")
            android.util.Log.i("StiqTor", "setActive: SIGNAL ACTIVE sent")
            promise.resolve(null)
        }.start()
    }

    /**
     * The local HTTPTunnelPort (HTTP CONNECT proxy) Tor is listening on, or 0 if not yet known.
     * Used by the opt-in full-page WebView path (StiqWebProxy) to route the WebView through Tor.
     */
    @ReactMethod
    fun getHttpTunnelPort(promise: Promise) {
        promise.resolve(lastHttpPort)
    }

    /**
     * Coarse transport class of the device's CURRENT default network — one of
     * "wifi"|"cellular"|"ethernet"|"vpn"|"other"|"unknown". Used by the JS layer (and the
     * StiqTorNetworkChange payload) to keep a per-network-class bridge cache. Reads ONLY the
     * transport TYPE from NetworkCapabilities — never SSID/BSSID/WifiInfo — so it needs no
     * location permission and cannot fingerprint the specific network.
     */
    @ReactMethod
    fun getNetworkClass(promise: Promise) {
        promise.resolve(currentNetworkClass())
    }

    @ReactMethod fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {}
    @ReactMethod fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Int) {}

    // ── Private helpers ────────────────────────────────────────────────────────────────────

    @Synchronized
    private fun beginStart(promise: Promise): Long {
        val generation = lifecycleGeneration.incrementAndGet()
        // Invalidate the old monitor immediately, even if its blocking read has not returned yet.
        controlMonitorGeneration.set(generation)
        startPromise?.resolve(null)
        startPromise = promise
        startPromiseGeneration = generation
        return generation
    }

    @Synchronized
    private fun hasPendingStart(generation: Long): Boolean =
        startPromise != null &&
            startPromiseGeneration == generation &&
            lifecycleGeneration.get() == generation

    private fun isMonitorCurrent(generation: Long): Boolean =
        lifecycleGeneration.get() == generation &&
            controlMonitorGeneration.get() == generation

    @Synchronized
    private fun writeTorrcIfCurrent(generation: Long, file: File, torrc: String): Boolean {
        if (lifecycleGeneration.get() != generation) return false
        file.writeText(torrc)
        return true
    }

    @Synchronized
    private fun completeStart(generation: Long, socksPort: Int) {
        if (!hasPendingStart(generation)) return
        emitConnected(socksPort)
        // Record the config the now-connected daemon actually booted with, so a later startTor() can
        // decide whether the still-running daemon is reattach-compatible (change 1). Written only on
        // a real connect — a failed start leaves the file reflecting the last daemon that worked.
        persistConfigFingerprint()
        // Alongside it, record WHICH PID that daemon's dead-man's switch is watching, so a later
        // process can tell "this daemon is mine" from "this daemon is counting down to its own death"
        // — the two are indistinguishable from the outside. See persistOwnerPid.
        persistOwnerPid()
        startPromise?.resolve(null)
        startPromise = null
        startPromiseGeneration = 0
    }

    @Synchronized
    private fun resolveStart(generation: Long) {
        if (startPromiseGeneration != generation) return
        startPromise?.resolve(null)
        startPromise = null
        startPromiseGeneration = 0
    }

    @Synchronized
    private fun resolveAnyStart() {
        startPromise?.resolve(null)
        startPromise = null
        startPromiseGeneration = 0
    }

    private fun failStart(generation: Long, message: String) {
        if (lifecycleGeneration.get() != generation) return
        controlMonitorGeneration.compareAndSet(generation, 0)
        emitError(message)
        resolveStart(generation)
    }

    // ── Reattach fast-path helpers (change 1) ────────────────────────────────────────────────

    /**
     * Register the global TorService status broadcast receiver (fast path). Idempotent — a no-op if
     * already registered. Extracted so both the full-restart bind and the reattach rebind share it.
     */
    private fun registerStatusReceiver() {
        if (receiverRegistered) return
        try {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                reactContext.registerReceiver(
                    globalStatusReceiver,
                    IntentFilter(TorService.ACTION_STATUS),
                    Context.RECEIVER_NOT_EXPORTED,
                )
            } else {
                reactContext.registerReceiver(globalStatusReceiver, IntentFilter(TorService.ACTION_STATUS))
            }
            receiverRegistered = true
        } catch (_: Exception) {}
    }

    /**
     * Start StiqTorService as a foreground service (API 26+) / plain service (older). A
     * background-start refusal (Android 12+ ForegroundServiceStartNotAllowedException) is swallowed —
     * the accompanying bindService(BIND_AUTO_CREATE) still starts it as a plain bound service, exactly
     * as the code did before change 2. StiqTorService promotes itself to foreground in onCreate, which
     * both satisfies the startForegroundService deadline and lets the daemon survive backgrounding.
     */
    private fun startTorServiceForegroundGuarded(intent: Intent) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                reactContext.startForegroundService(intent)
            } else {
                reactContext.startService(intent)
            }
        } catch (_: Exception) {}
    }

    private fun stopPtsQuietly() {
        try {
            ptController?.stop(IPtProxy.Obfs4)
            ptController?.stop(IPtProxy.Snowflake)
            ptController?.stop(IPtProxy.Webtunnel)
        } catch (_: Exception) {}
    }

    /**
     * A stable string that uniquely identifies a daemon a later startTor() may reattach to WITHOUT a
     * full restart. Includes exactly the inputs baked into torrc at boot (or read only at boot): the
     * transport, the dormancy flag (changes DormantClientTimeout / padding), the ordered bridge set,
     * and the onion-auth host set (ClientOnionAuthDir is read only at boot / on HUP, so a changed
     * credential set means the running daemon can't resolve a needed onion). Any difference ⇒ the
     * running daemon is incompatible ⇒ full restart.
     */
    private fun computeConfigFingerprint(
        transport: String,
        dormancy: Boolean,
        bridgeLines: ReadableArray?,
        config: ReadableMap,
    ): String = buildString {
        append("t=").append(transport).append('\n')
        append("d=").append(dormancy).append('\n')
        if (bridgeLines != null) {
            for (i in 0 until bridgeLines.size()) {
                append("b=").append(bridgeLines.getString(i)).append('\n')
            }
        }
        config.getMap("onionAuth")?.getString("onionHost")?.let { append("o=").append(it).append('\n') }
        config.getArray("onionAuthExtra")?.let { extra ->
            for (i in 0 until extra.size()) {
                extra.getMap(i)?.getString("onionHost")?.let { append("oe=").append(it).append('\n') }
            }
        }
    }

    private fun persistConfigFingerprint() {
        val fp = pendingConfigFingerprint ?: return
        try {
            File(reactContext.getDir("TorService", Context.MODE_PRIVATE), "config_fingerprint").writeText(fp)
        } catch (_: Exception) {}
    }

    /**
     * Record the pid the CONNECTED daemon's `__OwningControllerProcess` dead-man's switch is currently
     * watching. Same file-in-the-TorService-dir mechanism, and the same "only on a real connect"
     * semantics, as persistConfigFingerprint above — deliberately, because it must survive exactly what
     * that must survive: the death of this process. A pid only means something to another process, and
     * the reader is the NEXT process's startTor(); an in-memory field or anything scoped to this
     * process is definitionally unreadable by the only caller that needs it.
     *
     * Writing at connect time (rather than at torrc-write time) is what makes the value trustworthy in
     * the direction that matters. The dangerous reading is a stale myPid: it would make the next
     * reattach skip the adoption below and hand JS a 'connected' over a daemon whose owner is a corpse.
     * That cannot happen here — a process only ever writes its OWN pid, and at the instant it does, the
     * live daemon is genuinely owned by it on every path that reaches completeStart: a full restart
     * booted from a torrc this process wrote with this pid, and a reattach only got here after the
     * SETCONF below was accepted. The opposite staleness (file names a pid that is NOT the owner, e.g.
     * a SETCONF that succeeded but whose start never completed) is self-correcting: the next reattach
     * simply re-issues an idempotent SETCONF.
     *
     * Ungated by TOR_REATTACH, matching persistConfigFingerprint (the fingerprint file is likewise
     * consumed only by the reattach path). With the flag false this file is written and never read —
     * inert. Flipping the flag back on later is safe: an absent/stale pid reads as "not mine", which
     * takes the adopt path rather than the skip path.
     */
    private fun persistOwnerPid() {
        try {
            File(reactContext.getDir("TorService", Context.MODE_PRIVATE), "owner_pid")
                .writeText(android.os.Process.myPid().toString())
        } catch (_: Exception) {}
    }

    /** The persisted owner pid, or null when absent/unreadable/malformed (⇒ treated as "not mine"). */
    private fun readPersistedOwnerPid(torServiceDir: File): Int? = try {
        val f = File(torServiceDir, "owner_pid")
        if (f.exists()) f.readText().trim().toIntOrNull() else null
    } catch (_: Exception) {
        null
    }

    /**
     * Step 0 of the reattach fast-path: re-point the live daemon's `__OwningControllerProcess`
     * dead-man's switch at THIS process, and — as a side effect that the direct path depends on —
     * synchronously PROBE that the daemon's control socket really answers commands.
     *
     * WHY THIS EXISTS. buildTorrc bakes `__OwningControllerProcess <main pid>` into the torrc, and tor's
     * process monitor polls that pid roughly every 15 seconds and exits when it disappears. That is a
     * hard cap on the daemon's lifetime: main process lifetime + ~15 s, no matter what the :tor
     * foreground service or stopWithTask=false do. Reattach does NOT cause the self-kill — the daemon
     * is already doomed the moment the main process dies. What reattach does without this step is adopt
     * a corpse-in-waiting and report 'connected' over it, which is precisely why this cannot be fixed
     * on the detection side: at that instant the liveness check genuinely passes and the daemon
     * genuinely is bootstrapped. Only re-arming the switch at the live pid removes the cap.
     *
     * NOT TAKEOWNERSHIP. That would re-impose the same cap for the same reason with nothing gained, and
     * worse: it ties the daemon's life to the CONTROL CONNECTION, and every control connection in this
     * file is short-lived (open → auth → command → QUIT → close). Tor would exit the moment the socket
     * closed, killing the daemon instantly rather than in 15 s.
     *
     * UNVERIFIED PREMISE — treated as such. That tor 0.4.8.22 accepts SETCONF for this option is
     * reasoned from the control-spec, not observed on-device. So a non-250 is NOT an error: it is an
     * ordinary reattach miss. Returning false drops the caller through to the unchanged full-restart
     * path, which boots a fresh daemon from a torrc naming this process — correct, merely slower. The
     * feature degrades to exactly today's behavior if the premise is wrong.
     *
     * Returns true when the daemon is already ours (nothing to do) or the SETCONF is accepted; false on
     * any other reply, a dead/unresponsive control socket, or any exception. Never throws.
     */
    private fun adoptOwningControllerProcess(torServiceDir: File): Boolean {
        val myPid = android.os.Process.myPid()
        val ownerPid = readPersistedOwnerPid(torServiceDir)
        // The dominant path: same process, so the switch already names a live pid — this daemon is one
        // we booted and never stopped owning (a JS module reload, or a reconnect within one process).
        // Nothing to adopt, nothing to probe, no control connection opened: behavior is identical to
        // before this step existed.
        if (ownerPid == myPid) return true

        // Different (or unknown) owner ⇒ this daemon is watching a pid that is almost certainly already
        // dead — the previous process's. Re-arm the switch before anyone reports success over it.
        val adopted = sendControlSetConf("__OwningControllerProcess=$myPid")
        if (!adopted) {
            android.util.Log.w(
                "StiqTor",
                "reattach: SETCONF __OwningControllerProcess=$myPid not accepted (persisted owner=$ownerPid); treating as a reattach miss → full restart",
            )
            return false
        }
        android.util.Log.i("StiqTor", "reattach: adopted daemon (owner pid $ownerPid → $myPid)")
        return true
    }

    /**
     * Reattach to a still-alive, config-compatible :tor daemon instead of the full wait-for-exit /
     * force-kill / tor_run_main restart (change 1). Steps, in order (all throwing steps BEFORE the
     * monitor is armed, so a failure never leaves a duplicate monitor for this generation):
     *   0. adopt the daemon's __OwningControllerProcess dead-man's switch if it still names a previous
     *      process — otherwise the daemon we are about to report 'connected' over self-terminates
     *      within ~15 s of that pid's death (see adoptOwningControllerProcess). Its checked SETCONF
     *      reply is also the reattach's only SYNCHRONOUS probe that the control socket answers
     *      commands at all — isTorControlAlive() proves only that something accepts a connection, and
     *      the direct path below has no other checked reply (SIGNAL ACTIVE's is discarded), so a
     *      half-dead daemon would otherwise be discovered only by the control monitor's 45 s deadline.
     *   1. (transports only) restart the PT via the process-singleton Controller and repoint the live
     *      daemon at the new PT SOCKS port via SETCONF ClientTransportPlugin — the PT listener lives
     *      in THIS process and is gone after a reload even though the daemon survives. In 'direct'
     *      mode there is no ClientTransportPlugin, so this is skipped.
     *   2. SIGNAL ACTIVE — wake the daemon if it went dormant while backgrounded.
     *   3. rebind the service (+ re-register the status receiver, re-issue startForegroundService).
     *   4. re-arm the control-socket monitor LAST: against an already-bootstrapped daemon it reads
     *      status/bootstrap-phase = 100 and fires completeStart → the standard 'connected' event
     *      (contract C2 — no new event kinds).
     * Returns true on success (caller returns; the monitor drives 'connected'); false on ANY failure
     * or a superseded generation, having stopped any PT it started, so the caller falls through to the
     * unchanged full-restart path. Never throws.
     */
    private fun tryReattach(
        generation: Long,
        transport: String,
        torServiceDir: File,
        torDataDir: File,
        ptStateDir: File,
    ): Boolean {
        return try {
            if (lifecycleGeneration.get() != generation) return false
            android.util.Log.i("StiqTor", "startTor: reattaching to live daemon (transport=$transport, gen=$generation)")

            // 0. Adopt the dead-man's switch + probe the control socket. Deliberately FIRST: it is the
            // cheapest step, it opens no PT, and a miss here must cost nothing to unwind. Returning
            // false (never throwing, never failStart) is an ordinary reattach miss → full restart.
            if (!adoptOwningControllerProcess(torServiceDir)) return false

            // 1. Repoint pluggable transports (skip in direct mode — no ClientTransportPlugin).
            if (transport != "direct") {
                val ptPort = startPt(transport, ptStateDir.absolutePath)
                if (lifecycleGeneration.get() != generation) { stopPtsQuietly(); return false }
                val repointed = sendControlSetConf("ClientTransportPlugin=\"$transport socks5 127.0.0.1:$ptPort\"")
                if (!repointed) {
                    throw IllegalStateException("SETCONF ClientTransportPlugin failed (daemon may treat it as immutable)")
                }
                android.util.Log.i("StiqTor", "reattach: repointed $transport PT → 127.0.0.1:$ptPort")
            }

            // 2. Wake from any dormant state so it rebuilds circuits promptly.
            sendControlSignal("ACTIVE")

            // 3. Rebind the service on the main thread.
            val intent = Intent(reactContext, StiqTorService::class.java)
                .putExtra("org.torproject.android.intent.extra.PACKAGE_NAME", reactContext.packageName)
                .putExtra("org.torproject.android.intent.extra.SERVICE_PACKAGE_NAME", reactContext.packageName)
            mainHandler.post {
                if (lifecycleGeneration.get() != generation) return@post
                registerStatusReceiver()
                startTorServiceForegroundGuarded(intent)
                try {
                    // Drop any stale prior binding first (safe: a started + foreground service is not
                    // destroyed by an unbind; its onServiceDisconnected is generation-guarded). A no-op
                    // on a fresh module instance after a reload — nothing to unbind.
                    unbindActiveConnectionOnMain()
                    val connection = makeServiceConnection(generation)
                    activeServiceConnection = connection
                    reactContext.bindService(intent, connection, Context.BIND_AUTO_CREATE)
                } catch (e: Exception) {
                    failStart(generation, "service rebind failed: ${e.message}")
                }
            }

            // 4. Re-arm the control monitor LAST — it emits 'connected' when it reads bootstrap 100.
            startControlSocketMonitor(torDataDir, generation)
            true
        } catch (e: Throwable) {
            android.util.Log.w("StiqTor", "startTor: reattach step failed; will full-restart", e)
            stopPtsQuietly()
            false
        }
    }

    private fun startPt(transport: String, stateDir: String): Int {
        // Route PT error callbacks at THIS instance before the Controller can fire any. The Controller
        // is process-scoped (see the companion object) and so is the closure below — it belongs
        // forever to whichever instance first constructed it, which after a module reload is a dead
        // one. This re-point is what keeps errors flowing to the live instance.
        ptEventTarget = this
        // Reuse the single process-wide Controller. IPtProxy/gomobile only permits one
        // Controller per process — constructing a second throws "trackGoRef called with Java
        // refnum N", which previously made every reconnect after the first fail (no PT → no
        // Tor). Created lazily on first use, kept for the PROCESS lifetime (not this instance's).
        val ctrl = ptController ?: Controller(
            stateDir,
            false, false, "ERR",
            object : OnTransportEvents {
                override fun connected(name: String?) {}
                override fun error(name: String?, error: java.lang.Exception?) {
                    // Via the companion, never the captured outer instance: this fires on a
                    // gomobile-owned thread, and emit() through a torn-down ReactApplicationContext
                    // throws. Guarded for the same reason — an exception thrown back into Go here has
                    // no sensible handler.
                    try {
                        ptEventTarget?.emitError("IPtProxy error ($name): ${error?.message}")
                    } catch (_: Exception) {}
                }
                override fun stopped(name: String?, error: java.lang.Exception?) {}
            }
        ).also { ptController = it }
        // TRANSPORT STRINGS MUST MATCH client/src/tor/types.ts TransportType: direct|webtunnel|obfs4|snowflake.
        // Only the three pluggable-transport values reach startPt(): 'direct' never does — startTor()
        // maps it to a warm-up 'obfs4' PT and buildTorrc guards the ClientTransportPlugin line with
        // `if (transport != "direct")`. The 'else' arm below is 'obfs4' (the default PT). Renaming any
        // string on one side only is caught by client/src/tor/transportContract.test.ts. Do NOT edit.
        val ptName = when (transport) {
            "snowflake" -> IPtProxy.Snowflake
            "webtunnel" -> IPtProxy.Webtunnel
            else -> IPtProxy.Obfs4
        }
        ctrl.start(ptName, null)
        val port = ctrl.port(ptName).toInt()
        check(port > 0) { "IPtProxy failed to start $transport (port=$port)" }
        return port
    }

    private fun buildTorrc(
        transport: String,
        ptPort: Int,
        dataDir: String,
        bridgeLines: ReadableArray?,
        onionAuthDir: String?,
        dormancy: Boolean,
    ): String = buildString {
        appendLine("DataDirectory $dataDir")
        // CookieAuthentication (A5/A7 hardening): require any control connection to prove it can
        // read this process's own control_auth_cookie file before it may issue commands, instead of
        // relying on an implicit/NULL-auth default. startControlSocketMonitor()/sendControlSignal()
        // already try NULL auth first and fall back to reading control_auth_cookie from this same
        // DataDirectory — unchanged by this line — so this is belt-and-suspenders: pinned
        // explicitly, like IsolateSOCKSAuth below, rather than left to whatever the bundled
        // tor-android AAR happens to force on its own invocation today (see the ControlSocket note
        // just below — decompiling that AAR shows it does force some options this way).
        appendLine("CookieAuthentication 1")
        // ControlSocket is DELIBERATELY NOT pinned here — TODO: re-verify on-device if the bundled
        // info.guardianproject:tor-android version ever changes. Decompiling the current AAR
        // (tor-android-0.4.8.22.aar → org/torproject/jni/TorService.class / TorService$3.class)
        // shows its own tor invocation carries a forced `--ControlSocket <getControlSocket()>`
        // command-line argument (alongside forced `--DataDirectory`/`--CookieAuthentication`/
        // `--CacheDirectory`/etc.), built AFTER the `-f <torrc>` file argument in the same argv —
        // so an explicit `ControlSocket <path>` directive written INTO this torrc would be a real
        // duplicate directive that the AAR's own forced arg overrides anyway (last value wins for
        // a singleton option like this), not a merely hypothetical conflict. isTorControlAlive()/
        // startControlSocketMonitor() below hardcode `<dataDir>/ControlSocket`, matching this
        // file's header comment ("confirmed from logcat") — re-verify that still holds (dump
        // app_TorService/torrc + the running :tor process's /proc/<pid>/cmdline) before ever adding
        // an explicit ControlSocket line here; until then, leaving it unset and trusting the AAR's
        // forced arg is the lower-risk choice.
        // v3 onion client authorization (lever 2): point Tor at the dir holding the community's
        // <host>.auth_private credential so it can resolve the members-only relay's auth-gated
        // descriptor. Absent → a public onion, unchanged. See src/tor/onionAuth.ts.
        if (onionAuthDir != null) {
            appendLine("ClientOnionAuthDir $onionAuthDir")
        }
        // 'auto' lets Tor pick a free ephemeral port instead of a fixed 9050. Critical on a
        // device where the app is cloned (Samsung Dual Messenger / Secure Folder): all app
        // copies share the 127.0.0.1 namespace, so a hardcoded 9050 means the second copy's
        // Tor can't bind and the two fight. With 'auto' each copy gets its own port; the
        // control-socket monitor queries the real port via GETINFO net/listeners/socks.
        //
        // IsolateSOCKSAuth is PINNED EXPLICITLY, not left to Tor's default. Our anonymity
        // invariant is per-blind-post / per-session circuit isolation: StiqSocketModule opens each
        // stream with a unique SOCKS username+password (socketId/circuitTag) so Tor gives it its
        // own circuit. That only holds while IsolateSOCKSAuth is active. It happens to be Tor's
        // default today, but a future torrc edit (or a Tor default change) could silently collapse
        // every session onto one shared identity circuit — so we state it here rather than rely on
        // an implicit default.
        // ExtendedErrors turns the opaque SOCKS5 "general failure" (0x01) that every onion dial
        // failure collapses into a specific 0xF0-0xF7 onion cause: descriptor-not-found vs
        // rendezvous-failed vs wrong-client-auth. Those demand OPPOSITE responses — the first two are
        // transient and worth retrying, wrong-auth is fatal and retrying it forever is pointless — and
        // without this flag the client cannot tell them apart. Decoded by SocksReply. Tor proposal
        // 304, supported since 0.4.3; bundled tor is 0.4.8.22. Diagnostics only: it changes no
        // success path, and a SOCKS client that ignores the extended code just sees a failure as
        // before.
        appendLine("SOCKSPort auto IsolateSOCKSAuth ExtendedErrors")
        // SafeSocks (A5/A7 hardening): reject SOCKS4 and locally-pre-resolved-IP SOCKS5 requests on
        // this port. Defense-in-depth, not a behavior change today: every dial through this app
        // (StiqSocketModule, the relay WebSocket) targets an onion HOSTNAME over SOCKS5 with
        // Tor-side (remote) resolution — the one request shape SafeSocks always permits — so
        // today's connect behavior is byte-identical; this only forecloses a future accidental
        // local-DNS/IP dial from silently working over the SOCKS port instead of failing loudly.
        appendLine("SafeSocks 1")
        appendLine("HTTPTunnelPort auto")
        if (transport != "direct") {
            // TRANSPORT STRINGS MUST MATCH client/src/tor/types.ts TransportType: direct|webtunnel|obfs4|snowflake.
            // The raw `transport` here is passed VERBATIM as the ClientTransportPlugin name and MUST equal the
            // PT name IPtProxy launched in startPt() (webtunnel|obfs4|snowflake). 'direct' is handled by the else
            // branch below and never appears here. Governed by client/src/tor/transportContract.test.ts — do NOT
            // rename one side without the other.
            appendLine("ClientTransportPlugin $transport socks5 127.0.0.1:$ptPort")
            appendLine("UseBridges 1")
            if (bridgeLines != null) {
                for (i in 0 until bridgeLines.size()) {
                    appendLine("Bridge ${bridgeLines.getString(i)}")
                }
            }
        } else {
            // Plain Tor: explicitly disable bridges so any leftover bridge directive from
            // torrc-defaults or a previous run can't force bridge mode.
            appendLine("UseBridges 0")
        }
        // Allow IPv6 entry connections IN ADDITION to IPv4 (ClientUseIPv4 stays default-on, and
        // ClientPreferIPv6ORPort stays 'auto' so Tor picks whichever works). Many mobile carriers
        // are IPv6-only (NAT64/464XLAT); without this, ClientUseIPv6 defaults to 0 and plain Tor
        // to IPv4-only guard relays cannot reach the network on those carriers. Additive and safe
        // on dual-stack networks; a user who pastes an IPv6 bridge line also benefits.
        appendLine("ClientUseIPv6 1")
        // Disable conflux (multi-path circuit stitching) — causes circuit failures on
        // some Tor versions when connecting to onion services over bridge transports.
        appendLine("ConfluxEnabled 0")
        // --- Connection liveness / keep-alive (see docs/HANDOFF.md "Keeping Tor alive") -------
        // Mobile networks drop a quiet onion connection fast (carrier NAT idle timeouts, radio
        // sleep). These keep the bundled Tor's connection + rendezvous circuit warm so the relay
        // socket survives idle periods WITHOUT churning a new identity (we deliberately do NOT
        // spam SIGNAL NEWNYM — that doesn't refresh a live circuit and only costs reachability).
        // The app holds the relay WebSocket open as the long-lived stream; Tor keeps the path up.
        appendLine("KeepalivePeriod 60")                    // PADDING keepalive on in-use conns (default 300)
        appendLine("MaxCircuitDirtiness 3600")              // don't rotate the live onion circuit out (default 600)
        appendLine("CircuitsAvailableTimeout 3600")         // keep a clean circuit pre-warmed (default 1800)
        // Flag-gated (TOR_DORMANCY, ship-dark). dormancy=false is the EXISTING force-kill lifecycle:
        // it emits ConnectionPadding 1 / ReducedConnectionPadding 0 byte-for-byte as before, so the
        // flag-off torrc is unchanged. dormancy=true lets Tor idle its circuits/padding and self-
        // dormant after 10 min of no app-driven activity (paired with the SIGNAL DORMANT lifecycle).
        if (dormancy) {
            appendLine("ConnectionPadding auto")            // let Tor drop padding as it idles toward dormant
            appendLine("ReducedConnectionPadding 1")        // favor battery over liveness when backgrounded
            // C1: explicit-signal-only dormancy. 86400 (24h) is effectively "never auto-dormant" — the
            // app drives dormancy explicitly via SIGNAL DORMANT (background) / SIGNAL ACTIVE
            // (foreground). A short auto-timeout would let a foreground-idle session (the feed WS held
            // open but quiet) go dormant under Tor and stall the socket; the held-open relay socket is
            // also counted as activity by DormantTimeoutDisabledByIdleStreams below.
            appendLine("DormantClientTimeout 86400")        // explicit SIGNAL DORMANT only; never auto-dormant
        } else {
            appendLine("ConnectionPadding 1")               // keep the TLS connection + NAT mapping warm
            appendLine("ReducedConnectionPadding 0")        // favor liveness over battery on an active session
        }
        appendLine("DormantTimeoutDisabledByIdleStreams 1") // the held-open relay socket counts as activity
        appendLine("DormantCanceledByStartup 1")            // each app launch starts ACTIVE, never dormant
        // Defense-in-depth: this is a pure client. Forbid Tor from ever acting as a relay or
        // directory mirror even if some future config path accidentally enabled ORPort/DirPort.
        appendLine("ClientOnly 1")
        // Dead-man's switch: bind this tor to the MAIN (controlling) process's pid. buildTorrc runs
        // in the main process, so Process.myPid() IS the controller. Tor polls this pid every ~15s
        // and self-terminates if it disappears — so an orphaned :tor left behind by an unclean main
        // process death cannot linger and wedge the next launch's teardown barrier.
        //
        // The flip side, and it is a big one: this also HARD-CAPS the daemon's lifetime at this
        // process's lifetime + ~15s, whatever the :tor foreground service or stopWithTask=false say. A
        // daemon that outlives its owning process is not a survivor, it is a corpse-in-waiting. That is
        // why the switch is re-armed at the new pid on reattach (adoptOwningControllerProcess) rather
        // than left pointing at a dead process, and why completeStart persists the pid it names
        // (persistOwnerPid) — from the outside, "mine" and "counting down" look identical.
        appendLine("__OwningControllerProcess ${android.os.Process.myPid()}")
        appendLine("Log notice stderr")
        appendLine("SafeLogging 1")
    }

    // ── Event emitters ─────────────────────────────────────────────────────────────────────

    private fun emit(body: WritableNativeMap) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("StiqTorStatus", body)
    }

    /**
     * A dedicated channel (separate from Tor status) for default-network-change nudges. The payload
     * now carries the coarse `networkClass` (transport type only — see currentNetworkClass) so the
     * JS layer can swap to that class's cached bridges. The event NAME is unchanged
     * ('StiqTorNetworkChange'); the existing App.tsx listener reads none of the payload, so adding
     * fields is backward compatible.
     */
    private fun emitNetworkChanged() {
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(
                    "StiqTorNetworkChange",
                    WritableNativeMap().apply { putString("networkClass", currentNetworkClass()) },
                )
        } catch (_: Exception) {}
    }

    private fun emitStarting() =
        emit(WritableNativeMap().apply { putString("kind", "starting") })

    private fun emitBootstrapping(percent: Int, summary: String) =
        emit(WritableNativeMap().apply {
            putString("kind", "bootstrapping")
            putInt("percent", percent)
            putString("summary", summary)
        })

    private fun emitConnected(socksPort: Int) =
        emit(WritableNativeMap().apply {
            putString("kind", "connected")
            putMap("socks", WritableNativeMap().apply {
                putString("host", "127.0.0.1")
                putInt("port", socksPort)
            })
            // Optional: surface the running daemon version when the monitor learned it. Omitted
            // (not null) when unknown so the connected event stays valid on older/edge builds.
            lastTorVersion?.let { putString("torVersion", it) }
        })

    private fun emitError(message: String) =
        emit(WritableNativeMap().apply {
            putString("kind", "error")
            putString("message", message)
        })

    private fun emitStopped() =
        emit(WritableNativeMap().apply { putString("kind", "stopped") })
}
