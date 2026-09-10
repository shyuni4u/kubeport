package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
	"kubeport/internal/k8s"
	"kubeport/internal/store"
)

// fakeK8sApplier records calls for test assertions.
type fakeK8sApplier struct {
	applied   [][]byte
	deleted   []string
	instances []k8s.Instance

	// instancesErr / deleteErr inject failures into the matching call when
	// non-nil. Plan 8 needs the "cluster reachable but list failed" and
	// "k8s delete failed" branches under test.
	instancesErr error
	deleteErr    error

	// logStreamErr makes StreamLogs fail the way a single-pod stream fails for
	// real: the error goes to errCh, then both channels close because the pod
	// goroutine has returned. That ordering is what ends the SSE loop.
	logStreamErr error

	// logLines makes StreamLogs emit these and then close, which is what a pod
	// that has finished does — a completed Job, a container that exited. The
	// zero-value behaviour below (block until the client leaves) cannot express
	// that, so nothing could test what the server does when a stream ends on
	// its own rather than because the reader closed the tab (#162).
	logLines []string

	// logLineAt is the emission time StreamPodLogs would have read off the
	// kubelet's timestamp prefix. Zero means "the line carried no usable
	// stamp", which is the branch that falls back to the server's clock.
	// logLineAts gives each line its own time instead, for the boundary cases
	// around a resume point; it wins over logLineAt when set.
	logLineAt  time.Time
	logLineAts []time.Time

	// sinceSeen records the resume point the handler passed down, so a test can
	// tell "asked the cluster for a window" from "asked for everything". nil
	// means StreamLogs was called with a zero time.
	sinceSeen *time.Time

	// streamStarted, when set, receives a value as soon as StreamLogs is called
	// — that is, once the handler has passed every check and is committed to
	// streaming. A test holding one stream open waits on it before sending the
	// next request; without it the second request races the first to the slot.
	// Buffered by the test; a full channel is skipped rather than blocked on.
	streamStarted chan struct{}

	// logFeed, when set, makes StreamLogs a pod that is still running and writes
	// whatever the test sends it: each value is one line, and the stream stays
	// open until the client leaves. It lets a test make the handler write at a
	// moment of its choosing instead of waiting out the 15s ping.
	logFeed chan string

	// instancesStall makes ListInstances hang until its context ends, like an
	// apiserver that accepted the connection and never answered.
	instancesStall bool

	// accessChecks records every CheckAccess call for assertions.
	// accessResult is the stub response; accessErr overrides it when non-nil.
	accessChecks []k8s.AccessCheck
	accessResult k8s.AccessResult
	accessErr    error

	// applyCheck is what CheckApply reports; applyCheckErr overrides it.
	// checkedReleases records the release each call was made for, so a test
	// can assert the check ran, or that a request refused earlier never
	// reached it.
	applyCheck      k8s.ApplyCheck
	applyCheckErr   error
	checkedReleases []string
	checkedUIDs     []string
	checkedCreating []bool

	// deleteCalls records each DeleteByRelease's release id and whether the
	// release was NameOnly (#195).
	deleteCalls []deleteCall

	// presence is what ReleasePresence reports once ListInstances has found no
	// pods; presenceErr is returned alongside it. The zero value is
	// PresenceUnknown.
	presence    k8s.Presence
	presenceErr error
}

func (f *fakeK8sApplier) ReleasePresence(context.Context, k8s.ReleaseRef, []byte) (k8s.Presence, error) {
	return f.presence, f.presenceErr
}

func (f *fakeK8sApplier) CheckApply(_ context.Context, ref k8s.ReleaseRef, _ []byte, creating bool) (k8s.ApplyCheck, error) {
	f.checkedReleases = append(f.checkedReleases, ref.Name)
	f.checkedUIDs = append(f.checkedUIDs, ref.UID)
	f.checkedCreating = append(f.checkedCreating, creating)
	if f.applyCheckErr != nil {
		return k8s.ApplyCheck{}, f.applyCheckErr
	}
	return f.applyCheck, nil
}

