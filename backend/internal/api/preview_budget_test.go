package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/auth"
	"kubeport/internal/config"
)

// Issue #135. POST /v1/templates/preview builds a document out of the field
// paths in the body, and a path could make it build one far larger than the
// body: array segments each grew a 1025-slot slice while the walk descended
// into one slot, and plain segments each cost a map, which the YAML encoder
// then indents quadratically. 801 bytes of path measured at 196MB, 4KB at
// 1.9GB — against a single replica with a 256Mi limit.
//
// This is the end-to-end half; the arithmetic is in
// internal/template/budget_test.go. What it establishes is that the refusal
// arrives as the API's own contract (400 validation-error, Problem shape) and
// not as a dead backend.
func previewBody(t *testing.T, path string) *bytes.Reader {
	t.Helper()
	b, err := json.Marshal(map[string]any{
		"ui_state": map[string]any{
			"resources": []map[string]any{{
				"apiVersion": "v1", "kind": "ConfigMap", "name": "m",
				"fields": map[string]any{
					path: map[string]any{"mode": "fixed", "fixedValue": "v"},
				},
			}},
		},
	})
	require.NoError(t, err)
	return bytes.NewReader(b)
}

func plainUserRouter(t *testing.T) http.Handler {
	t.Helper()
	return api.NewRouter(config.Config{}, api.Deps{
		Verifier: customVerifier{claims: auth.Claims{
			Subject: "plain-" + randSuffix(), Email: "plain@example.com",
		}},
		Store: testStore(t),
	})
}

func TestPreview_RefusesArrayGrowthBomb(t *testing.T) {
	r := plainUserRouter(t)
	w := do(t, r, http.MethodPost, "/v1/templates/preview",
		previewBody(t, strings.Repeat("a[1024].", 20)+"x"))
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "validation-error")
}

func TestPreview_RefusesDeepPathBomb(t *testing.T) {
	r := plainUserRouter(t)
	w := do(t, r, http.MethodPost, "/v1/templates/preview",
		previewBody(t, strings.Repeat("a.", 8000)+"x"))
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "validation-error")
}

// Preview stays open to any authenticated caller on purpose — it returns a
// pure function of the body just posted, so there is nothing for a role gate
// to protect, and requireAdmin would be stricter than the save path it
// previews for (POST /templates admits a team editor who is not
// kubeport-admin). This pins that decision: a plain user gets 200, not 403.
func TestPreview_StaysOpenToPlainUsers(t *testing.T) {
	r := plainUserRouter(t)
	w := do(t, r, http.MethodPost, "/v1/templates/preview",
		previewBody(t, "data.key"))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
}

// The same bomb reaches POST /v1/templates, which is why the limit lives in
// SerializeUIMode rather than in middleware on the preview route.
//
// That handler used to serialize ui_state BEFORE checking whether the caller
// may create a template, so a caller destined for a 403 spent the work first.
// Authorization now runs before serialization — it never depended on ui_state
// — which is what the other two SerializeUIMode call sites already did. So a
// plain user gets 403 here and never reaches the bomb at all.
func TestCreateTemplate_AuthorizesBeforeSerializing(t *testing.T) {
	r := plainUserRouter(t)
	body, err := json.Marshal(map[string]any{
		"name": "t-" + randSuffix(), "display_name": "T", "authoring_mode": "ui",
		"ui_state": map[string]any{
			"resources": []map[string]any{{
				"apiVersion": "v1", "kind": "ConfigMap", "name": "m",
				"fields": map[string]any{
					strings.Repeat("a[1024].", 20) + "x": map[string]any{"mode": "fixed", "fixedValue": "v"},
				},
			}},
		},
	})
	require.NoError(t, err)
	w := do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader(body))
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "rbac-denied")
}

// The budget charged the path but not the value it attached, so a two-segment
// path with a deeply nested fixedValue walked straight past every limit. The
// path here is `data.k` — the shortest thing that reaches a leaf.
func TestPreview_RefusesNestedValueBomb(t *testing.T) {
	r := plainUserRouter(t)
	var v any = "x"
	for i := 0; i < 500; i++ {
		v = map[string]any{"a": v}
	}
	b, err := json.Marshal(map[string]any{
		"ui_state": map[string]any{
			"resources": []map[string]any{{
				"apiVersion": "v1", "kind": "ConfigMap", "name": "m",
				"fields": map[string]any{
					"data.k": map[string]any{"mode": "fixed", "fixedValue": v},
				},
			}},
		},
	})
	require.NoError(t, err)
	w := do(t, r, http.MethodPost, "/v1/templates/preview", bytes.NewReader(b))
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "validation-error")
}

// A manifest-shaped path still works. Without this the guard could be set so
// tight that it refuses the product's own templates and nothing would say so.
func TestPreview_AllowsARealisticPath(t *testing.T) {
	r := plainUserRouter(t)
	w := do(t, r, http.MethodPost, "/v1/templates/preview",
		previewBody(t, "spec.template.spec.containers[0].env[0].valueFrom.secretKeyRef.name"))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
}
