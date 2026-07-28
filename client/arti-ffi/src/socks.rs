//! A minimal SOCKS5 server that bridges local TCP connections onto Arti circuits.
//!
//! =====================================================================================
//! WHY THIS FILE EXISTS AT ALL
//! =====================================================================================
//! `arti-client` ships **no SOCKS proxy**. It exposes `TorClient::connect()` and nothing else; the
//! `arti` command-line binary has a proxy, but that is a binary, not a stable library API, so it
//! cannot be depended on. Meanwhile *every* path STIQ has to the network — the relay WebSocket
//! (`StiqSocketModule`), media/HTTP (`StiqHttpModule`), updates (`StiqUpdateModule`), the WebView
//! (`StiqWebProxyModule`) — dials a **local SOCKS port**. That port is the entire seam between the
//! app and the Tor engine.
//!
//! So this file is the load-bearing piece of the Arti swap: without it there is nothing for the app
//! to connect to, and `arti_start` cannot honestly report `connected`.
//!
//! =====================================================================================
//! THE SCOPE IS DELIBERATELY SMALL
//! =====================================================================================
//! This is not a general-purpose SOCKS proxy and must not grow into one. It implements exactly what
//! STIQ's own clients speak, and refuses everything else:
//!   * CONNECT only — no BIND, no UDP ASSOCIATE (STIQ never issues them; an onion has no use for
//!     either, and each is extra attack surface listening on localhost).
//!   * SOCKS5 only — a SOCKS4 client is rejected at the version byte.
//!   * DOMAINNAME, IPv4 and IPv6 address types. **DOMAINNAME is the one that matters**: a `.onion`
//!     must reach Arti as a *name*, so the resolution happens inside the Tor network. If a hostname
//!     were resolved locally first, the DNS query would leak outside Tor and, for a `.onion`, would
//!     simply fail — there is no such record in the public DNS.
//!
//! =====================================================================================
//! ⚠ THE AUTHENTICATION METHOD IS A SAFETY PROPERTY, NOT A FORMALITY
//! =====================================================================================
//! `StiqSocketModule.socks5Connect` offers `NO-AUTH + USER/PASS` and accepts whichever the server
//! picks. It passes a per-session `socketId` as both username and password, and it hard-fails when
//! those are empty, with this comment:
//!
//!     "A NO-AUTH stream carries no isolation signature, so two sessions that took a NO-AUTH path
//!      could silently collapse onto the SAME circuit — an anonymity failure."
//!
//! Under C-tor that isolation is `IsolateSOCKSAuth`, on by default. **Arti has no such thing.** If
//! this server answered `NO-AUTH`, the Kotlin client would carry on perfectly happily and every
//! relay session in the app would quietly share one circuit: no error, no log line, no failing
//! test. That is precisely the failure mode the Kotlin comment is guarding against.
//!
//! Therefore this server:
//!   1. **prefers USER/PASS over NO-AUTH** whenever the client offers both (see `select_auth_method`
//!      — the ordering there is the safety property, not a style choice), and
//!   2. turns the credential pair into a `SocksAuthIsolation`, which is Arti's `IsolationHelper`
//!      spelling of "same credentials may share a circuit; different credentials never may".
//!
//! A client that genuinely offers only NO-AUTH is still served, but its streams get
//! `isolate_every_stream()` — never sharing is the fail-safe direction.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use std::sync::Arc;

use arti_client::config::BoolOrAuto;
use arti_client::isolation::IsolationHelper;
use arti_client::{ErrorKind, HasKind, StreamPrefs, TorClient};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tor_rtcompat::Runtime;

// ── Wire constants (RFC 1928 / RFC 1929) ─────────────────────────────────────────────────────────