func (f *fakeK8sApplier) ApplyAll(_ context.Context, _ string, y []byte) error {
	f.applied = append(f.applied, y)
	return nil
}

type deleteCall struct {
	UID      string
	NameOnly bool
}

func (f *fakeK8sApplier) DeleteByRelease(_ context.Context, ref k8s.ReleaseRef) error {
	f.deleteCalls = append(f.deleteCalls, deleteCall{UID: ref.UID, NameOnly: ref.NameOnly})
	if f.deleteErr != nil {
		return f.deleteErr
	}
	f.deleted = append(f.deleted, ref.Name)
	return nil
}

func (f *fakeK8sApplier) ListInstances(ctx context.Context, _ k8s.ReleaseRef) ([]k8s.Instance, error) {
	if f.instancesStall {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if f.instancesErr != nil {
		return nil, f.instancesErr
	}
	return f.instances, nil
}

func (f *fakeK8sApplier) StreamLogs(ctx context.Context, _ string, _ []string, since time.Time) (<-chan k8s.LogLine, <-chan error) {
	if !since.IsZero() {
		s := since
		f.sinceSeen = &s
	}
	if f.streamStarted != nil {
		select {
		case f.streamStarted <- struct{}{}:
		default:
		}
	}
	ch := make(chan k8s.LogLine)
	errCh := make(chan error, 1)
	if f.logStreamErr != nil {
		errCh <- f.logStreamErr
		close(ch)
		close(errCh)
		return ch, errCh
	}
	go func() {
		defer close(ch)
		defer close(errCh)
		if f.logFeed != nil {
			for {
				select {
				case <-ctx.Done():
					return
				case text := <-f.logFeed:
					select {
					case <-ctx.Done():
						return
					case ch <- k8s.LogLine{Pod: "web-7d9f8-x2k4l", Text: text}:
					}
				}
			}
		}
		for i, text := range f.logLines {
			at := f.logLineAt
			if i < len(f.logLineAts) {
				at = f.logLineAts[i]
			}
			select {
			case <-ctx.Done():
				return
			case ch <- k8s.LogLine{Pod: "web-7d9f8-x2k4l", Text: text, At: at}:
			}
		}
		if len(f.logLines) > 0 {
			// The pod is done. Closing here is the point: it is the only way to
			// reach the handler's terminal branch without the client hanging up.
			return
		}
		<-ctx.Done()
	}()
	return ch, errCh
}

func (f *fakeK8sApplier) CheckAccess(_ context.Context, spec k8s.AccessCheck) (k8s.AccessResult, error) {
	f.accessChecks = append(f.accessChecks, spec)
	if f.accessErr != nil {
		return k8s.AccessResult{}, f.accessErr
	}
	return f.accessResult, nil
}

// fakeK8sFactory returns the same fakeK8sApplier for every call.
// When err is non-nil, NewWithToken returns it instead — lets tests exercise
// the "couldn't build a k8s client" branch of handlers.
type fakeK8sFactory struct {
	applier *fakeK8sApplier
	err     error
	// calls counts NewWithToken invocations. Plan 8 force-delete must NOT
	// touch the factory; the counter lets tests assert the bypass.
	calls int
}

func (f *fakeK8sFactory) NewWithToken(_, _, _ string) (api.K8sApplier, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return f.applier, nil
}

func newTestRouterWithK8s(t *testing.T) (http.Handler, *fakeK8sApplier) {
	t.Helper()
	applier := &fakeK8sApplier{}
	factory := &fakeK8sFactory{applier: applier}
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier:   adminVerifier{},
		Store:      testStore(t),
		K8sFactory: factory,
	})
	return r, applier
}

// newTestRouterUserWithK8s creates a router authenticated as a non-admin user.
func newTestRouterUserWithK8s(t *testing.T, s *store.Store, applier *fakeK8sApplier) http.Handler {
	t.Helper()
	factory := &fakeK8sFactory{applier: applier}
	return api.NewRouter(config.Config{}, api.Deps{
		Verifier:   stubVerifier{}, // non-admin
		Store:      s,
		K8sFactory: factory,
	})
}

