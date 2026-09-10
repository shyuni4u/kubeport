package template_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"testing"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	"kubeport/internal/template"
)

const stringMapResources = `apiVersion: v1
kind: ConfigMap
metadata:
  name: cfg
data:
  FLAG: "false"
  PORT: "80"
  NAME: plain
---
apiVersion: v1
kind: Secret
metadata:
  name: sec
stringData:
  RETRIES: "1"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
`

const stringMapSpec = `fields:
  - path: ConfigMap[cfg].data.FLAG
    label: flag
    type: boolean
  - path: ConfigMap[cfg].data.PORT
    label: port
    type: integer
  - path: Secret[sec].stringData.RETRIES
    label: retries
    type: integer
  - path: Deployment[web].spec.replicas
    label: replicas
    type: integer
`

func renderedByName(t *testing.T, rendered []byte) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	dec := yaml.NewDecoder(bytes.NewReader(rendered))
	for {
		var doc map[string]any
		err := dec.Decode(&doc)
		if errors.Is(err, io.EOF) {
			return out
		}
		require.NoError(t, err)
		meta, _ := doc["metadata"].(map[string]any)
		out[meta["name"].(string)] = doc
	}
}

// A boolean or integer ui-spec field written into ConfigMap data was rendered
// as a YAML bool or number, and the apiserver refused the object ("expected
// string") — which is how every deploy of the demo's app-with-config failed.
func TestRender_ValuesInStringMapsRenderAsStrings(t *testing.T) {
	values := json.RawMessage(`{
		"ConfigMap[cfg].data.FLAG": true,
		"ConfigMap[cfg].data.PORT": 8080,
		"Secret[sec].stringData.RETRIES": 3,
		"Deployment[web].spec.replicas": 2
	}`)

	rendered, err := template.Render(stringMapResources, stringMapSpec, values, template.Labels{ReleaseName: "r"})
	require.NoError(t, err)
	docs := renderedByName(t, rendered)

	data := docs["cfg"]["data"].(map[string]any)
	require.Equal(t, "true", data["FLAG"])
	require.Equal(t, "8080", data["PORT"])
	require.Equal(t, "plain", data["NAME"], "values that were already strings are untouched")

	stringData := docs["sec"]["stringData"].(map[string]any)
	require.Equal(t, "3", stringData["RETRIES"])

	// Only the string maps change. A number the API wants as a number stays one.
	spec := docs["web"]["spec"].(map[string]any)
	require.Equal(t, 2, spec["replicas"])
}

// A boolean default applies the same way as a submitted value; the seed of
// app-with-config sent no FEATURE_FLAG and got the default false.
func TestRender_DefaultsInStringMapsRenderAsStrings(t *testing.T) {
	spec := `fields:
  - path: ConfigMap[cfg].data.FLAG
    label: flag
    type: boolean
    default: false
`
	rendered, err := template.Render(stringMapResources, spec, json.RawMessage(`{}`), template.Labels{ReleaseName: "r"})
	require.NoError(t, err)

	data := renderedByName(t, rendered)["cfg"]["data"].(map[string]any)
	require.Equal(t, "false", data["FLAG"])
}