const VER_SOCKS5: u8 = 0x05;
const AUTH_NONE: u8 = 0x00;
const AUTH_USERPASS: u8 = 0x02;
/// Sent as the selected method when we can satisfy nothing the client offered; the client must then
/// close the connection (RFC 1928 §3).
const AUTH_UNACCEPTABLE: u8 = 0xFF;
/// Version byte of the username/password sub-negotiation — 0x01, and unrelated to the SOCKS version.
const VER_USERPASS_SUBNEG: u8 = 0x01;
const CMD_CONNECT: u8 = 0x01;
const ATYP_IPV4: u8 = 0x01;
const ATYP_DOMAIN: u8 = 0x03;
const ATYP_IPV6: u8 = 0x04;

/// SOCKS5 reply codes.
///
/// The `0xF0`–`0xF7` range is Tor proposal 304, and these values are **the contract with
/// `SocksReply.kt`** — that file decodes exactly these bytes, and `SocksReply.isFatal()` decides
/// retry policy from them (`0xF1/0xF4/0xF5/0xF6` are permanent; the rest are worth retrying). Change
/// a value here and you silently change the app's retry behaviour.
///
/// Worth noting: under C-tor these extended codes only appear when the SOCKSPort carries the
/// `ExtendedErrors` flag. Here we are the server, so STIQ gets them unconditionally — including the
/// two that matter most for a members-only relay, "missing client auth" and "wrong client auth",
/// which are otherwise indistinguishable from a generic failure.
pub(crate) mod rep {
    pub const SUCCEEDED: u8 = 0x00;
    pub const GENERAL_FAILURE: u8 = 0x01;
    pub const NOT_ALLOWED: u8 = 0x02;
    pub const NETWORK_UNREACHABLE: u8 = 0x03;
    pub const HOST_UNREACHABLE: u8 = 0x04;
    pub const CONNECTION_REFUSED: u8 = 0x05;
    pub const TTL_EXPIRED: u8 = 0x06;
    pub const CMD_NOT_SUPPORTED: u8 = 0x07;
    pub const ATYP_NOT_SUPPORTED: u8 = 0x08;
    pub const ONION_DESC_NOT_FOUND: u8 = 0xF0;
    pub const ONION_DESC_INVALID: u8 = 0xF1;
    pub const ONION_INTRO_FAILED: u8 = 0xF2;
    pub const ONION_REND_FAILED: u8 = 0xF3;
    pub const ONION_MISSING_CLIENT_AUTH: u8 = 0xF4;
    pub const ONION_WRONG_CLIENT_AUTH: u8 = 0xF5;
    pub const ONION_ADDRESS_INVALID: u8 = 0xF6;
}

// ── Pure protocol logic ──────────────────────────────────────────────────────────────────────────
// Everything in this section is deliberately free of IO and of Arti: it is the part worth unit
// testing, and the part where a mistake is a protocol bug rather than a plumbing bug.

/// Pick an authentication method from the list the client offered.
///
/// **USER/PASS is checked first on purpose.** See this module's header: choosing NO-AUTH when the
/// client would also have done USER/PASS throws away the only per-stream isolation signal STIQ has,
/// and does so silently. Do not "simplify" this by preferring the cheaper method.
pub(crate) fn select_auth_method(offered: &[u8]) -> u8 {
    if offered.contains(&AUTH_USERPASS) {
        AUTH_USERPASS
    } else if offered.contains(&AUTH_NONE) {
        AUTH_NONE
    } else {
        AUTH_UNACCEPTABLE
    }
}

/// Where a CONNECT request wants to go.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Target {
    /// A hostname — including every `.onion`. Passed to Arti verbatim so that resolution happens
    /// **inside** the Tor network.
    Domain(String),
    /// A literal address. Still dialled over Tor; see `connect_target` for why this needs Arti's
    /// "dangerously" conversion.
    Ip(IpAddr),
}

/// Build the 10-byte CONNECT reply.
///
/// We always answer with `ATYP=IPv4, BND.ADDR=0.0.0.0, BND.PORT=0`. The bound address is meaningless
/// for a proxied CONNECT (there is no local socket the peer could usefully dial), C-tor answers the
/// same way, and STIQ's parsers only branch on ATYP to know how many bytes to consume.
pub(crate) fn encode_reply(reply: u8) -> [u8; 10] {
    [VER_SOCKS5, reply, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]
}

