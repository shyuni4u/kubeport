package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
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
    required: true
`

const apiKey = "sk-live-do-not-leak"

func seedSecretRelease(t *testing.T) (http.Handler, *fakeK8sApplier, string) {
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
	return r, applier, created["id"].(string)
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

	values["Secret[app-secret].stringData.API_KEY"] = "rotated"
	body, _ = json.Marshal(map[string]any{"version": 1, "values": values})
	w = do(t, r, http.MethodPut, "/v1/releases/"+id, bytes.NewReader(body))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	applied = string(applier.applied[len(applier.applied)-1])
	require.Contains(t, applied, "rotated")
	require.NotContains(t, applied, apiKey)
}