func seedCluster(t *testing.T, r http.Handler) string {
	t.Helper()
	name := "cluster-" + randSuffix()
	body, _ := json.Marshal(map[string]any{
		"name": name,
		// One apiserver is registered once (#195), so each fixture cluster has
		// its own URL.
		"api_url":         "https://k8s.example.com/" + name,
		"oidc_issuer_url": "http://localhost:5556",
		"ca_bundle":       testCAPEM(),
	})
	w := do(t, r, http.MethodPost, "/v1/clusters", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, "seed cluster: %s", w.Body.String())
	return name
}

func seedPublishedTemplate(t *testing.T, r http.Handler) string {
	t.Helper()
	name := "tpl-" + randSuffix()
	body, _ := json.Marshal(map[string]any{
		"name":           name,
		"display_name":   "Test Template",
		"authoring_mode": "yaml",
		"resources_yaml": minimalResources,
		"ui_spec_yaml":   minimalUISpec,
	})
	w := do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, "seed template: %s", w.Body.String())

	w = do(t, r, http.MethodPost, "/v1/templates/"+name+"/versions/1/publish", nil)
	require.Equal(t, http.StatusOK, w.Code, "publish: %s", w.Body.String())
	return name
}

func TestReleases_CreateAndList(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)

	body, _ := json.Marshal(map[string]any{
		"template":  tplName,
		"version":   1,
		"cluster":   clusterName,
		"namespace": "default",
		"name":      "my-api-" + randSuffix(),
		"values": map[string]any{
			"Deployment[web].spec.replicas": 2,
		},
	})

	w := do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, "create: %s", w.Body.String())
	require.Len(t, fk.applied, 1)

	w = do(t, r, http.MethodGet, "/v1/releases", nil)
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"my-api-`)
}

func TestReleases_GetByID(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)

	relName := "get-rel-" + randSuffix()
	body, _ := json.Marshal(map[string]any{
		"template":  tplName,
		"version":   1,
		"cluster":   clusterName,
		"namespace": "default",
		"name":      relName,
		"values": map[string]any{
			"Deployment[web].spec.replicas": 1,
		},
	})
	w := do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code)

	var created map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	id := created["id"].(string)

	// Set fake instances for GET
	fk.instances = []k8s.Instance{
		{Name: "web-abc", Phase: "Running", Ready: true, Restarts: 0},
		{Name: "web-def", Phase: "Running", Ready: true, Restarts: 1},
		{Name: "web-ghi", Phase: "Pending", Ready: false, Restarts: 0},
	}

	w = do(t, r, http.MethodGet, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusOK, w.Code)

	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Equal(t, relName, got["name"])
	require.EqualValues(t, 3, got["instances_total"])
	require.EqualValues(t, 2, got["instances_ready"])
	require.Equal(t, "warning", got["status"])
	require.NotNil(t, got["template"])
}

func TestReleases_GetByID_AllHealthy(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)

	relName := "healthy-" + randSuffix()
	body, _ := json.Marshal(map[string]any{
		"template": tplName, "version": 1,
		"cluster": clusterName, "namespace": "default",
		"name": relName, "values": map[string]any{"Deployment[web].spec.replicas": 1},
	})
	w := do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code)

	var created map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	id := created["id"].(string)

	fk.instances = []k8s.Instance{
		{Name: "web-abc", Phase: "Running", Ready: true, Restarts: 0},
	}

	w = do(t, r, http.MethodGet, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusOK, w.Code)

	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Equal(t, "healthy", got["status"])
	require.EqualValues(t, 1, got["instances_ready"])
}

func TestReleases_GetByID_ErrorStatus(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)

	relName := "errpod-" + randSuffix()
	body, _ := json.Marshal(map[string]any{
		"template": tplName, "version": 1,
		"cluster": clusterName, "namespace": "default",
		"name": relName, "values": map[string]any{"Deployment[web].spec.replicas": 1},
	})
	w := do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code)

	var created map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	id := created["id"].(string)

	fk.instances = []k8s.Instance{
		{Name: "web-abc", Phase: "Failed", Ready: false, Restarts: 10},
	}

	w = do(t, r, http.MethodGet, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusOK, w.Code)

	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Equal(t, "error", got["status"])
}