/// Translate an Arti error into the SOCKS reply byte that best describes it.
///
/// Arti's `ErrorKind` happens to carry almost exactly the distinctions Tor proposal 304 encodes, so
/// this mapping is nearly 1:1 — notably `OnionServiceMissingClientAuth` / `OnionServiceWrongClientAuth`,
/// which are the difference between "this community has not granted you reach yet" and "your key is
/// stale", and which STIQ already treats as permanent failures.
pub(crate) fn reply_code_for(kind: ErrorKind) -> u8 {
    match kind {
        ErrorKind::OnionServiceNotFound => rep::ONION_DESC_NOT_FOUND,
        ErrorKind::OnionServiceProtocolViolation => rep::ONION_DESC_INVALID,
        ErrorKind::OnionServiceNotRunning => rep::ONION_INTRO_FAILED,
        ErrorKind::OnionServiceConnectionFailed => rep::ONION_REND_FAILED,
        ErrorKind::OnionServiceMissingClientAuth => rep::ONION_MISSING_CLIENT_AUTH,
        ErrorKind::OnionServiceWrongClientAuth => rep::ONION_WRONG_CLIENT_AUTH,
        ErrorKind::OnionServiceAddressInvalid => rep::ONION_ADDRESS_INVALID,

        ErrorKind::RemoteConnectionRefused => rep::CONNECTION_REFUSED,
        ErrorKind::RemoteHostNotFound | ErrorKind::RemoteHostResolutionFailed => {
            rep::HOST_UNREACHABLE
        }
        // "Not allowed by ruleset" is the honest answer for a target we refused to dial: an exit
        // policy said no, or our own address filter did (which is what an `.onion` request hits if
        // onion support is ever misconfigured off — see `stream_prefs`).
        ErrorKind::ExitPolicyRejected
        | ErrorKind::ForbiddenStreamTarget
        | ErrorKind::InvalidStreamTarget => rep::NOT_ALLOWED,
        ErrorKind::RemoteNetworkTimeout | ErrorKind::TorNetworkTimeout | ErrorKind::ExitTimeout => {
            rep::TTL_EXPIRED
        }
        ErrorKind::LocalNetworkError | ErrorKind::RemoteNetworkFailed => rep::NETWORK_UNREACHABLE,

        _ => rep::GENERAL_FAILURE,
    }
}

/// Circuit isolation derived from the SOCKS username/password pair.
///
/// This is the Arti spelling of C-tor's `IsolateSOCKSAuth`. `IsolationHelper` gives us the two
/// guarantees we need for free:
///   * equal credentials are compatible, so one logical session's streams reuse its circuit;
///   * unequal credentials never join, so two sessions can never land on the same circuit;
///   * and because `IsolationHelper` makes *different types* mutually incompatible, an
///     authenticated stream can never share a circuit with an unauthenticated one either.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SocksAuthIsolation {
    user: Vec<u8>,
    pass: Vec<u8>,
}

impl IsolationHelper for SocksAuthIsolation {
    fn compatible_same_type(&self, other: &Self) -> bool {
        self == other
    }

    fn join_same_type(&self, other: &Self) -> Option<Self> {
        // `join` must agree with `compatible`: identical credentials collapse to themselves,
        // anything else has no common isolation and therefore cannot share a circuit.
        if self == other {
            Some(self.clone())
        } else {
            None
        }
    }
}

/// Stream preferences for one proxied connection.
///
/// Two things happen here and both are deliberate:
///
/// 1. **Onion connections are enabled explicitly.** `arti-client` defaults
///    `address_filter.allow_onion_addrs` to `true`, and at 0.44
///    `StreamPrefs::connect_to_onion_services` finally documents it that way too ("which is in turn
///    enabled by default"). At 0.28 that same doc said "disabled by default" — the crate
///    contradicted its own builder, and which side was right decided whether STIQ could talk to
///    anything at all. Keep stating it: a default that has already flipped its documentation once
///    is not something an onion-only app should rest on.
///
/// 2. **Isolation is always set**, one way or the other. There is no code path here that leaves a
///    stream with default (shared) isolation.
pub(crate) fn stream_prefs(auth: Option<SocksAuthIsolation>) -> StreamPrefs {
    let mut prefs = StreamPrefs::new();
    prefs.connect_to_onion_services(BoolOrAuto::Explicit(true));
    match auth {
        Some(iso) => {
            prefs.set_isolation(iso);
        }
        // No credentials to key on, so fall safe: this stream shares with nothing at all.
        None => {
            prefs.isolate_every_stream();
        }
    }
    prefs
}

