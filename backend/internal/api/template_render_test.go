package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestPreviewRender_NotFound: POST /v1/templates/:name/render for an unknown
// template returns 404. Uses the standard admin router so auth passes and the
// handler reaches the Store lookup.
func TestPreviewRender_NotFound(t *testing.T) {
	r := newTestRouterAdmin(t)
	body, _ := json.Marshal(map[string]any{"values": map[string]any{}})
	w := do(t, r, http.MethodPost, "/v1/templates/does-not-exist/render", bytes.NewReader(body))
	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "not-found")
}

// TestPreviewRender_BadJSON: malformed request body → 400. Uses the same
// router setup as the positive-path tests so the negative path isn't a
// fragile lookalike (an earlier version stubbed only the Verifier, which
// would silently diverge from the router wiring exercised elsewhere).
func TestPreviewRender_BadJSON(t *testing.T) {
	r := newTestRouterAdmin(t)
	w := do(t, r, http.MethodPost, "/v1/templates/anything/render",
		strings.NewReader("{not json"))
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "validation-error")
}

// TestPreviewRender_InvalidVersionParam: ?version=foo → 400.
func TestPreviewRender_InvalidVersionParam(t *testing.T) {
	r := newTestRouterAdmin(t)
	body, _ := json.Marshal(map[string]any{"values": map[string]any{}})
	w := do(t, r, http.MethodPost, "/v1/templates/anything/render?version=foo",
		bytes.NewReader(body))
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "validation-error")
}

// TestPreviewRender_Success: seeds a published template and renders it with
// supplied values. Verifies the rendered YAML contains the value substitution
// and preview-specific labels (release name "preview"). Integration test —
// requires docker compose (postgres).
func TestPreviewRender_Success(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := seedPublishedTemplate(t, r)

	body, _ := json.Marshal(map[string]any{
		"values": map[string]any{
			"Deployment[web].spec.replicas": 7,
		},
	})
	w := do(t, r, http.MethodPost, "/v1/templates/"+name+"/render", bytes.NewReader(body))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var got struct {
		Template     string `json:"template"`
		Version      int    `json:"version"`
		RenderedYAML string `json:"rendered_yaml"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Equal(t, name, got.Template)
	require.Equal(t, 1, got.Version)
	require.Contains(t, got.RenderedYAML, "replicas: 7")
	require.Contains(t, got.RenderedYAML, "kubeport.io/release: preview")
	require.Contains(t, got.RenderedYAML, "kubeport.io/template: "+name)
}

// TestPreviewRender_ExplicitVersion: ?version=1 works for a published v1.
func TestPreviewRender_ExplicitVersion(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := seedPublishedTemplate(t, r)

	body, _ := json.Marshal(map[string]any{
		"values": map[string]any{
			"Deployment[web].spec.replicas": 3,
		},
	})
	w := do(t, r, http.MethodPost, "/v1/templates/"+name+"/render?version=1", bytes.NewReader(body))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.EqualValues(t, 1, got["version"])
	require.Contains(t, got["rendered_yaml"], "replicas: 3")
}

// TestPreviewRender_UnknownVersion: ?version=99 for an existing template → 404.
func TestPreviewRender_UnknownVersion(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := seedPublishedTemplate(t, r)

	body, _ := json.Marshal(map[string]any{"values": map[string]any{}})
	w := do(t, r, http.MethodPost, "/v1/templates/"+name+"/render?version=99", bytes.NewReader(body))
	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
}

// TestPreviewRender_NoPublishedVersion: template exists but has no published
// version → 404 (no "current published version" to default to).
func TestPreviewRender_NoPublishedVersion(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := "draft-only-" + randSuffix()
	tplBody, _ := json.Marshal(map[string]any{
		"name":           name,
		"display_name":   "Draft Only",
		"authoring_mode": "yaml",
		"resources_yaml": minimalResources,
		"ui_spec_yaml":   minimalUISpec,
	})
	w := do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader(tplBody))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())

	body, _ := json.Marshal(map[string]any{"values": map[string]any{}})
	w = do(t, r, http.MethodPost, "/v1/templates/"+name+"/render", bytes.NewReader(body))
	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
}

// TestPreviewRender_RenderError: invalid value (fails ui-spec pattern/type
// validation) → 400 with the render error surfaced.
func TestPreviewRender_RenderError(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := seedPublishedTemplate(t, r)

	// minimalUISpec declares spec.replicas as integer with max=20. Send 999.
	body, _ := json.Marshal(map[string]any{
		"values": map[string]any{
			"Deployment[web].spec.replicas": 999,
		},
	})
	w := do(t, r, http.MethodPost, "/v1/templates/"+name+"/render", bytes.NewReader(body))
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "validation-error")
}
