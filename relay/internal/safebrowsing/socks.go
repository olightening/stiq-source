package safebrowsing

import (
	"context"
	"errors"
	"io"
	"net"
	"strconv"
	"time"
)

// handshakeTimeout bounds the whole SOCKS negotiation (greeting + CONNECT + reply). The net.Dialer
// timeout below only covers the TCP connect to the proxy, NOT the subsequent blocking handshake
// reads. Without this deadline a proxy that accepts the TCP connection but stalls mid-handshake
// would leave the DialContext goroutine parked in a deadline-less io.ReadFull forever — Go's
// Transport does not reclaim an in-flight custom dial on request cancellation — leaking one
// goroutine + one FD per triggered lookup under load. (finding #35)
const handshakeTimeout = 10 * time.Second

// socksDialer returns an http.Transport DialContext that tunnels TCP through a no-auth SOCKS5
// proxy (Tor). It uses domain-name ATYP so the hostname is resolved at the proxy — no local DNS
// leak — which is how the relay reaches Google without exposing the box's clearnet identity.
func socksDialer(proxyAddr string) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, _ string, addr string) (net.Conn, error) {
		host, portStr, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		port, err := strconv.Atoi(portStr)
		if err != nil || port < 0 || port > 65535 {
			return nil, errors.New("safebrowsing: bad target port")
		}
		d := net.Dialer{Timeout: 10 * time.Second}
		conn, err := d.DialContext(ctx, "tcp", proxyAddr)
		if err != nil {
			return nil, err
		}
		// Close the conn if the caller's context is cancelled during the handshake (e.g. the HTTP
		// layer's request timeout fires), so a stalled proxy can't hold the socket open. The deadline
		// below is the primary bound; this makes cancellation prompt.
		handshakeDone := make(chan struct{})
		go func() {
			select {
			case <-ctx.Done():
				_ = conn.Close()
			case <-handshakeDone:
			}
		}()
		err = socksHandshake(conn, host, port)
		close(handshakeDone)
		if err != nil {
			conn.Close()
			return nil, err
		}
		return conn, nil
	}
}

func socksHandshake(conn net.Conn, host string, port int) error {
	// Bound the blocking Write/ReadFull calls below; cleared on success so the returned conn carries
	// no lingering deadline into the HTTP request that follows.
	if err := conn.SetDeadline(time.Now().Add(handshakeTimeout)); err != nil {
		return err
	}
	defer func() { _ = conn.SetDeadline(time.Time{}) }()
	if len(host) > 255 {
		return errors.New("safebrowsing: host too long")
	}
	// Greeting: VER=5, NMETHODS=1, METHOD=0 (no auth).
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		return err
	}
	resp := make([]byte, 2)
	if _, err := io.ReadFull(conn, resp); err != nil {
		return err
	}
	if resp[0] != 0x05 || resp[1] != 0x00 {
		return errors.New("safebrowsing: socks no-auth rejected")
	}
	// CONNECT: VER=5, CMD=1, RSV=0, ATYP=3 (domain), len, host, port(2 BE).
	req := []byte{0x05, 0x01, 0x00, 0x03, byte(len(host))}
	req = append(req, host...)
	req = append(req, byte(port>>8), byte(port&0xff))
	if _, err := conn.Write(req); err != nil {
		return err
	}
	// Reply: VER, REP, RSV, ATYP, BND.ADDR, BND.PORT.
	head := make([]byte, 4)
	if _, err := io.ReadFull(conn, head); err != nil {
		return err
	}
	if head[1] != 0x00 {
		return errors.New("safebrowsing: socks connect failed")
	}
	var addrLen int
	switch head[3] {
	case 0x01:
		addrLen = 4
	case 0x04:
		addrLen = 16
	case 0x03:
		l := make([]byte, 1)
		if _, err := io.ReadFull(conn, l); err != nil {
			return err
		}
		addrLen = int(l[0])
	default:
		return errors.New("safebrowsing: bad socks atyp")
	}
	// Consume BND.ADDR + BND.PORT(2).
	if _, err := io.ReadFull(conn, make([]byte, addrLen+2)); err != nil {
		return err
	}
	return nil
}