// ── Server ───────────────────────────────────────────────────────────────────────────────────────

/// A bound, accepting SOCKS5 listener and the means to shut it down.
pub(crate) struct SocksServer {
    /// The port actually bound. When the caller asked for 0 this is the OS-assigned port, and it is
    /// the value `arti_start` returns and `connected` reports — never the requested one.
    pub(crate) port: u16,
    /// Broadcast to every in-flight connection task. Aborting the accept task alone would not stop
    /// them: each holds its own `TorClient` clone, so traffic would keep flowing over Tor after
    /// `arti_stop` returned.
    shutdown: watch::Sender<bool>,
    accept_task: JoinHandle<()>,
    /// One clone per live connection task, plus the one held here. Counting them is how `shutdown`
    /// knows every task has actually finished — see the drain loop below for why that matters.
    live: Arc<()>,
}

impl SocksServer {
    /// Stop accepting, cancel every live proxied connection, and WAIT for them to finish.
    ///
    /// THE WAIT IS THE POINT. Signalling is not enough, because the caller's very next act is to
    /// build a new `TorClient`, and a new client cannot take `state/state.lock` while any clone of
    /// the old one is still alive. Every connection task holds such a clone. Returning before they
    /// drop produced a daemon that could start exactly once per process: the first connect worked,
    /// and every reconnect after it died with `operation not implemented: Error setting up the
    /// guard manager` (GuardMgr's rendering of a missed lock) until the app was force-stopped.
    ///
    /// Deliberately UNBOUNDED in here — `arti_stop` (this function's only caller) is what bounds
    /// it now, racing this against a single shared deadline alongside the OTHER graceful-teardown
    /// step (`wait_for_stop`). This function used to carry its own separate drain budget, which
    /// made the two steps additive (this one's budget, in full, THEN the other's) instead of
    /// sharing one ceiling — see `arti_stop`'s `GRACEFUL_BUDGET` doc for the ~8s-worst-case bug
    /// that produced. A hang here is still survivable: `arti_stop`'s `Runtime::shutdown_timeout`
    /// is the hard backstop that aborts everything regardless, and `create_client_retrying_lock`
    /// absorbs whatever a stale clone leaves behind. Do not add a new caller of this function
    /// without giving it the same timeout treatment `arti_stop` does.
    pub(crate) async fn shutdown(self) {
        const POLL: std::time::Duration = std::time::Duration::from_millis(10);

        // Signal first, abort second: the signal cancels each connection task at its own next await
        // point, and the accept task is the only one it is safe to kill outright.
        let _ = self.shutdown.send(true);
        self.accept_task.abort();

        // Drain. `live` starts at 1 (this struct's own clone), so 1 means every task is gone.
        while Arc::strong_count(&self.live) > 1 {
            tokio::time::sleep(POLL).await;
        }
    }
}

/// Bind the listener and start accepting.
///
/// Binds to loopback only — this port must never be reachable from off-device. Pass `port = 0` to
/// let the OS choose; the chosen port comes back in `SocksServer::port`.
pub(crate) async fn serve<R: Runtime>(
    // `Arc<TorClient<_>>`, not `TorClient<_>`: as of arti-client 0.44 the builder hands back an
    // `Arc` and `TorClient` no longer implements `Clone` itself. The per-connection fan-out below
    // still needs a cheap clone per task, so the sharing that used to live inside `TorClient` is
    // now explicit here. Semantics are unchanged — it was always a shared handle.
    client: Arc<TorClient<R>>,
    port: u16,
) -> io::Result<SocksServer> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await?;
    // Read the port back rather than echoing the request: with port 0 the requested value is a lie,
    // and reporting a lie here would send the whole app at a port with nothing behind it.
    let bound = listener.local_addr()?.port();

    let (shutdown, rx) = watch::channel(false);
    let live = Arc::new(());
    let accept_task = tokio::spawn(accept_loop(listener, client, rx, Arc::clone(&live)));

    Ok(SocksServer {
        port: bound,
        shutdown,
        accept_task,
        live,
    })
}

