package api_test

import (
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"kubeport/internal/k8s"
)

// A reader can leave without closing: a laptop lid shuts, a phone drops off the
// network. No FIN arrives, so the server's background read never sees EOF and
// gin's CloseNotify never fires. The only thing that ever notices is a write
// failing, once the kernel gives up retransmitting — and if that failure did
// not end the handler, its slot would stay taken for as long as the lifetime
// allows, and after the browser-less reconnect that never comes, for good
// (#169).
//
// httptest.ResponseRecorder cannot fail a write, so this runs a real
// http.Server over a listener whose connections can be made to.

// vanishingListener hands out connections whose writes start failing on
// demand, the way a socket to a peer that silently went away does. Reads are
// left alone: the client in the test simply stops talking, which is all the
// server can see of a vanished peer.
type vanishingListener struct {
	net.Listener
	mu    sync.Mutex
	conns []*vanishingConn
}

func (l *vanishingListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	vc := &vanishingConn{Conn: c, gone: make(chan struct{})}
	l.mu.Lock()
	l.conns = append(l.conns, vc)
	l.mu.Unlock()
	return vc, nil
}

func (l *vanishingListener) vanish() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, c := range l.conns {
		c.once.Do(func() { close(c.gone) })
	}
}

type vanishingConn struct {
	net.Conn
	once sync.Once
	gone chan struct{}
}

var errPeerVanished = errors.New("peer vanished: retransmission gave up")

func (c *vanishingConn) Write(p []byte) (int, error) {
	select {
	case <-c.gone:
		return 0, errPeerVanished
	default:
		return c.Conn.Write(p)
	}
}

func TestStreamReleaseLogs_AReaderThatVanishesWithoutClosingGivesItsSlotBack(t *testing.T) {
	started := make(chan struct{}, 1)
	feed := make(chan string)
	applier := &fakeK8sApplier{
		instances:     []k8s.Instance{{Name: "web-1"}},
		streamStarted: started,
		logFeed:       feed,
	}
	r, path, _ := slotRouter(t, 1, applier)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	vl := &vanishingListener{Listener: ln}
	srv := &http.Server{Handler: r, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(vl) }()
	t.Cleanup(func() { _ = srv.Close() })

	conn, err := net.Dial("tcp", ln.Addr().String())
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	_, err = io.WriteString(conn,
		"GET "+path+" HTTP/1.1\r\nHost: kubeport\r\nAuthorization: Bearer x\r\n\r\n")
	require.NoError(t, err)

	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("the stream never started")
	}

	// The peer is gone. The next thing the handler writes fails.
	vl.vanish()
	select {
	case feed <- "written to a socket nobody is reading":
	case <-time.After(5 * time.Second):
		t.Fatal("the handler stopped taking lines before its reader vanished")
	}

	// The handler returning is what lets the server close the connection, and
	// its deferred release runs before that — so EOF here means the slot is back.
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(5*time.Second)))
	_, err = io.Copy(io.Discard, conn)
	require.NoError(t, err,
		"a stream whose writes were failing was still open — a vanished reader keeps its slot")

	stop := holdStream(t, r, path, started)
	stop()
}
