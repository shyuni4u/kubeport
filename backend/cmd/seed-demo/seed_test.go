package main

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	"kubeport/cmd/seed-demo/fixtures"
	"kubeport/internal/template"
)

func TestFixturesValidate(t *testing.T) {
	all := fixtures.All()
	require.Len(t, all, 3)
	for _, f := range all {
		require.NoError(t, template.ValidateSpec(f.ResourcesYAML, f.UISpecYAML), f.Name)
	}
}

// Every ui-spec path must resolve against its resources.yaml — ValidateSpec
// does not check that, so render each fixture with defaults and with the
// seeded release values. A broken path would otherwise only surface as a
// failed deploy on the demo cluster.
func TestFixturesRender(t *testing.T) {
	labels := template.Labels{ReleaseName: "t", TemplateName: "t", TemplateVersion: 1}
	byName := map[string]fixtures.Template{}
	for _, f := range fixtures.All() {
		byName[f.Name] = f
		// Required fields have no default by design; supply a sample so the
		// path itself still gets exercised.
		var spec template.UISpec
		require.NoError(t, yaml.Unmarshal([]byte(f.UISpecYAML), &spec), f.Name)
		values := map[string]any{}
		for _, fld := range spec.Fields {
			if fld.Required && fld.Default == nil {
				values[fld.Path] = "sample"
			}
		}
		raw, err := json.Marshal(values)
		require.NoError(t, err)
		_, err = template.Render(f.ResourcesYAML, f.UISpecYAML, raw, labels)
		require.NoError(t, err, "%s with defaults", f.Name)
	}
	for _, r := range releaseSpecs() {
		f, ok := byName[r.Template]
		require.True(t, ok, "release %s references unknown template %s", r.Name, r.Template)
		_, err := template.Render(f.ResourcesYAML, f.UISpecYAML, r.Values, labels)
		require.NoError(t, err, "release %s", r.Name)
	}
}

func TestReleaseSpecs(t *testing.T) {
	rs := releaseSpecs()
	require.Len(t, rs, 2)
	require.Equal(t, "web-app-demo", rs[0].Name)
	require.Equal(t, "nightly-job-demo", rs[1].Name)
	require.Contains(t, string(rs[1].Values), "does-not-exist", "second release must fail to pull so the failure UX is visible")
}
