package template_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	"kubeport/internal/template"
)

// The seeded demo template is what issue #129 was reported against, so it is
// worth rendering the shipped file rather than only hand-written fixtures: a
// key shape the grammar cannot express is a 400 the moment an admin opens the
// template, and the seed is the first template anyone opens.
func TestRender_SeededWebAppTemplate(t *testing.T) {
	dir := filepath.Join("..", "..", "cmd", "seed-demo", "fixtures")
	resources, err := os.ReadFile(filepath.Join(dir, "web-app.resources.yaml"))
	require.NoError(t, err)
	uiSpec, err := os.ReadFile(filepath.Join(dir, "web-app.ui-spec.yaml"))
	require.NoError(t, err)

	out, err := template.Render(string(resources), string(uiSpec), []byte(`{}`), template.Labels{
		ReleaseName: "r1", TemplateName: "web-app", TemplateVersion: 1, ReleaseID: "id-1",
	})
	require.NoError(t, err)
	require.NotEmpty(t, out)
}

// The UI editor's round trip: every scalar in the seed becomes a field path,
// and SerializeUIMode has to rebuild the same document from those paths. This
// is the loop that broke — the generator produced
// `metadata.labels.app.kubernetes.io/name` and the parser rejected it.
func TestSerializeUIMode_RoundTripsSeededLabelKeys(t *testing.T) {
	dir := filepath.Join("..", "..", "cmd", "seed-demo", "fixtures")
	raw, err := os.ReadFile(filepath.Join(dir, "web-app.resources.yaml"))
	require.NoError(t, err)

	// Mirror yaml-to-ui-state.ts: walk to scalar leaves, quoting any key the
	// bare segment grammar cannot express.
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	var seen int
	for {
		var doc map[string]any
		if err := dec.Decode(&doc); err != nil {
			break
		}
		kind, _ := doc["kind"].(string)
		meta, _ := doc["metadata"].(map[string]any)
		if meta == nil {
			continue
		}
		name, _ := meta["name"].(string)
		if kind == "" || name == "" {
			continue
		}

		fields := map[string]template.UIField{}
		for k, v := range doc {
			if k == "apiVersion" || k == "kind" {
				continue
			}
			if k == "metadata" {
				for mk, mv := range meta {
					if mk == "name" {
						continue
					}
					walkLeaves(t, mustJoin(t, "metadata", mk), mv, fields)
				}
				continue
			}
			walkLeaves(t, mustJoin(t, "", k), v, fields)
		}

		apiVersion, _ := doc["apiVersion"].(string)
		rebuilt, _, err := template.SerializeUIMode(template.UIModeTemplate{
			Resources: []template.UIResource{{
				APIVersion: apiVersion, Kind: kind, Name: name, Fields: fields,
			}},
		})
		require.NoErrorf(t, err, "serializing %s/%s", kind, name)

		// Compare as JSON so map ordering and YAML style do not matter — what
		// has to survive is the shape and the values.
		var got map[string]any
		require.NoError(t, yaml.Unmarshal([]byte(rebuilt), &got))
		requireSameJSON(t, doc, got, kind+"/"+name)
		seen++
	}
	require.Greater(t, seen, 0, "no documents read from the seed fixture")
}

func mustJoin(t *testing.T, prefix, key string) string {
	t.Helper()
	p, err := template.JoinPath(prefix, key)
	require.NoErrorf(t, err, "joining %q + %q", prefix, key)
	return p
}

func walkLeaves(t *testing.T, path string, v any, out map[string]template.UIField) {
	t.Helper()
	switch node := v.(type) {
	case map[string]any:
		for k, child := range node {
			walkLeaves(t, mustJoin(t, path, k), child, out)
		}
	case []any:
		for i, child := range node {
			walkLeaves(t, fmt.Sprintf("%s[%d]", path, i), child, out)
		}
	default:
		out[path] = template.UIField{Mode: "fixed", FixedValue: v}
	}
}

func requireSameJSON(t *testing.T, want, got map[string]any, label string) {
	t.Helper()
	w, err := json.Marshal(want)
	require.NoError(t, err)
	g, err := json.Marshal(got)
	require.NoError(t, err)
	var wa, ga any
	require.NoError(t, json.Unmarshal(w, &wa))
	require.NoError(t, json.Unmarshal(g, &ga))
	require.Equalf(t, wa, ga, "UI-mode round trip changed %s", label)
}