async fn accept_loop<R: Runtime>(
    listener: TcpListener,
    client: Arc<TorClient<R>>,
    shutdown: watch::Receiver<bool>,
    live: Arc<()>,
) {
    loop {
        let (sock, _peer) = match listener.accept().await {
            Ok(pair) => pair,
            // A per-connection accept error (fd exhaustion, a client that vanished mid-handshake)
            // must not kill the listener — that would take the whole app offline with no event.
            Err(_) => continue,
        };
        let client = Arc::clone(&client);
        let mut shutdown = shutdown.clone();
        // One token per task, released when the task's future is dropped — however it ends.
        let live = Arc::clone(&live);
        tokio::spawn(async move {
            // The select wraps the WHOLE connection, not just its copy loop, and that is
            // deliberate. `handle_conn` spends its first phase inside `client.connect()`, which on
            // an unreachable target (a members-only onion whose rendezvous keeps failing, say)
            // retries behind long internal timeouts. A task parked there holds a `TorClient` clone
            // for as long as the connect takes, which is exactly the clone that keeps the state
            // lock — and the old daemon — alive past `arti_stop`. Cancelling only the copy phase
            // left those tasks running and made every reconnect fail.
            tokio::select! {
                _ = handle_conn(sock, client) => {}
                _ = shutdown.changed() => {}
            }
            drop(live);
        });
    }
}

/// Hard ceiling on the Tor-side connect phase of one proxied connection.
///
/// Arti time-bounds every step of an onion-service connect EXCEPT the proof-of-work solve:
/// `pow_client.solve().await` (tor-hsclient 0.44, connect.rs:972) has no `runtime.timeout(...)`
/// around it, unlike its sibling steps. When the relay is under attack and raises the suggested
/// effort, a device on the interpreter fallback can spend minutes inside one solve — and the
/// 6-attempt outer cap multiplies that. Without a ceiling here, that parks this task (and the
/// `TorClient` clone it holds) for the duration, and the app just looks frozen.
///
/// The value mirrors C-tor's `SocksTimeout` default (120 s) — the bound every C-tor SOCKS client
/// already lives under. On expiry the client gets `TTL_EXPIRED` (0x06), which `SocksReply.isFatal()`
/// classifies as retryable — the correct signal, because a fresh attempt gets a fresh solve budget.
const CONNECT_CEILING: std::time::Duration = std::time::Duration::from_secs(120);

