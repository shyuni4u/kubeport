package api_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
)

// Issue #282. When an apply fails, the create deletes what reached the cluster
// and then its own row — on one shared 30s context. The usual reason an apply
// fails is a cluster that stopped answering, and the cleanup goes to that same
// cluster, so it could use up the whole budget; the row delete then failed at
// once and the failed create left a release holding its name. Each step now
// has its own deadline.
func TestCreateRelease_AStalledCleanupStillDropsTheRow(t *testing.T) {
	defer api.SetReleaseCleanupK8sTimeout(50 * time.Millisecond)()
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	body, _ := json.Marshal(map[string]any{
		"template": tplName, "version": 1, "cluster": clusterName, "namespace": "default",
		"name":   "stalled-" + randSuffix(),
		"values": map[string]any{"Deployment[web].spec.replicas": 1},
	})

	fk.applyErr = errors.New("dial tcp 10.0.0.1:6443: i/o timeout")
	fk.deleteStall = true
	w := do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.NotEqual(t, http.StatusCreated, w.Code, w.Body.String())
	require.Len(t, fk.deleteCalls, 1, "the create must have tried to clean the cluster up")

	// The cluster is back. The same request goes through: no row was left
	// behind to answer 409 "release name already exists".
	fk.applyErr = nil
	fk.deleteStall = false
	w = do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
}
