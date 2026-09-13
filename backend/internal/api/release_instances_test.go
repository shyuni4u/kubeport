package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// Issue #190. A single-instance and a multi-instance version name and select a
// release's objects differently, so an update cannot move a release between
// them; deploying the other version as a new release is the way across.

func addVersionWithSpec(t *testing.T, r http.Handler, tpl, uiSpec string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"authoring_mode": "yaml", "resources_yaml": minimalResources, "ui_spec_yaml": uiSpec,
	})
	w := do(t, r, http.MethodPost, "/v1/templates/"+tpl+"/versions", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	var v struct {
		Version int `json:"version"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &v))
	w = do(t, r, http.MethodPost, "/v1/templates/"+tpl+"/versions/"+itoa(v.Version)+"/publish", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func deployV1(t *testing.T, r http.Handler, cluster, tpl string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"template": tpl, "version": 1, "cluster": cluster, "namespace": "default",
		"name": "rel-" + randSuffix(), "values": map[string]any{"Deployment[web].spec.replicas": 1},
	})
	w := do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	var rel struct {
		ID string `json:"id"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &rel))
	return rel.ID
}

func updateTo(t *testing.T, r http.Handler, id string, version int) *bytes.Buffer {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"version": version, "values": map[string]any{"Deployment[web].spec.replicas": 1}})
	w := do(t, r, http.MethodPut, "/v1/releases/"+id, bytes.NewReader(body))
	return bytes.NewBufferString(itoa(w.Code) + " " + w.Body.String())
}

func TestUpdateRelease_RefusesMovingBetweenInstanceModes(t *testing.T) {
	r, applier := newTestRouterWithK8s(t)
	cluster := seedCluster(t, r)
	tpl := seedPublishedTemplate(t, r) // v1: no instances key, so single
	id := deployV1(t, r, cluster, tpl)
	addVersionWithSpec(t, r, tpl, "instances: multiple\n"+minimalUISpec)
	applied := len(applier.applied)

	got := updateTo(t, r, id, 2).String()

	require.True(t, strings.HasPrefix(got, "400 "), got)
	require.Contains(t, got, "cannot move to a multiple-instance one")
	require.Equal(t, applied, len(applier.applied), "nothing may be applied")
}

// The other direction, and a move between two versions of the same mode, which
// stays open.
func TestUpdateRelease_MovesBetweenVersionsOfTheSameInstanceMode(t *testing.T) {
	r, _ := newTestRouterWithK8s(t)
	cluster := seedCluster(t, r)
	tpl := seedPublishedTemplate(t, r)
	id := deployV1(t, r, cluster, tpl)
	addVersionWithSpec(t, r, tpl, "instances: single\n"+minimalUISpec)

	got := updateTo(t, r, id, 2).String()
	require.True(t, strings.HasPrefix(got, "200 "), "an explicit single is the same mode as none: %s", got)
}