/// Serve one SOCKS5 client from greeting to close.
///
/// Takes no shutdown channel: cancellation is `accept_loop`'s job, which drops this whole future.
async fn handle_conn<R: Runtime>(mut sock: TcpStream, client: Arc<TorClient<R>>) -> io::Result<()> {
    // Nagle off: SOCKS negotiation is a run of tiny round-trips, and so is the WebSocket traffic
    // that follows. Coalescing them adds latency to every single relay message.
    let _ = sock.set_nodelay(true);

    let auth = negotiate_auth(&mut sock).await?;
    let (target, port) = match read_request(&mut sock).await? {
        Ok(req) => req,
        Err(code) => {
            sock.write_all(&encode_reply(code)).await?;
            return Ok(());
        }
    };

    let prefs = stream_prefs(auth);
    let connected = tokio::time::timeout(
        CONNECT_CEILING,
        connect_target(&client, &target, port, &prefs),
    )
    .await;
    let stream = match connected {
        Err(_elapsed) => {
            #[cfg(target_os = "android")]
            log::warn!(
                "connect to {} exceeded the {}s ceiling: rep={:#04X}",
                abbreviate(&target, port),
                CONNECT_CEILING.as_secs(),
                rep::TTL_EXPIRED
            );
            sock.write_all(&encode_reply(rep::TTL_EXPIRED)).await?;
            return Ok(());
        }
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            let code = reply_code_for(e.kind());
            // Log the failure, because the SOCKS reply byte alone throws almost all of it away.
            // `0x01` in particular is the "no mapping for this ErrorKind" fallback, so on the wire
            // it is indistinguishable from a dozen unrelated causes — which is exactly the opaque
            // `rep=1` that SocksReply.kt was written to escape in the first place.
            //
            // The host is truncated: enough to tell which target failed, not enough to write a
            // reader's full browsing history into logcat. The error itself goes through
            // `describe_arti_error` rather than a raw `{e}` for the same reason, at the relay-
            // identity level instead of the browsing-history one: this fires on every proxied
            // connection the app makes, and arti's own hidden-service errors can carry the
            // specific HsDir/rendezvous relay this client picked for THIS circuit — see that
            // function's doc.
            #[cfg(target_os = "android")]
            log::warn!(
                "connect to {} failed: rep={:#04X}: {}",
                abbreviate(&target, port),
                code,
                crate::describe_arti_error(&e)
            );
            sock.write_all(&encode_reply(code)).await?;
            return Ok(());
        }
    };

    sock.write_all(&encode_reply(rep::SUCCEEDED)).await?;

    // `DataStream` implements tokio's AsyncRead/AsyncWrite because arti-client's `tokio` feature
    // turns on `tor-proto/tokio`, so the two halves can be copied directly with no compat shim.
    //
    // No shutdown select here: `accept_loop` wraps this entire future in one, so a stop cancels the
    // copy at its next await just the same — and also cancels the phases before it, which this
    // never could.
    let mut stream = stream;
    let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
    Ok(())
}

/// Run the greeting and, if we selected it, the RFC 1929 username/password exchange.
///
/// Returns the isolation key for this connection, or `None` when the client authenticated with
/// NO-AUTH (in which case the caller isolates the stream from everything).
async fn negotiate_auth(sock: &mut TcpStream) -> io::Result<Option<SocksAuthIsolation>> {
    let mut head = [0u8; 2];
    sock.read_exact(&mut head).await?;
    if head[0] != VER_SOCKS5 {
        // No reply is possible: a non-SOCKS5 peer would not understand a SOCKS5 error frame.
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "not a SOCKS5 client",
        ));
    }
    let mut methods = vec![0u8; head[1] as usize];
    sock.read_exact(&mut methods).await?;

    let method = select_auth_method(&methods);
    sock.write_all(&[VER_SOCKS5, method]).await?;

    match method {
        AUTH_NONE => Ok(None),
        AUTH_USERPASS => {
            let mut ver = [0u8; 1];
            sock.read_exact(&mut ver).await?;
            if ver[0] != VER_USERPASS_SUBNEG {
                sock.write_all(&[VER_USERPASS_SUBNEG, 0x01]).await?;
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "bad username/password sub-negotiation version",
                ));
            }
            let user = read_len_prefixed(sock).await?;
            let pass = read_len_prefixed(sock).await?;
            // Any credential is accepted — this is an isolation signal, not access control. The
            // listener is loopback-only, so anything that can reach it is already inside the app's
            // sandbox and authenticating it would prove nothing.
            sock.write_all(&[VER_USERPASS_SUBNEG, 0x00]).await?;
            Ok(Some(SocksAuthIsolation { user, pass }))
        }
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "no acceptable SOCKS5 auth method",
        )),
    }
}

async fn read_len_prefixed(sock: &mut TcpStream) -> io::Result<Vec<u8>> {
    let mut len = [0u8; 1];
    sock.read_exact(&mut len).await?;
    let mut buf = vec![0u8; len[0] as usize];
    sock.read_exact(&mut buf).await?;
    Ok(buf)
}

