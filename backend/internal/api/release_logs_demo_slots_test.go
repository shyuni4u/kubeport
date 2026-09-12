package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/auth"
	"kubeport/internal/config"
	"kubeport/internal/k8s"
)

// Issue #200. The cap on log streams held open is per caller, and a demo
// account is one caller for every visitor: one sign-in holding all sixteen left
// the log tab refusing everybody else signed in to that account. Each sign-in
// to a demo account now has a cap of its own, below the account's.

// demoCapPerSignIn mirrors api.demoLogStreamsPerLogin.
const demoCapPerSignIn = 8

// logsRouterFor seeds a release deployed by the caller verifier signs in, on an
// install with demo mode on, and returns a router for that caller and the
// release's logs path. demoTemplate picks a template on the demo's side of the
// line, which a demo account needs and a real user may not deploy.
func logsRouterFor(t *testing.T, verifier api.TokenVerifier, demoTemplate bool, applier *fakeK8sApplier) (http.Handler, string) {
	t.Helper()
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	clusterName := seedCluster(t, adminRouter)
	var tpl string
	if demoTemplate {
		tpl = seedDemoTemplate(t, s)
	} else {
		tpl = seedPublishedTemplate(t, adminRouter)
	}
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier:        verifier,
		Store:           s,
		K8sFactory:      &fakeK8sFactory{applier: applier},
		DemoEmailDomain: demoDomain,
	})
	w := do(t, r, http.MethodPost, "/v1/releases", deployBody(t, tpl, clusterName, "logs-"+randSuffix()))
	require.Equal(t, http.StatusCreated, w.Code, "seed release: %s", w.Body.String())
	var created map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	return r, "/v1/releases/" + created["id"].(string) + "/logs"
}

// holdStreamAs is holdStream for the sign-in that presented token.
func holdStreamAs(t *testing.T, r http.Handler, path, token string, started <-chan struct{}) (stop func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		req := httptest.NewRequest(http.MethodGet, path, nil).WithContext(ctx)
		req.Header.Set("Authorization", "Bearer "+token)
		r.ServeHTTP(newStreamRecorder(), req)
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("the held stream never started")
	}
	return func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("the held stream did not end after its context was cancelled")
		}
	}
}

func openAs(r http.Handler, path, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func stopAll(stops []func()) {
	for _, stop := range stops {
		stop()
	}
}

func TestStreamReleaseLogs_OneDemoSignInCannotTakeTheAccountsStreams(t *testing.T) {
	started := make(chan struct{}, 1)
	applier := &fakeK8sApplier{instances: []k8s.Instance{{Name: "web-1"}}, streamStarted: started}
	r, path := logsRouterFor(t, demoVerifier{email: "demo-admin@" + demoDomain}, true, applier)

	var stops []func()
	defer func() { stopAll(stops) }()
	for range demoCapPerSignIn {
		stops = append(stops, holdStreamAs(t, r, path, "visitor-a", started))
	}

	rec := openAs(r, path, "visitor-a")
	require.Equal(t, http.StatusTooManyRequests, rec.Code, "body: %s", rec.Body.String())
	var p map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &p))
	require.Equal(t, "too-many-streams", p["title"])
	require.NotEmpty(t, rec.Header().Get("Retry-After"))

	// Another visitor signed in to the same account still gets a stream.
	stops = append(stops, holdStreamAs(t, r, path, "visitor-b", started))
}

// A refusal at the sign-in's cap gives nothing back it did not take, and
// closing one of that sign-in's streams makes room again.
func TestStreamReleaseLogs_ADemoSignInsSlotComesBackWhenItsStreamEnds(t *testing.T) {
	started := make(chan struct{}, 1)
	applier := &fakeK8sApplier{instances: []k8s.Instance{{Name: "web-1"}}, streamStarted: started}
	r, path := logsRouterFor(t, demoVerifier{email: "demo-admin@" + demoDomain}, true, applier)

	var stops []func()
	for range demoCapPerSignIn {
		stops = append(stops, holdStreamAs(t, r, path, "visitor-a", started))
	}
	require.Equal(t, http.StatusTooManyRequests, openAs(r, path, "visitor-a").Code)

	stops[0]()
	stops = append(stops[1:], holdStreamAs(t, r, path, "visitor-a", started))
	stopAll(stops)
}

// Security review: on an install with demo mode on, a real user signed in
// alongside the demo accounts is one person, and their cap is the only one.
func TestStreamReleaseLogs_ARealUserUnderDemoModeHasNoPerSignInCap(t *testing.T) {
	started := make(chan struct{}, 1)
	applier := &fakeK8sApplier{instances: []k8s.Instance{{Name: "web-1"}}, streamStarted: started}
	suffix := randSuffix()
	real := customVerifier{claims: auth.Claims{Subject: "real-" + suffix, Email: "real-" + suffix + "@example.com"}}
	r, path := logsRouterFor(t, real, false, applier)

	var stops []func()
	defer func() { stopAll(stops) }()
	for range demoCapPerSignIn + 1 {
		stops = append(stops, holdStreamAs(t, r, path, "x", started))
	}
}

// Security review: which accounts are demo accounts does not turn on how the
// address is capitalised.
func TestStreamReleaseLogs_TheDemoCapIgnoresTheEmailsCase(t *testing.T) {
	started := make(chan struct{}, 1)
	applier := &fakeK8sApplier{instances: []k8s.Instance{{Name: "web-1"}}, streamStarted: started}
	r, path := logsRouterFor(t, demoVerifier{email: "Demo-Admin@DEMO.KUBEPORT"}, true, applier)

	var stops []func()
	defer func() { stopAll(stops) }()
	for range demoCapPerSignIn {
		stops = append(stops, holdStreamAs(t, r, path, "visitor-a", started))
	}
	require.Equal(t, http.StatusTooManyRequests, openAs(r, path, "visitor-a").Code)
}
