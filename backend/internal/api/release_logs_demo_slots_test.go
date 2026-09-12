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
	"kubeport/internal/config"
	"kubeport/internal/k8s"
)

// Issue #200. The cap on log streams held open is per caller, and a demo
// account is one caller for every visitor: one sign-in holding all sixteen left
// the log tab refusing everybody else signed in to that account. Each sign-in
// to a demo account now has a cap of its own, below the account's.

// demoLogsRouter seeds a release deployed by the demo admin and returns a router
// signed in as that account, and the release's logs path.
func demoLogsRouter(t *testing.T, applier *fakeK8sApplier) (http.Handler, string) {
	t.Helper()
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	clusterName := seedCluster(t, adminRouter)
	tpl := seedDemoTemplate(t, s)
	r := newDemoAdminRouter(t, s, applier)
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

func TestStreamReleaseLogs_OneDemoSignInCannotTakeTheAccountsStreams(t *testing.T) {
	started := make(chan struct{}, 1)
	applier := &fakeK8sApplier{instances: []k8s.Instance{{Name: "web-1"}}, streamStarted: started}
	r, path := demoLogsRouter(t, applier)

	var stops []func()
	defer func() {
		for _, stop := range stops {
			stop()
		}
	}()
	for range 4 {
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
	r, path := demoLogsRouter(t, applier)

	var stops []func()
	for range 4 {
		stops = append(stops, holdStreamAs(t, r, path, "visitor-a", started))
	}
	require.Equal(t, http.StatusTooManyRequests, openAs(r, path, "visitor-a").Code)

	stops[0]()
	stops = append(stops[1:], holdStreamAs(t, r, path, "visitor-a", started))
	for _, stop := range stops {
		stop()
	}
}

// Outside the demo a caller is one person, and their cap is the only one.
func TestStreamReleaseLogs_OnlyDemoAccountsHaveAPerSignInCap(t *testing.T) {
	started := make(chan struct{}, 1)
	applier := &fakeK8sApplier{instances: []k8s.Instance{{Name: "web-1"}}, streamStarted: started}
	r, path, _ := slotRouter(t, 0, applier)

	var stops []func()
	for range 5 {
		stops = append(stops, holdStreamAs(t, r, path, "x", started))
	}
	for _, stop := range stops {
		stop()
	}
}