/// Read the CONNECT request.
///
/// The outer `io::Result` is a dead connection; the inner `Result` is a well-formed request we are
/// declining, which the caller answers with a proper SOCKS reply byte.
#[allow(clippy::type_complexity)]
async fn read_request(sock: &mut TcpStream) -> io::Result<Result<(Target, u16), u8>> {
    let mut head = [0u8; 4]; // VER CMD RSV ATYP
    sock.read_exact(&mut head).await?;
    if head[0] != VER_SOCKS5 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "not a SOCKS5 request",
        ));
    }
    if head[1] != CMD_CONNECT {
        return Ok(Err(rep::CMD_NOT_SUPPORTED));
    }

    let target = match head[3] {
        ATYP_IPV4 => {
            let mut octets = [0u8; 4];
            sock.read_exact(&mut octets).await?;
            Target::Ip(IpAddr::V4(Ipv4Addr::from(octets)))
        }
        ATYP_IPV6 => {
            let mut octets = [0u8; 16];
            sock.read_exact(&mut octets).await?;
            Target::Ip(IpAddr::V6(Ipv6Addr::from(octets)))
        }
        ATYP_DOMAIN => {
            let raw = read_len_prefixed(sock).await?;
            match String::from_utf8(raw) {
                Ok(host) => Target::Domain(host),
                // A non-UTF-8 hostname is not a name we could resolve anywhere.
                Err(_) => return Ok(Err(rep::ONION_ADDRESS_INVALID)),
            }
        }
        _ => return Ok(Err(rep::ATYP_NOT_SUPPORTED)),
    };

    let mut port = [0u8; 2];
    sock.read_exact(&mut port).await?;
    Ok(Ok((target, u16::from_be_bytes(port))))
}

/// A log-safe rendering of a target: enough to identify it, not enough to be a browsing history.
#[cfg(target_os = "android")]
fn abbreviate(target: &Target, port: u16) -> String {
    match target {
        Target::Domain(host) => {
            let head: String = host.chars().take(8).collect();
            format!("{head}…:{port}")
        }
        Target::Ip(ip) => format!("{ip}:{port}"),
    }
}

