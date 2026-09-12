package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// Issue #196. GET /v1/releases/:id handed back the stored values_json and
// rendered_yaml, Secret values in plain text, to anyone kubeport lets read the
// release — though the cluster's RBAC may let them write a Secret and not read
// it (the demo Role does exactly that). They are redacted now, and an update
// that sends the redacted placeholder back keeps the Secret's value.

const secretResources = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: app
          image: placeholder
---
apiVersion: v1
kind: Secret
metadata: { name: app-secret }
stringData:
  API_KEY: placeholder
data:
  TOKEN: cGxhY2Vob2xkZXI=
`

const secretUISpec = `
fields:
  - path: Deployment[web].spec.replicas
    label: "Replicas"
    type: integer
    min: 1
    max: 20
    default: 1
  - path: Secret[app-secret].stringData.API_KEY
    label: "API key"
    type: string
    pattern: "^sk-[a-z-]+$"
    required: true
`

const apiKey = "sk-live-do-not-leak"

func seedSecretRelease(t *testing.T) (http.Handler, *fakeK8sApplier, string) {
	t.Helper()
	r, applier, id, _ := seedSecretReleaseOf(t)
	return r, applier, id
}

// seedSecretReleaseOf is seedSecretRelease that also returns the template name.
func seedSecretReleaseOf(t *testing.T) (http.Handler, *fakeK8sApplier, string, string) {
	t.Helper()
	r, applier := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tpl := "secret-" + randSuffix()
	body, _ := json.Marshal(map[string]any{
		"name": tpl, "display_name": "With a Secret", "authoring_mode": "yaml",
		"resources_yaml": secretResources, "ui_spec_yaml": secretUISpec,
	})
	w := do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	publishV1(t, r, tpl)

	body, _ = json.Marshal(map[string]any{
		"template": tpl, "version": 1, "cluster": clusterName, "namespace": "default",
		"name":   "rel-" + randSuffix(),
		"values": map[string]any{"Deployment[web].spec.replicas": 1, "Secret[app-secret].stringData.API_KEY": apiKey},
	})
	w = do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	require.NotContains(t, w.Body.String(), apiKey, "the create response is a read of the release too")
	require.Contains(t, string(applier.applied[len(applier.applied)-1]), apiKey, "the cluster gets the real value")
	var created map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	return r, applier, created["id"].(string), tpl
}

func readRelease(t *testing.T, r http.Handler, id string) map[string]any {
	t.Helper()
	w := do(t, r, http.MethodGet, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NotContains(t, w.Body.String(), apiKey)
	require.NotContains(t, w.Body.String(), "cGxhY2Vob2xkZXI=", "data values are the Secret's content too")
	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	return got
}

func TestGetRelease_RedactsSecretValues(t *testing.T) {
	r, _, id := seedSecretRelease(t)

	got := readRelease(t, r, id)

	values := got["values_json"].(map[string]any)
	require.Equal(t, "<redacted>", values["Secret[app-secret].stringData.API_KEY"])
	require.EqualValues(t, 1, values["Deployment[web].spec.replicas"], "values outside a Secret are left alone")
	rendered := got["rendered_yaml"].(string)
	require.Contains(t, rendered, "API_KEY: <redacted>")
	require.Contains(t, rendered, "TOKEN: <redacted>")
	require.Contains(t, rendered, "image: placeholder", "objects other than Secrets are left alone")
}

// The update form fills itself from that read. Sending the placeholder back
// keeps the Secret; sending a new value changes it.
func TestUpdateRelease_TheRedactedPlaceholderKeepsTheSecret(t *testing.T) {
	r, applier, id := seedSecretRelease(t)
	values := readRelease(t, r, id)["values_json"].(map[string]any)
	values["Deployment[web].spec.replicas"] = 3

	body, _ := json.Marshal(map[string]any{"version": 1, "values": values})
	w := do(t, r, http.MethodPut, "/v1/releases/"+id, bytes.NewReader(body))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	applied := string(applier.applied[len(applier.applied)-1])
	require.Contains(t, applied, apiKey, "the Secret kept its value")
	require.NotContains(t, applied, "<redacted>")
	require.Contains(t, applied, "replicas: 3")
	readRelease(t, r, id)

	values["Secret[app-secret].stringData.API_KEY"] = "sk-rotated"
	body, _ = json.Marshal(map[string]any{"version": 1, "values": values})
	w = do(t, r, http.MethodPut, "/v1/releases/"+id, bytes.NewReader(body))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	applied = string(applier.applied[len(applier.applied)-1])
	require.Contains(t, applied, "sk-rotated")
	require.NotContains(t, applied, apiKey)
}

// codex review: the update form previews as the user edits, sending the same
// placeholder. A Secret whose constraints the placeholder does not meet — here
// a pattern — made every preview 400, and with it the permission check built
// from the preview. Naming the release renders the stored value instead, and
// the preview comes back redacted.
func TestPreviewRender_ForAReleaseKeepsItsSecretAndRedactsTheOutput(t *testing.T) {
	r, _, id, tpl := seedSecretReleaseOf(t)
	values := readRelease(t, r, id)["values_json"].(map[string]any)
	path := "/v1/templates/" + tpl + "/render?version=1"

	body, _ := json.Marshal(map[string]any{"values": values})
	w := do(t, r, http.MethodPost, path, bytes.NewReader(body))
	require.Equal(t, http.StatusBadRequest, w.Code, "without the release the placeholder fails the pattern: %s", w.Body.String())

	body, _ = json.Marshal(map[string]any{"values": values, "release_id": id})
	w = do(t, r, http.MethodPost, path, bytes.NewReader(body))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NotContains(t, w.Body.String(), apiKey, "the preview must not show what the read hid")
	var preview struct {
		RenderedYAML string `json:"rendered_yaml"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &preview))
	require.Contains(t, preview.RenderedYAML, "API_KEY: <redacted>")
}

