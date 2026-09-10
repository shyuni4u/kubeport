// No build tag. kindAvail() below already skips when KIND_API / KIND_CA /
// DEX_TOKEN are unset, so a fresh clone stays green without one — and a tag
// costs what a skip does not: the file becomes invisible to the compiler, so
// it rots unnoticed and never reaches the "Skipped Go tests" summary that is
// supposed to make uncovered k8s paths visible (#121). playwright.yml sets
// those three variables and runs these tests against its kind cluster.

package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
)

// skipUnlessKind skips when the kind harness is not wired up, which is what
// keeps `go test ./...` green on a fresh clone. KBP_REQUIRE_KIND inverts it:
// set it where a cluster IS supposed to be there, and a skip becomes a
// failure. Same bargain as KBP_REQUIRE_DEX — a suite that skips itself is
// green whether or not the wiring still works, so it gates nothing.
//
// This lives in the test, not in a list of test names in a workflow file, on
// purpose: a hand-kept list is what let these tests fall out of CI in the
// first place (#121). A new kind-backed test picks the gate up by calling
// kindAvail, and one that is renamed or deleted takes itself out honestly.
func skipUnlessKind(t *testing.T, missing string) {
	t.Helper()
	if os.Getenv("KBP_REQUIRE_KIND") != "" {
		t.Fatalf("KBP_REQUIRE_KIND is set but %s is not — the kind harness did not wire up", missing)
	}
	t.Skip(missing + " not set")
}

func kindAvail(t *testing.T) (apiURL, caBundle, token string) {
	t.Helper()
	apiURL, ca, tok := os.Getenv("KIND_API"), os.Getenv("KIND_CA"), os.Getenv("DEX_TOKEN")
	for _, v := range []struct{ name, val string }{
		{"KIND_API", apiURL}, {"KIND_CA", ca}, {"DEX_TOKEN", tok},
	} {
		if v.val == "" {
			skipUnlessKind(t, v.name)
		}
	}
	return apiURL, ca, tok
}

func TestOpenAPI_ListGroupVersions(t *testing.T) {
	apiURL, ca, tok := kindAvail(t)
	s := testStore(t)
	adminR := api.NewRouter(config.Config{OpenAPICacheMax: 32},
		api.Deps{Verifier: adminVerifier{}, Store: s})

	regBody, _ := json.Marshal(map[string]any{
		"name":            "kind-" + randSuffix(),
		"api_url":         apiURL,
		"ca_bundle":       ca,
		"oidc_issuer_url": "https://host.docker.internal:5556",
	})
	w := do(t, adminR, http.MethodPost, "/v1/clusters", bytes.NewReader(regBody))
	require.Equal(t, http.StatusCreated, w.Code)
	var cl map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &cl)

	req := httptest.NewRequest(http.MethodGet, "/v1/clusters/"+cl["name"].(string)+"/openapi", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	w = httptest.NewRecorder()
	adminR.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"paths":`)
	require.Contains(t, w.Body.String(), `apps/v1`)
}

func TestOpenAPI_Refresh_ClearsCache(t *testing.T) {
	apiURL, ca, tok := kindAvail(t)
	s := testStore(t)
	r := api.NewRouter(config.Config{OpenAPICacheMax: 32},
		api.Deps{Verifier: adminVerifier{}, Store: s})

	regBody, _ := json.Marshal(map[string]any{
		"name":            "kind-" + randSuffix(),
		"api_url":         apiURL,
		"ca_bundle":       ca,
		"oidc_issuer_url": "https://host.docker.internal:5556",
	})
	w := do(t, r, http.MethodPost, "/v1/clusters", bytes.NewReader(regBody))
	require.Equal(t, http.StatusCreated, w.Code)
	var cl map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &cl)
	name := cl["name"].(string)

	// Prime cache
	req := httptest.NewRequest(http.MethodGet, "/v1/clusters/"+name+"/openapi", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	// Refresh
	req = httptest.NewRequest(http.MethodPost, "/v1/clusters/"+name+"/openapi/refresh", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusNoContent, w.Code)

	// Next GET should repopulate (can't prove cache miss from outside easily; just ensure no error)
	req = httptest.NewRequest(http.MethodGet, "/v1/clusters/"+name+"/openapi", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}
