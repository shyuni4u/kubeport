package api_test

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/k8s"
)

// #340: the delete confirmation asks what the delete would do to storage as it
// opens. The detail's own periodic refresh must not pay for that.

func getReleaseBody(t *testing.T, r http.Handler, path string) map[string]any {
	t.Helper()
	w := do(t, r, http.MethodGet, path, nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	return got
}

func TestGetRelease_StorageOnDeleteOnlyWhenAsked(t *testing.T) {
	r, applier, _ := newTestRouterWithFactory(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	id := seedReleaseAdmin(t, r, clusterName, tplName, "storage")
	applier.storage = k8s.StorageDeleted

	got := getReleaseBody(t, r, "/v1/releases/"+id)
	require.NotContains(t, got, "storage_on_delete")
	require.Zero(t, applier.storageCalls, "a refresh spends no cluster calls on it")

	got = getReleaseBody(t, r, "/v1/releases/"+id+"?include=storage_on_delete")
	require.Equal(t, "deleted", got["storage_on_delete"])
	require.Equal(t, 1, applier.storageCalls)
	require.Contains(t, got, "status", "still the whole detail")
	require.Contains(t, got, "instances")
}

// Asked for and not answerable, the verdict is unknown — which the
// confirmation reads as "may be deleted" — never a missing field or a milder
// value.
func TestGetRelease_StorageOnDeleteIsUnknownWhenTheClusterCannotTell(t *testing.T) {
	r, applier, factory := newTestRouterWithFactory(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	id := seedReleaseAdmin(t, r, clusterName, tplName, "storageerr")

	applier.storage, applier.storageErr = k8s.StorageNone, errors.New("simulated timeout")
	got := getReleaseBody(t, r, "/v1/releases/"+id+"?include=storage_on_delete")
	require.Equal(t, "unknown", got["storage_on_delete"], "an error does not pass on whatever came with it")

	factory.err = errors.New("simulated TLS failure")
	got = getReleaseBody(t, r, "/v1/releases/"+id+"?include=storage_on_delete")
	require.Equal(t, "unknown", got["storage_on_delete"])
	require.Equal(t, "cluster-unreachable", got["status"])
}