// Putting stored values back takes the same access as reading them.
func TestPreviewRender_ForSomeoneElsesReleaseIsRefused(t *testing.T) {
	r, _, id, tpl := seedSecretReleaseOf(t)
	values := readRelease(t, r, id)["values_json"].(map[string]any)
	outsider := newPlainUserRouter(t, testStore(t), randSuffix())

	body, _ := json.Marshal(map[string]any{"values": values, "release_id": id})
	w := do(t, outsider, http.MethodPost, "/v1/templates/"+tpl+"/render?version=1", bytes.NewReader(body))
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.NotContains(t, w.Body.String(), apiKey)
}

// addSecretVersion adds version 2 of tpl, whose API key must match pattern,
// and publishes it when asked.
func addSecretVersion(t *testing.T, r http.Handler, tpl, pattern string, publish bool) {
	t.Helper()
	uiSpec := strings.Replace(secretUISpec, `pattern: "^sk-[a-z-]+$"`, `pattern: "`+pattern+`"`, 1)
	body, _ := json.Marshal(map[string]any{
		"authoring_mode": "yaml", "resources_yaml": secretResources, "ui_spec_yaml": uiSpec,
	})
	w := do(t, r, http.MethodPost, "/v1/templates/"+tpl+"/versions", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	if publish {
		w = do(t, r, http.MethodPost, "/v1/templates/"+tpl+"/versions/2/publish", nil)
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	}
}

// Security review: previewing another version with the release named — a draft
// whose pattern the caller wrote — must not check the stored Secret against
// that pattern, or the 200/400 answer says whether it matches. The answer is
// the one the same request gets without the release.
func TestPreviewRender_AnotherVersionDoesNotCheckTheStoredSecret(t *testing.T) {
	r, _, id, tpl := seedSecretReleaseOf(t)
	values := readRelease(t, r, id)["values_json"].(map[string]any)
	addSecretVersion(t, r, tpl, "^sk-live", false)
	path := "/v1/templates/" + tpl + "/render?version=2"

	body, _ := json.Marshal(map[string]any{"values": values})
	without := do(t, r, http.MethodPost, path, bytes.NewReader(body))
	body, _ = json.Marshal(map[string]any{"values": values, "release_id": id})
	with := do(t, r, http.MethodPost, path, bytes.NewReader(body))

	require.Equal(t, http.StatusBadRequest, without.Code, without.Body.String())
	require.Equal(t, without.Code, with.Code, "the stored value matches the draft's pattern; the answer must not say so")
	require.Equal(t, problemShape(t, without.Body.String()), problemShape(t, with.Body.String()))
}

// Security review: an update to another version checks a kept Secret against
// that version's rules. When it does not fit, the refusal says to enter the
// Secret again — not which rule the stored value broke.
func TestUpdateRelease_AKeptSecretThatDoesNotFitANewVersionSaysOnlyThat(t *testing.T) {
	r, _, id, tpl := seedSecretReleaseOf(t)
	values := readRelease(t, r, id)["values_json"].(map[string]any)
	addSecretVersion(t, r, tpl, "^x", true)

	body, _ := json.Marshal(map[string]any{"version": 2, "values": values})
	w := do(t, r, http.MethodPut, "/v1/releases/"+id, bytes.NewReader(body))

	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	p := problemShape(t, w.Body.String())
	require.NotContains(t, p.Detail, "pattern")
	require.NotContains(t, p.Detail, "^x")
	require.Contains(t, p.Detail, "enter the Secret values again")
}
