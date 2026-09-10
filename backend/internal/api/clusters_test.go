package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/auth"
	"kubeport/internal/config"
	"kubeport/internal/store"
)

type adminVerifier struct{}

func (adminVerifier) Verify(_ context.Context, _ string) (auth.Claims, error) {
	return auth.Claims{Subject: "admin", Email: "admin@example.com", Groups: []string{"kubeport-admin"}}, nil
}

func testStore(t *testing.T) *store.Store {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable"
	}
	s, err := store.NewStore(context.Background(), dsn)
	require.NoError(t, err)
	t.Cleanup(s.Close)
	return s
}

func randSuffix() string {
	return time.Now().Format("150405.000000")
}

func TestClusters_Register_RequiresAdmin(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: testStore(t)})
	body := bytes.NewReader([]byte(`{"name":"dev-` + randSuffix() + `","api_url":"https://k","oidc_issuer_url":"http://localhost:5556"}`))
	req := httptest.NewRequest(http.MethodPost, "/v1/clusters", body)
	req.Header.Set("Authorization", "Bearer x")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusForbidden, w.Code)
}

func TestClusters_Register_AdminSucceeds(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
	name := "dev-" + randSuffix()
	payload, _ := json.Marshal(map[string]any{
		"name":            name,
		"api_url":         "https://k/" + name,
		"oidc_issuer_url": "http://localhost:5556",
		"ca_bundle":       testCAPEM(),
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/clusters", bytes.NewReader(payload))
	req.Header.Set("Authorization", "Bearer x")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())

	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.NotEmpty(t, got["id"])
}

// Registering without a usable CA is refused here rather than at the first
// deploy, where the reason would only be in the pod log and the UI would call
// it "cluster unreachable" (#96).
func TestClusters_Register_RequiresCABundle(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})

	for _, tc := range []struct{ name, ca string }{
		{"missing", ""},
		{"whitespace", "   "},
		{"not PEM", "fake-ca"},
		{"header only", "-----BEGIN CERTIFICATE-----"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload, _ := json.Marshal(map[string]any{
				"name":            "noca-" + randSuffix(),
				"api_url":         "https://k",
				"oidc_issuer_url": "http://localhost:5556",
				"ca_bundle":       tc.ca,
			})
			w := do(t, r, http.MethodPost, "/v1/clusters", bytes.NewReader(payload))
			require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
			require.Contains(t, w.Body.String(), "ca_bundle")
		})
	}
}

// Local kind clusters have no CA to register, and that is what the dev opt-out
// is for — the same one the k8s factory honours.
func TestClusters_Register_AllowsEmptyCAWhenOptedIn(t *testing.T) {
	t.Setenv("KBP_DEV_ALLOW_INSECURE_CLUSTERS", "true")
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})

	name := "kind-" + randSuffix()
	payload, _ := json.Marshal(map[string]any{
		"name":            name,
		"api_url":         "https://127.0.0.1:6443/" + name,
		"oidc_issuer_url": "http://localhost:5556",
	})
	w := do(t, r, http.MethodPost, "/v1/clusters", bytes.NewReader(payload))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
}

// #195: one apiserver under two names let a release under each share a name
// and namespace, and so each other's objects. The second registration is
// refused, however the URL is spelled, and says which cluster already has it.
func TestClusters_Register_SameAPIURLUnderAnotherNameReturns409(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
	host := "alias-" + time.Now().Format("150405000000") + ".example.com"
	first := "alias-a-" + randSuffix()
	register := func(name, apiURL string) *httptest.ResponseRecorder {
		payload, _ := json.Marshal(map[string]any{
			"name":            name,
			"api_url":         apiURL,
			"oidc_issuer_url": "http://localhost:5556",
			"ca_bundle":       testCAPEM(),
		})
		return do(t, r, http.MethodPost, "/v1/clusters", bytes.NewReader(payload))
	}

	w := register(first, "https://"+host+":6443")
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())

	for _, spelling := range []string{"https://" + host + ":6443", "https://" + host + ":6443/", "https://" + strings.ToUpper(host) + ":6443"} {
		w = register("alias-b-"+randSuffix(), spelling)
		require.Equal(t, http.StatusConflict, w.Code, "%s: %s", spelling, w.Body.String())
		title, detail := problemOf(t, w.Body.Bytes())
		require.Equal(t, "conflict", title)
		require.Contains(t, detail, strconv.Quote(first))
	}

	w = register("alias-c-"+randSuffix(), "https://"+host+":6444")
	require.Equal(t, http.StatusCreated, w.Code, "another port is another apiserver: %s", w.Body.String())
}

// Codex review: checked and then inserted, two registrations of one apiserver
// arriving together both passed the check. Under the registration lock exactly
// one of them wins.
func TestClusters_Register_ConcurrentRegistrationsOfOneAPIServerLetOneIn(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
	apiURL := "https://race-" + time.Now().Format("150405000000") + ".example.com:6443"
	const racers = 4

	start := make(chan struct{})
	codes := make([]int, racers)
	var wg sync.WaitGroup
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			payload, _ := json.Marshal(map[string]any{
				"name":            "race-" + strconv.Itoa(i) + "-" + randSuffix(),
				"api_url":         apiURL,
				"oidc_issuer_url": "http://localhost:5556",
				"ca_bundle":       testCAPEM(),
			})
			req := httptest.NewRequest(http.MethodPost, "/v1/clusters", bytes.NewReader(payload))
			req.Header.Set("Authorization", "Bearer x")
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			<-start
			r.ServeHTTP(w, req)
			codes[i] = w.Code
		}(i)
	}
	close(start)
	wg.Wait()

	sort.Ints(codes)
	require.Equal(t, []int{http.StatusCreated, http.StatusConflict, http.StatusConflict, http.StatusConflict}, codes)
}

func TestClusters_Register_DuplicateReturns409(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
	name := "dup-" + randSuffix()
	register := func(apiURL string) *httptest.ResponseRecorder {
		payload, _ := json.Marshal(map[string]any{
			"name":            name,
			"api_url":         apiURL,
			"oidc_issuer_url": "http://localhost:5556",
			"ca_bundle":       testCAPEM(),
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/clusters", bytes.NewReader(payload))
		req.Header.Set("Authorization", "Bearer x")
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w
	}

	w1 := register("https://k/" + name)
	require.Equal(t, http.StatusCreated, w1.Code, w1.Body.String())

	// The same name is refused whatever the URL, and as a name clash — also
	// when the URL matches too, the clearer of the two answers.
	for _, apiURL := range []string{"https://k/" + name, "https://other/" + name} {
		w2 := register(apiURL)
		require.Equal(t, http.StatusConflict, w2.Code, w2.Body.String())
		_, detail := problemOf(t, w2.Body.Bytes())
		require.Equal(t, "cluster name already exists", detail, apiURL)
	}
}
