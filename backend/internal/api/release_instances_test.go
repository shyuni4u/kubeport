package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/store"
)

// Issue #190. A single-instance and a multi-instance version name and select a
// release's objects differently. A template's versions share one mode, and an
// update cannot move a release between modes.

func postVersion(t *testing.T, r http.Handler, tpl, uiSpec string) (int, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"authoring_mode": "yaml", "resources_yaml": minimalResources, "ui_spec_yaml": uiSpec,
	})
	w := do(t, r, http.MethodPost, "/v1/templates/"+tpl+"/versions", bytes.NewReader(body))
	return w.Code, w.Body.String()
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

// Security review: with a single and a multiple version in one template, a
// single release's Service would select the multiple release's pods by the
// template's own labels. The mode is fixed per template.
func TestTemplateVersions_KeepTheTemplatesInstanceMode(t *testing.T) {
	r := newTestRouterAdmin(t)
	tpl := seedPublishedTemplate(t, r) // v1: no instances key, so single

	code, body := postVersion(t, r, tpl, "instances: multiple\n"+minimalUISpec)
	require.Equal(t, http.StatusBadRequest, code, body)
	require.Contains(t, body, "released versions are single-instance")

	code, body = postVersion(t, r, tpl, "instances: single\n"+minimalUISpec)
	require.Equal(t, http.StatusCreated, code, "an explicit single is the template's mode: %s", body)

	// Turning the draft multiple on update is refused the same way.
	patch, _ := json.Marshal(map[string]any{"ui_spec_yaml": "instances: multiple\n" + minimalUISpec})
	w := do(t, r, http.MethodPatch, "/v1/templates/"+tpl+"/versions/2", bytes.NewReader(patch))
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "released versions are single-instance")
}

// A template whose only versions are drafts has no mode yet: its first version
// may be either.
func TestTemplateVersions_DraftsDoNotFixTheMode(t *testing.T) {
	r := newTestRouterAdmin(t)
	tpl := "tpl-" + randSuffix()
	body, _ := json.Marshal(map[string]any{
		"name": tpl, "display_name": "Draft only", "authoring_mode": "yaml",
		"resources_yaml": minimalResources, "ui_spec_yaml": minimalUISpec,
	})
	w := do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())

	patch, _ := json.Marshal(map[string]any{"ui_spec_yaml": "instances: multiple\n" + minimalUISpec})
	w = do(t, r, http.MethodPatch, "/v1/templates/"+tpl+"/versions/1", bytes.NewReader(patch))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	w = do(t, r, http.MethodPost, "/v1/templates/"+tpl+"/versions/1/publish", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	code, resp := postVersion(t, r, tpl, minimalUISpec)
	require.Equal(t, http.StatusBadRequest, code, resp)
	require.Contains(t, resp, "released versions are multiple-instance")
}

// Security review: undeprecating is publishing again. A deprecated multiple
// version must not come back beside a single one published meanwhile — as a
// rollback past this check could leave — or the two modes share a template.
func TestTemplateVersions_UndeprecateKeepsTheTemplatesInstanceMode(t *testing.T) {
	r := newTestRouterAdmin(t)
	tpl := seedPublishedTemplate(t, r) // v1: single, published

	ctx := context.Background()
	s := testStore(t)
	row, err := s.GetTemplateByName(ctx, tpl)
	require.NoError(t, err)
	v, err := s.InsertTemplateVersionV2(ctx, store.InsertTemplateVersionV2Params{
		TemplateID: row.ID, Version: 2, ResourcesYaml: minimalResources,
		UiSpecYaml: "instances: multiple\n" + minimalUISpec, Status: "deprecated",
		CreatedByUserID: row.OwnerUserID, AuthoringMode: "yaml",
	})
	require.NoError(t, err)

	w := do(t, r, http.MethodPost, "/v1/templates/"+tpl+"/versions/2/undeprecate", nil)
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "released versions are single-instance")

	after, err := s.GetTemplateVersionByID(ctx, v.ID)
	require.NoError(t, err)
	require.Equal(t, "deprecated", after.Status, "the refused undeprecate must not have happened")
}

// The update guard stays for versions saved before the per-template check: a
// release cannot be moved onto a version of the other mode.
func TestUpdateRelease_RefusesMovingBetweenInstanceModes(t *testing.T) {
	r, applier := newTestRouterWithK8s(t)
	cluster := seedCluster(t, r)
	tpl := seedPublishedTemplate(t, r)
	id := deployV1(t, r, cluster, tpl)

	// A multiple version written straight to the store, as one saved before
	// the API refused it would be.
	ctx := context.Background()
	s := testStore(t)
	row, err := s.GetTemplateByName(ctx, tpl)
	require.NoError(t, err)
	v, err := s.InsertTemplateVersionV2(ctx, store.InsertTemplateVersionV2Params{
		TemplateID: row.ID, Version: 2, ResourcesYaml: minimalResources,
		UiSpecYaml: "instances: multiple\n" + minimalUISpec, Status: "draft",
		CreatedByUserID: row.OwnerUserID, AuthoringMode: "yaml",
	})
	require.NoError(t, err)
	_, err = s.PublishTemplateVersion(ctx, v.ID)
	require.NoError(t, err)
	applied := len(applier.applied)

	body, _ := json.Marshal(map[string]any{"version": 2, "values": map[string]any{"Deployment[web].spec.replicas": 1}})
	w := do(t, r, http.MethodPut, "/v1/releases/"+id, bytes.NewReader(body))

	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "cannot move to a multiple-instance one")
	require.NotContains(t, w.Body.String(), "new release", "the refusal must not point at deploying the other mode beside this one")
	require.Equal(t, applied, len(applier.applied), "nothing may be applied")
}

// A move between versions of the same mode stays open; an explicit single is
// the same mode as none.
func TestUpdateRelease_MovesBetweenVersionsOfTheSameInstanceMode(t *testing.T) {
	r, _ := newTestRouterWithK8s(t)
	cluster := seedCluster(t, r)
	tpl := seedPublishedTemplate(t, r)
	id := deployV1(t, r, cluster, tpl)
	code, resp := postVersion(t, r, tpl, "instances: single\n"+minimalUISpec)
	require.Equal(t, http.StatusCreated, code, resp)
	w := do(t, r, http.MethodPost, "/v1/templates/"+tpl+"/versions/2/publish", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	body, _ := json.Marshal(map[string]any{"version": 2, "values": map[string]any{"Deployment[web].spec.replicas": 1}})
	w = do(t, r, http.MethodPut, "/v1/releases/"+id, bytes.NewReader(body))
	got := strconv.Itoa(w.Code) + " " + w.Body.String()
	require.True(t, strings.HasPrefix(got, "200 "), got)
}
