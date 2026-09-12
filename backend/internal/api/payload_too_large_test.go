package api_test

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// The cap limitBodySize enforces. Mirrored rather than exported: the number is
// part of the documented contract (openapi.yaml, docs/machine-clients.md), so a
// change to it should have to touch this test as well.
const bodyCap = 4 << 20

// jsonBodyOfSize is a syntactically valid JSON object exactly n bytes long, so
// the only thing wrong with an oversized one is its size.
func jsonBodyOfSize(n int) []byte {
	const head, tail = `{"name":"`, `"}`
	return []byte(head + strings.Repeat("a", n-len(head)-len(tail)) + tail)
}

// unknownLength sends body the way a chunked upload arrives: no Content-Length,
// so the early check in limitBodySize cannot see it and the overflow has to be
// caught where the handler reads.
func unknownLength(req *http.Request, body []byte) {
	req.Body = io.NopCloser(struct{ io.Reader }{bytes.NewReader(body)})
	req.ContentLength = -1
	req.Header.Del("Content-Length")
}

func sendBody(r http.Handler, method, path string, body []byte, knownLength bool) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer x")
	req.Header.Set("Content-Type", "application/json")
	if !knownLength {
		unknownLength(req, body)
	}
	return serve(r, req)
}

func requirePayloadTooLarge(t *testing.T, w *httptest.ResponseRecorder, what string) {
	t.Helper()
	require.Equal(t, http.StatusRequestEntityTooLarge, w.Code, "%s: %s", what, w.Body.String())
	require.Contains(t, w.Header().Get("Content-Type"), "application/json", what)
	p := problemShape(t, w.Body.String())
	require.Equal(t, "payload-too-large", p.Title, what)
	require.Equal(t, "https://kubeport.io/errors/payload-too-large", p.Type, what)
	require.Equal(t, http.StatusRequestEntityTooLarge, p.Status, what)
	require.Equal(t, "request body exceeds 4 MiB", p.Detail, what)
	require.NotContains(t, w.Body.String(), "http: request body too large", what)
	require.Contains(t, w.Body.String(), `"request_id":"`, what)
}

// Issue #128: the overflow used to surface in ShouldBindJSON and go out as
// `400 validation-error` with Go's own "http: request body too large" as the
// detail, so a client could not tell "fix the body" from "the body is too big
// to send at all" without matching English prose the contract says may change.
//
// Every route that reads a body is listed, and each is exercised with a body
// whose length is unknown up front — the path that the Content-Length check
// cannot short-circuit, so it proves the handler's own read answers 413.
func TestPayloadTooLarge_EveryBodyReadingRoute(t *testing.T) {
	r := newTestRouterAdmin(t)
	tpl := seedGlobalTemplate(t, r) // version 1 is a draft
	team := createTeam(t, r, "payload-"+randSuffix())
	const someRelease = "00000000-0000-4000-8000-000000000128"

	routes := []struct{ method, path string }{
		{http.MethodPost, "/v1/clusters"},
		{http.MethodPost, "/v1/selfsubjectaccessreview"},
		{http.MethodPost, "/v1/templates"},
		{http.MethodPost, "/v1/templates/preview"},
		{http.MethodPost, "/v1/templates/" + tpl + "/render"},
		{http.MethodPatch, "/v1/templates/" + tpl},
		{http.MethodPost, "/v1/templates/" + tpl + "/versions"},
		{http.MethodPatch, "/v1/templates/" + tpl + "/versions/1"},
		{http.MethodPost, "/v1/releases"},
		{http.MethodPut, "/v1/releases/" + someRelease},
		{http.MethodPost, "/v1/teams"},
		{http.MethodPost, "/v1/teams/" + team + "/members"},
	}
	over := jsonBodyOfSize(bodyCap + 1)
	for _, rt := range routes {
		for _, known := range []bool{true, false} {
			what := rt.method + " " + rt.path
			if known {
				what += " (Content-Length)"
			} else {
				what += " (unknown length)"
			}
			requirePayloadTooLarge(t, sendBody(r, rt.method, rt.path, over, known), what)
		}
	}
}

// The cap is inclusive: a body of exactly 4 MiB is read and judged on its
// content, whichever way its length arrives.
func TestPayloadTooLarge_BodyAtTheCapIsReadNormally(t *testing.T) {
	r := newTestRouterAdmin(t)
	at := jsonBodyOfSize(bodyCap)
	for _, known := range []bool{true, false} {
		w := sendBody(r, http.MethodPost, "/v1/templates", at, known)
		require.Equal(t, http.StatusBadRequest, w.Code, "known=%v: %s", known, w.Body.String())
		require.Equal(t, "validation-error", problemShape(t, w.Body.String()).Title, "known=%v", known)
	}
}

// A declared Content-Length over the cap is refused before routing, auth or
// any handler runs — on any method, including one whose handler never reads a
// body. The request announced more than any request may carry; answering it
// on its merits would mean holding the connection open for bytes kubeport has
// already decided not to read. It gives an unauthenticated caller nothing: the
// cap is the same on every path and is published in the spec.
func TestPayloadTooLarge_DeclaredLengthIsRefusedUpFront(t *testing.T) {
	r := newTestRouterAdmin(t)

	get := newAuthedRequest(http.MethodGet, "/v1/templates")
	get.ContentLength = bodyCap + 1
	requirePayloadTooLarge(t, serve(r, get), "GET with an oversized Content-Length")

	anon := httptest.NewRequest(http.MethodPost, "/v1/templates", bytes.NewReader(jsonBodyOfSize(bodyCap+1)))
	requirePayloadTooLarge(t, serve(r, anon), "unauthenticated POST")

	// The ordinary case is untouched: a GET with no body still answers.
	w := do(t, r, http.MethodGet, "/v1/templates", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
}

// The 413 is only as central as the rule that nothing reads a request body
// except through bindJSON. A handler that calls ShouldBindJSON (or reads
// c.Request.Body) directly would put Go's "http: request body too large" back
// into a 400 validation-error — the bug #128 fixed.
func TestPayloadTooLarge_BodiesAreReadOnlyThroughTheHelper(t *testing.T) {
	files, err := filepath.Glob("*.go")
	require.NoError(t, err)

	const home = "ratelimit.go" // limitBodySize and bindJSON
	reads := regexp.MustCompile(`\.(?:ShouldBind\w*|Bind\w*|MustBindWith|GetRawData|FormFile|MultipartForm|PostForm\w*)\(|Request\.Body`)
	var found int
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		for _, m := range reads.FindAllString(readSourceFile(t, f), -1) {
			if f == home {
				found++
				continue
			}
			t.Errorf("%s reads the request body with %q — use bindJSON so an oversized body answers 413", f, m)
		}
	}
	require.Greater(t, found, 0, "%s no longer reads the body — the regex or the helper moved", home)
}