/// Open the Tor stream for a parsed target.
///
/// The two arms differ in more than types. A **hostname** goes through `IntoTorAddr`, which hands
/// the name to Arti and lets the resolution happen inside the network — mandatory for `.onion`, and
/// leak-free for everything else. A **literal IP** can only be converted through
/// `DangerouslyIntoTorAddr`, and the "dangerously" is Arti pointing out that whoever produced that
/// literal already did the DNS lookup somewhere. The traffic still goes over Tor; the risk is a
/// resolution that happened before we were called. STIQ's own callers always send hostnames, so this
/// arm exists for completeness (and for the WebView proxy) rather than for the relay path.
async fn connect_target<R: Runtime>(
    client: &TorClient<R>,
    target: &Target,
    port: u16,
    prefs: &StreamPrefs,
) -> Result<arti_client::DataStream, arti_client::Error> {
    match target {
        Target::Domain(host) => {
            client
                .connect_with_prefs((host.as_str(), port), prefs)
                .await
        }
        Target::Ip(ip) => {
            use arti_client::DangerouslyIntoTorAddr as _;
            let addr = (*ip, port)
                .into_tor_addr_dangerously()
                .map_err(arti_client::Error::from)?;
            client.connect_with_prefs(addr, prefs).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn userpass_wins_whenever_the_client_offers_it() {
        // This is the case STIQ actually produces: StiqSocketModule sends `05 02 00 02`.
        // Selecting NO-AUTH here would silently de-isolate every relay session.
        assert_eq!(select_auth_method(&[AUTH_NONE, AUTH_USERPASS]), AUTH_USERPASS);
        assert_eq!(select_auth_method(&[AUTH_USERPASS, AUTH_NONE]), AUTH_USERPASS);
    }

    #[test]
    fn no_auth_is_served_only_when_it_is_the_only_offer() {
        assert_eq!(select_auth_method(&[AUTH_NONE]), AUTH_NONE);
    }

    #[test]
    fn an_unsatisfiable_offer_is_refused() {
        assert_eq!(select_auth_method(&[0x01, 0x03]), AUTH_UNACCEPTABLE);
        assert_eq!(select_auth_method(&[]), AUTH_UNACCEPTABLE);
    }

    #[test]
    fn reply_is_ten_bytes_of_ipv4_shaped_padding() {
        let r = encode_reply(rep::SUCCEEDED);
        assert_eq!(r.len(), 10);
        assert_eq!(r[0], VER_SOCKS5);
        assert_eq!(r[1], rep::SUCCEEDED);
        assert_eq!(r[2], 0x00, "RSV must be zero");
        assert_eq!(r[3], ATYP_IPV4);
        assert_eq!(&r[4..], &[0, 0, 0, 0, 0, 0], "BND.ADDR:PORT = 0.0.0.0:0");
        assert_eq!(encode_reply(rep::ONION_WRONG_CLIENT_AUTH)[1], 0xF5);
    }

    #[test]
    fn onion_auth_failures_keep_the_codes_socksreply_kt_calls_fatal() {
        // SocksReply.isFatal() treats F1/F4/F5/F6 as permanent. If these drift, the app starts
        // retrying failures that can never succeed (or gives up on ones that would).
        assert_eq!(
            reply_code_for(ErrorKind::OnionServiceMissingClientAuth),
            0xF4
        );
        assert_eq!(reply_code_for(ErrorKind::OnionServiceWrongClientAuth), 0xF5);
        assert_eq!(reply_code_for(ErrorKind::OnionServiceAddressInvalid), 0xF6);
        assert_eq!(reply_code_for(ErrorKind::OnionServiceProtocolViolation), 0xF1);
    }

    #[test]
    fn transient_onion_failures_stay_retryable() {
        for kind in [
            ErrorKind::OnionServiceNotFound,
            ErrorKind::OnionServiceNotRunning,
            ErrorKind::OnionServiceConnectionFailed,
        ] {
            let code = reply_code_for(kind);
            assert!(
                matches!(code, 0xF0 | 0xF2 | 0xF3),
                "{kind:?} produced {code:#04X}, which SocksReply.isFatal() would call permanent"
            );
        }
    }

    #[test]
    fn unmapped_errors_fall_back_to_general_failure() {
        assert_eq!(reply_code_for(ErrorKind::Internal), rep::GENERAL_FAILURE);
    }

    #[test]
    fn identical_credentials_share_a_circuit_and_nothing_else_does() {
        let a = SocksAuthIsolation {
            user: b"session-a".to_vec(),
            pass: b"session-a".to_vec(),
        };
        let same = a.clone();
        let b = SocksAuthIsolation {
            user: b"session-b".to_vec(),
            pass: b"session-b".to_vec(),
        };

        assert!(a.compatible_same_type(&same));
        assert!(a.join_same_type(&same).is_some());

        assert!(!a.compatible_same_type(&b));
        assert!(
            a.join_same_type(&b).is_none(),
            "two sessions joined into one circuit — this is the IsolateSOCKSAuth guarantee"
        );
    }

    #[test]
    fn a_matching_username_with_a_different_password_is_still_a_different_session() {
        let a = SocksAuthIsolation {
            user: b"same".to_vec(),
            pass: b"one".to_vec(),
        };
        let b = SocksAuthIsolation {
            user: b"same".to_vec(),
            pass: b"two".to_vec(),
        };
        assert!(!a.compatible_same_type(&b));
    }

    #[test]
    fn isolation_is_reflexive_as_the_trait_requires() {
        // Isolation::compatible must be reflexive, and join must be idempotent. Getting this wrong
        // means a session cannot even share a circuit with itself, i.e. a new circuit per stream.
        let a = SocksAuthIsolation {
            user: b"x".to_vec(),
            pass: b"y".to_vec(),
        };
        assert!(a.compatible_same_type(&a));
        assert_eq!(a.join_same_type(&a), Some(a.clone()));
    }
}
