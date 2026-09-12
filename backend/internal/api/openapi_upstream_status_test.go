package api_test

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
)

// fakeAPIServer stands in for a cluster's /openapi/v3 endpoint so the status
// mapping can be tested without a live cluster (openapi_proxy_test.go needs
// kind and is build-tagged out of the default run).
func fakeAPIServer(t *testing.T, status int, body string) (url, caPEM string) {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)

	cert := srv.Certificate()
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw})
	require.NotNil(t, pemBytes)
	// Sanity: the PEM we hand the proxy must be the one that signs the server.
	pool := x509.NewCertPool()
	require.True(t, pool.AppendCertsFromPEM(pemBytes))

	return srv.URL, string(pemBytes)
}

func seedClusterAt(t *testing.T, r http.Handler, apiURL, caPEM string) string {
	t.Helper()
	name := "upstream-" + randSuffix()
	body, _ := json.Marshal(map[string]any{
		"name":            name,
		"api_url":         apiURL,
		"oidc_issuer_url": "http://localhost:5556",
		"ca_bundle":       caPEM,
	})
	w := do(t, r, http.MethodPost, "/v1/clusters", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, "seed cluster: %s", w.Body.String())
	// apiURL is an httptest address, and the OS gives its port out again. Since
	// #245 a registered api_url refuses a second registration with 409, so the
	// row goes when this test ends — TestMain's sweep runs only after the whole
	// package, too late for the next test that draws the same port (#304).
	t.Cleanup(func() { deleteClusterRow(t, name) })
	return name
}

// deleteClusterRow removes a cluster a test registered, with any release on it.
func deleteClusterRow(t *testing.T, name string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, testDatabaseURL())
	if err != nil {
		t.Errorf("delete cluster %s: %v", name, err)
		return
	}
	defer conn.Close(ctx)
	for _, q := range []string{
		`DELETE FROM releases WHERE cluster_id IN (SELECT id FROM clusters WHERE name = $1)`,
		`DELETE FROM clusters WHERE name = $1`,
	} {
		if _, err := conn.Exec(ctx, q, name); err != nil {
			t.Errorf("delete cluster %s: %v", name, err)
			return
		}
	}
}

func upstreamRouter(t *testing.T, status int, body string) (http.Handler, string) {
	t.Helper()
	upstream, ca := fakeAPIServer(t, status, body)
	r := api.NewRouter(config.Config{OpenAPICacheMax: 8},
		api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
	return r, seedClusterAt(t, r, upstream, ca)
}

func getOpenAPI(t *testing.T, r http.Handler, cluster, gv string) *httptest.ResponseRecorder {
	t.Helper()
	return do(t, r, http.MethodGet, "/v1/clusters/"+cluster+"/openapi/"+gv, nil)
}

// A cluster that rejects the forwarded token is not kubeport rejecting the
// session, but the proxy used to pass the upstream status through verbatim.
// A client that sees 401 re-authenticates against kubeport, gets a fresh and
// equally unwelcome token, and loops (issue #83). PR #79 made "401 on /v1
// means unauthenticated" an invariant; these two routes were the exception.
func TestOpenAPIProxy_UpstreamUnauthorizedBecomes502(t *testing.T) {
	r, cluster := upstreamRouter(t, http.StatusUnauthorized, `{"message":"Unauthorized"}`)

	w := getOpenAPI(t, r, cluster, "apps/v1")

	require.Equal(t, http.StatusBadGateway, w.Code)
	p := decodeProblem(t, w)
	require.Equal(t, "cluster-auth-denied", p["title"],
		"a cluster-side auth failure needs its own kind, or it is indistinguishable from a kubeport session failure")
}

func TestOpenAPIProxy_UpstreamForbiddenBecomes502(t *testing.T) {
	r, cluster := upstreamRouter(t, http.StatusForbidden, `{"message":"forbidden"}`)

	w := getOpenAPI(t, r, cluster, "apps/v1")

	require.Equal(t, http.StatusBadGateway, w.Code)
	require.Equal(t, "cluster-auth-denied", decodeProblem(t, w)["title"])
}

// 404 stays a 404: "this cluster has no apps/v99" is the apiserver answering
// the caller's actual question, and the editor's kind autocomplete depends on
// telling that apart from a transport failure.
func TestOpenAPIProxy_UpstreamNotFoundStaysNotFound(t *testing.T) {
	r, cluster := upstreamRouter(t, http.StatusNotFound, "404 page not found")

	w := getOpenAPI(t, r, cluster, "apps/v99")

	require.Equal(t, http.StatusNotFound, w.Code)
	require.Equal(t, "k8s-error", decodeProblem(t, w)["title"])
}

// Any other upstream 4xx is folded into 502. A passed-through 429 was the
// worst of them: it collides with kubeport's own rate limiter, whose 429
// carries Retry-After, so a client would wait on a header that is not there.
func TestOpenAPIProxy_OtherUpstream4xxFoldsInto502(t *testing.T) {
	r, cluster := upstreamRouter(t, http.StatusTooManyRequests, `{"message":"slow down"}`)

	w := getOpenAPI(t, r, cluster, "apps/v1")

	require.Equal(t, http.StatusBadGateway, w.Code)
	require.Equal(t, "k8s-error", decodeProblem(t, w)["title"])
	require.Empty(t, w.Header().Get("Retry-After"),
		"kubeport's own 429 owns Retry-After; an upstream 429 must not borrow it")
}

// The 4xx we do pass through carries the apiserver's own words. Ten megabytes
// of them is not a Problem detail, it is a payload — the read cap exists for
// the success path, not for an error string.
func TestOpenAPIProxy_PassedThroughDetailIsBounded(t *testing.T) {
	huge := strings.Repeat("x", 4096)
	r, cluster := upstreamRouter(t, http.StatusNotFound, huge)

	w := getOpenAPI(t, r, cluster, "apps/v99")

	require.Equal(t, http.StatusNotFound, w.Code)
	detail, _ := decodeProblem(t, w)["detail"].(string)
	require.LessOrEqual(t, len(detail), 600, "upstream 4xx body should be truncated into the detail")
	require.NotEmpty(t, detail)
}
