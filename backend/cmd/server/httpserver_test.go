package main

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

// The server used to start with gin's r.Run, which is a zero-value http.Server:
// no timeout of any kind. Headers could trickle in for as long as a client
// liked, holding a connection per attempt (#169).
//
// The obvious fix is also the dangerous one. This process serves long-lived
// Server-Sent Events, and two of http.Server's timeouts are measured against
// the whole request, not its idle time: WriteTimeout would cut every log stream
// at that age mid-flight, and ReadTimeout's deadline stays on the connection
// while the handler runs, so the server's background read fails when it
// expires and cancels the request context — ending the stream just the same.
// So the header phase is bounded, idle keep-alive sockets are bounded, and the
// two whole-request timeouts are deliberately left at zero.
func TestHTTPServer_BoundsTheHandshakeButNotTheStream(t *testing.T) {
	srv := newHTTPServer(":0", http.NewServeMux())

	require.Equal(t, ":0", srv.Addr)
	require.NotNil(t, srv.Handler)

	require.NotZero(t, srv.ReadHeaderTimeout,
		"without it a client can hold a connection open by sending headers one byte at a time")
	require.NotZero(t, srv.IdleTimeout,
		"idle keep-alive sockets should not be held forever")

	require.Zero(t, srv.WriteTimeout,
		"a WriteTimeout ends every SSE log stream once it is that old")
	require.Zero(t, srv.ReadTimeout,
		"a ReadTimeout cancels the request context of a long-lived stream when it expires")
}
