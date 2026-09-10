package api_test

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"kubeport/internal/config"
	"kubeport/internal/k8s"
)

// A reader that keeps the connection open but stops reading is the case the
// lifetime alone cannot end. The socket buffers fill, the handler's next write
// blocks inside the kernel, and a blocked write never returns to the select
// that would notice the lifetime is up — cancelling the context does not
// interrupt a write, and the server has no WriteTimeout on purpose. The slot
// would stay taken for as long as the client liked (#169, found by codex).

// streamOpens reports whether a stream can be opened right now: true once the
// handler starts streaming, false if it is refused or does not start within a
// second. The probe stream is ended before returning.
func streamOpens(r http.Handler, path string, started <-chan struct{}) bool {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		req := httptest.NewRequest(http.MethodGet, path, nil).WithContext(ctx)
		req.Header.Set("Authorization", "Bearer x")
		r.ServeHTTP(newStreamRecorder(), req)
	}()
	select {
	case <-started:
		return true
	case <-done:
		return false
	case <-time.After(time.Second):
		return false
	}
}

func TestStreamReleaseLogs_AReaderThatStopsReadingIsCutAtItsLifetime(t *testing.T) {
	const lifetime = 3 * time.Second
	started := make(chan struct{}, 1)
	feed := make(chan string)
	applier := &fakeK8sApplier{
		instances:     []k8s.Instance{{Name: "web-1"}},
		streamStarted: started,
		logFeed:       feed,
	}
	r, path := lifetimeRouter(t, config.Config{
		LogStreamsPerCaller:  1,
		LogStreamMaxLifetime: lifetime,
	}, applier)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	srv := &http.Server{Handler: r, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })

	conn, err := net.Dial("tcp", ln.Addr().String())
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	_, err = io.WriteString(conn,
		"GET "+path+" HTTP/1.1\r\nHost: kubeport\r\nAuthorization: Bearer x\r\n\r\n")
	require.NoError(t, err)
	// ...and never read from conn again.

	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("the stream never started")
	}
	opened := time.Now()

	// Push lines until one no longer goes through. The feed is unbuffered and
	// the fake hands each line straight to the handler, so a send that stalls
	// means the handler is stuck writing the previous one.
	big := strings.Repeat("x", 256<<10)
	var blockedAt time.Time
fill:
	for time.Since(opened) < lifetime {
		select {
		case feed <- big:
		case <-time.After(200 * time.Millisecond):
			blockedAt = time.Now()
			break fill
		}
	}
	// If the handler was not blocked well before the lifetime, it would end by
	// the ordinary context path and this test would pass without proving
	// anything about blocked writes.
	require.False(t, blockedAt.IsZero(), "the socket buffers never filled")
	require.Less(t, blockedAt.Sub(opened), lifetime-time.Second,
		"the handler blocked too close to its lifetime to tell the two paths apart")

	require.Eventually(t, func() bool { return streamOpens(r, path, started) },
		lifetime+5*time.Second, 250*time.Millisecond,
		"a handler stuck writing to a reader that stopped reading kept its slot past the lifetime")
}