func TestReleases_Delete(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)

	relName := "del-rel-" + randSuffix()
	body, _ := json.Marshal(map[string]any{
		"template":  tplName,
		"version":   1,
		"cluster":   clusterName,
		"namespace": "default",
		"name":      relName,
		"values": map[string]any{
			"Deployment[web].spec.replicas": 1,
		},
	})
	w := do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code)

	var created map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	id := created["id"].(string)

	w = do(t, r, http.MethodDelete, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"deleted":true`)
	require.Len(t, fk.deleted, 1)
	require.Equal(t, relName, fk.deleted[0])

	// get after delete → 404
	w = do(t, r, http.MethodGet, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestReleases_Get_NonOwnerReturns403(t *testing.T) {
	s := testStore(t)
	applier := &fakeK8sApplier{}

	// admin creates a release
	adminRouter := api.NewRouter(config.Config{}, api.Deps{
		Verifier: adminVerifier{}, Store: s,
		K8sFactory: &fakeK8sFactory{applier: applier},
	})
	clusterName := seedCluster(t, adminRouter)
	tplName := seedPublishedTemplate(t, adminRouter)

	relName := "owned-" + randSuffix()
	body, _ := json.Marshal(map[string]any{
		"template": tplName, "version": 1,
		"cluster": clusterName, "namespace": "default",
		"name": relName, "values": map[string]any{"Deployment[web].spec.replicas": 1},
	})
	w := do(t, adminRouter, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code)

	var created map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	id := created["id"].(string)

	// non-admin user tries to GET → 403
	userRouter := newTestRouterUserWithK8s(t, s, applier)
	w = do(t, userRouter, http.MethodGet, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusForbidden, w.Code)
	require.Contains(t, w.Body.String(), "not the release owner")

	// admin can still GET → 200
	w = do(t, adminRouter, http.MethodGet, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestReleases_Delete_NonOwnerReturns403(t *testing.T) {
	s := testStore(t)
	applier := &fakeK8sApplier{}

	adminRouter := api.NewRouter(config.Config{}, api.Deps{
		Verifier: adminVerifier{}, Store: s,
		K8sFactory: &fakeK8sFactory{applier: applier},
	})
	clusterName := seedCluster(t, adminRouter)
	tplName := seedPublishedTemplate(t, adminRouter)

	relName := "nodelete-" + randSuffix()
	body, _ := json.Marshal(map[string]any{
		"template": tplName, "version": 1,
		"cluster": clusterName, "namespace": "default",
		"name": relName, "values": map[string]any{"Deployment[web].spec.replicas": 1},
	})
	w := do(t, adminRouter, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code)

	var created map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	id := created["id"].(string)

	// non-admin user tries to DELETE → 403
	userRouter := newTestRouterUserWithK8s(t, s, applier)
	w = do(t, userRouter, http.MethodDelete, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusForbidden, w.Code)
	require.Contains(t, w.Body.String(), "not the release owner")
}

func TestReleases_List_NonAdminSeesOnlyOwn(t *testing.T) {
	s := testStore(t)
	applier := &fakeK8sApplier{}

	// admin creates a release
	adminRouter := api.NewRouter(config.Config{}, api.Deps{
		Verifier: adminVerifier{}, Store: s,
		K8sFactory: &fakeK8sFactory{applier: applier},
	})
	clusterName := seedCluster(t, adminRouter)
	tplName := seedPublishedTemplate(t, adminRouter)

	body, _ := json.Marshal(map[string]any{
		"template": tplName, "version": 1,
		"cluster": clusterName, "namespace": "default",
		"name":   "admin-rel-" + randSuffix(),
		"values": map[string]any{"Deployment[web].spec.replicas": 1},
	})
	w := do(t, adminRouter, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code)

	// admin list → sees the release
	w = do(t, adminRouter, http.MethodGet, "/v1/releases", nil)
	require.Equal(t, http.StatusOK, w.Code)
	var adminList map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &adminList))
	require.NotEmpty(t, adminList["releases"])

	// non-admin list → sees 0 releases (different user)
	userRouter := newTestRouterUserWithK8s(t, s, applier)
	w = do(t, userRouter, http.MethodGet, "/v1/releases", nil)
	require.Equal(t, http.StatusOK, w.Code)
	var userList map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &userList))
	require.Empty(t, userList["releases"])
}

func TestReleases_Create_DeprecatedVersionRejected(t *testing.T) {
	r, _ := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)

	// deprecate v1
	w := do(t, r, http.MethodPost, "/v1/templates/"+tplName+"/versions/1/deprecate", nil)
	require.Equal(t, http.StatusOK, w.Code)

	body := []byte(`{"template":"` + tplName + `","version":1,"cluster":"` + clusterName + `","namespace":"default","name":"r-` + randSuffix() + `","values":{}}`)
	w = do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Contains(t, w.Body.String(), "deprecated")
}

func TestReleases_Create_InvalidNameReturns400(t *testing.T) {
	r, _ := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)

	body, _ := json.Marshal(map[string]any{
		"template":  tplName,
		"version":   1,
		"cluster":   clusterName,
		"namespace": "default",
		"name":      "INVALID_NAME!",
		"values":    map[string]any{"Deployment[web].spec.replicas": 1},
	})
	w := do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Contains(t, w.Body.String(), "validation-error")
}

func TestReleases_Create_UnpublishedReturns409(t *testing.T) {
	r, _ := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)

	// create template but don't publish
	tplName := "draft-" + randSuffix()
	tplBody, _ := json.Marshal(map[string]any{
		"name":           tplName,
		"display_name":   "Draft Only",
		"authoring_mode": "yaml",
		"resources_yaml": minimalResources,
		"ui_spec_yaml":   minimalUISpec,
	})
	w := do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader(tplBody))
	require.Equal(t, http.StatusCreated, w.Code)

	body, _ := json.Marshal(map[string]any{
		"template":  tplName,
		"version":   1,
		"cluster":   clusterName,
		"namespace": "default",
		"name":      "fail-" + randSuffix(),
		"values":    map[string]any{},
	})
	w = do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.Equal(t, http.StatusConflict, w.Code)
	require.Contains(t, w.Body.String(), "not published")
}

// --- Plan 8: stale-cluster status classification + admin force-delete ---

// newTestRouterWithFactory exposes the factory pointer so tests can toggle
// `err` / inspect `calls` after seed. Mirrors newTestRouterWithK8s for the
// Plan 8 cases that need post-seed factory mutation.
func newTestRouterWithFactory(t *testing.T) (http.Handler, *fakeK8sApplier, *fakeK8sFactory) {
	t.Helper()
	applier := &fakeK8sApplier{}
	factory := &fakeK8sFactory{applier: applier}
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier:   adminVerifier{},
		Store:      testStore(t),
		K8sFactory: factory,
	})
	return r, applier, factory
}

func seedReleaseAdmin(t *testing.T, r http.Handler, clusterName, tplName, namePrefix string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"template":  tplName,
		"version":   1,
		"cluster":   clusterName,
		"namespace": "default",
		"name":      namePrefix + "-" + randSuffix(),
		"values":    map[string]any{"Deployment[web].spec.replicas": 1},
	})
	w := do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, "seed release: %s", w.Body.String())
	var created map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	return created["id"].(string)
}

// TestReleases_GetByID_FactoryError_ReturnsClusterUnreachable: when the k8s
// factory itself can't build a client (TLS / URL parse failure), the handler
// should return status="cluster-unreachable" instead of bucketing into
// "unknown". Empty-instances payload preserved.
func TestReleases_GetByID_FactoryError_ReturnsClusterUnreachable(t *testing.T) {
	r, _, factory := newTestRouterWithFactory(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	id := seedReleaseAdmin(t, r, clusterName, tplName, "factoryerr")

	// Toggle the factory into error mode after seeding so CreateRelease still
	// succeeds. GET will hit the failure branch.
	factory.err = errors.New("simulated TLS failure")

	w := do(t, r, http.MethodGet, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusOK, w.Code)

	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Equal(t, "cluster-unreachable", got["status"])
	require.EqualValues(t, 0, got["instances_total"])
}

// TestReleases_GetByID_ListInstancesError_ReturnsClusterUnreachable: factory
// builds a client, but ListInstances fails (connection refused / timeout
// against a dead apiserver). Same status as factory-error case.
func TestReleases_GetByID_ListInstancesError_ReturnsClusterUnreachable(t *testing.T) {
	r, applier, _ := newTestRouterWithFactory(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	id := seedReleaseAdmin(t, r, clusterName, tplName, "listerr")

	applier.instancesErr = errors.New("simulated connection refused")

	w := do(t, r, http.MethodGet, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusOK, w.Code)

	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Equal(t, "cluster-unreachable", got["status"])
	require.EqualValues(t, 0, got["instances_total"])
}

// TestReleases_GetByID_NoInstances_ReturnsResourcesMissing: cluster reachable,
// list call succeeds with [] and the release's objects are gone — workload
// deleted out-of-band. Plan 8 separates the case from "unknown".
func TestReleases_GetByID_NoInstances_ReturnsResourcesMissing(t *testing.T) {
	r, applier, _ := newTestRouterWithFactory(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	id := seedReleaseAdmin(t, r, clusterName, tplName, "missing")

	applier.instances = nil // explicit: no pods come back
	applier.presence = k8s.PresenceMissing

	w := do(t, r, http.MethodGet, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusOK, w.Code)

	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Equal(t, "resources-missing", got["status"])
	require.EqualValues(t, 0, got["instances_total"])
}

// No pods is not no objects. A CronJob between runs has none, and calling it
// resources-missing put up a banner saying it had been deleted outside
// kubeport (#33). Only a cluster that shows the objects gone earns that
// status; one that shows them there, or cannot tell, leaves it unknown.
func TestReleases_GetByID_NoInstancesButNotShownGone_ReturnsUnknown(t *testing.T) {
	cases := map[string]struct {
		presence k8s.Presence
		err      error
	}{
		"objects found":        {presence: k8s.PresenceFound},
		"nothing readable":     {presence: k8s.PresenceUnknown},
		"presence check fails": {presence: k8s.PresenceMissing, err: errors.New("simulated timeout")},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			r, applier, _ := newTestRouterWithFactory(t)
			clusterName := seedCluster(t, r)
			tplName := seedPublishedTemplate(t, r)
			id := seedReleaseAdmin(t, r, clusterName, tplName, "idle")

			applier.instances = nil
			applier.presence, applier.presenceErr = tc.presence, tc.err

			w := do(t, r, http.MethodGet, "/v1/releases/"+id, nil)
			require.Equal(t, http.StatusOK, w.Code)

			var got map[string]any
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
			require.Equal(t, "unknown", got["status"])
			require.EqualValues(t, 0, got["instances_total"])
		})
	}
}

// A pod that cannot pull its image stays Pending and is never restarted, so
// neither Phase nor Restarts marks it failed. Its reason has to, and has to
// reach the client so the page can say what went wrong (#33).
func TestReleases_GetByID_StuckReason_ReturnsErrorWithReason(t *testing.T) {
	r, applier, _ := newTestRouterWithFactory(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	id := seedReleaseAdmin(t, r, clusterName, tplName, "stuck")

	applier.instances = []k8s.Instance{{
		Name: "web-1", Phase: "Pending",
		Reason: "ImagePullBackOff", Message: `Back-off pulling image "ghcr.io/does-not-exist/web:0.0.0"`,
	}}

	w := do(t, r, http.MethodGet, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusOK, w.Code)

	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Equal(t, "error", got["status"])
	ins := got["instances"].([]any)[0].(map[string]any)
	require.Equal(t, "ImagePullBackOff", ins["reason"])
	require.Contains(t, ins["message"], "does-not-exist")
}

// Waiting on capacity can clear on its own, so an unschedulable pod is still
// settling, not failed.
func TestReleases_GetByID_Unschedulable_StaysWarning(t *testing.T) {
	r, applier, _ := newTestRouterWithFactory(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	id := seedReleaseAdmin(t, r, clusterName, tplName, "unsched")

	applier.instances = []k8s.Instance{{Name: "web-1", Phase: "Pending", Reason: "Unschedulable"}}

	w := do(t, r, http.MethodGet, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusOK, w.Code)

	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Equal(t, "warning", got["status"])
}

// TestReleases_Delete_ForceAdmin_BypassesK8s: admin can DELETE ?force=true
// and the handler must NOT touch the k8s factory at all (cluster might be
// dead — that's the whole point of force). DB row gets removed.
func TestReleases_Delete_ForceAdmin_BypassesK8s(t *testing.T) {
	r, _, factory := newTestRouterWithFactory(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	id := seedReleaseAdmin(t, r, clusterName, tplName, "force-adm")

	// Snapshot factory call count after seed (CreateRelease uses 1 call).
	before := factory.calls

	w := do(t, r, http.MethodDelete, "/v1/releases/"+id+"?force=true", nil)
	require.Equal(t, http.StatusOK, w.Code, "force delete: %s", w.Body.String())
	require.Contains(t, w.Body.String(), `"deleted":true`)
	require.Contains(t, w.Body.String(), `"force":true`)

	// Factory should NOT have been touched — that's the whole point of force.
	require.Equal(t, before, factory.calls, "force delete must not touch k8s factory")

	// Row gone.
	w = do(t, r, http.MethodGet, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusNotFound, w.Code)
}

// TestReleases_Delete_ForceNonAdmin_Forbidden: a release owner who is NOT in
// kubeport-admin can't escalate via ?force=true. The DB row stays.
func TestReleases_Delete_ForceNonAdmin_Forbidden(t *testing.T) {
	s := testStore(t)
	applier := &fakeK8sApplier{}
	factory := &fakeK8sFactory{applier: applier}

	// Non-admin owner creates the release.
	userRouter := api.NewRouter(config.Config{}, api.Deps{
		Verifier:   stubVerifier{}, // non-admin
		Store:      s,
		K8sFactory: factory,
	})

	// Cluster + template require admin to seed; use a parallel admin router.
	adminRouter := api.NewRouter(config.Config{}, api.Deps{
		Verifier:   adminVerifier{},
		Store:      s,
		K8sFactory: factory,
	})
	clusterName := seedCluster(t, adminRouter)
	tplName := seedPublishedTemplate(t, adminRouter)

	// Non-admin creates their own release so authorizeReleaseAccess passes.
	id := seedReleaseAdmin(t, userRouter, clusterName, tplName, "force-usr")

	w := do(t, userRouter, http.MethodDelete, "/v1/releases/"+id+"?force=true", nil)
	require.Equal(t, http.StatusForbidden, w.Code, "force delete by non-admin must be denied: %s", w.Body.String())
	require.Contains(t, w.Body.String(), "force delete requires admin")

	// Row preserved.
	w = do(t, userRouter, http.MethodGet, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusOK, w.Code, "row should still exist")
}

// TestReleases_Delete_NoForce_K8sFails_PreservesDB: regression cover for the
// existing "k8s first, then DB" flow — when k8s.DeleteByRelease fails the
// handler returns 502 and the DB row must remain so the admin can still
// recover via ?force=true.
func TestReleases_Delete_NoForce_K8sFails_PreservesDB(t *testing.T) {
	r, applier, _ := newTestRouterWithFactory(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	id := seedReleaseAdmin(t, r, clusterName, tplName, "k8sfail")

	applier.deleteErr = errors.New("simulated k8s delete failure")

	w := do(t, r, http.MethodDelete, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusBadGateway, w.Code, "expected 502 when k8s delete fails")
	require.Contains(t, w.Body.String(), "k8s-error")

	// Row preserved.
	w = do(t, r, http.MethodGet, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusOK, w.Code, "row should still exist after k8s delete failure")
}
