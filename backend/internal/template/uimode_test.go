package template_test

import (
	"testing"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	"kubeport/internal/template"
)

func TestSerializeUIMode_FixedAndExposedFields(t *testing.T) {
	ui := template.UIModeTemplate{
		Resources: []template.UIResource{
			{
				APIVersion: "apps/v1", Kind: "Deployment", Name: "web",
				Fields: map[string]template.UIField{
					"spec.replicas": {
						Mode: "exposed",
						UISpec: &template.UISpecEntry{
							Label: "인스턴스 개수", Type: "integer", Min: intPtr(1), Max: intPtr(10), Default: 3, Required: true,
						},
					},
					"spec.template.spec.containers[0].image": {
						Mode:       "fixed",
						FixedValue: "nginx:1.25",
					},
					"spec.template.spec.containers[0].name": {
						Mode:       "fixed",
						FixedValue: "app",
					},
				},
			},
		},
	}

	resources, uispec, err := template.SerializeUIMode(ui)
	require.NoError(t, err)

	var dep map[string]any
	require.NoError(t, yaml.Unmarshal([]byte(resources), &dep))
	require.Equal(t, "apps/v1", dep["apiVersion"])
	require.Equal(t, "Deployment", dep["kind"])
	require.Equal(t, "web", dep["metadata"].(map[string]any)["name"])
	spec := dep["spec"].(map[string]any)
	require.Equal(t, 3, spec["replicas"]) // exposed default
	ctr := spec["template"].(map[string]any)["spec"].(map[string]any)["containers"].([]any)[0].(map[string]any)
	require.Equal(t, "nginx:1.25", ctr["image"])
	require.Equal(t, "app", ctr["name"])

	var parsed struct {
		Fields []template.UISpecEntry `yaml:"fields"`
	}
	require.NoError(t, yaml.Unmarshal([]byte(uispec), &parsed))
	require.Len(t, parsed.Fields, 1)
	require.Equal(t, "Deployment[web].spec.replicas", parsed.Fields[0].Path)
	require.Equal(t, "integer", parsed.Fields[0].Type)
}

func TestSerializeUIMode_NoExposedFields(t *testing.T) {
	ui := template.UIModeTemplate{
		Resources: []template.UIResource{
			{APIVersion: "v1", Kind: "ConfigMap", Name: "c", Fields: map[string]template.UIField{
				"data.k": {Mode: "fixed", FixedValue: "v"},
			}},
		},
	}
	_, uispec, err := template.SerializeUIMode(ui)
	require.NoError(t, err)
	require.Contains(t, uispec, "fields: []")
}

func TestSerializeUIMode_RejectsHugeArrayIndex(t *testing.T) {
	ui := template.UIModeTemplate{
		Resources: []template.UIResource{
			{APIVersion: "apps/v1", Kind: "Deployment", Name: "web", Fields: map[string]template.UIField{
				"spec.template.spec.containers[9999].image": {Mode: "fixed", FixedValue: "x"},
			}},
		},
	}
	_, _, err := template.SerializeUIMode(ui)
	require.Error(t, err)
	require.Contains(t, err.Error(), "exceeds limit")
}

func intPtr(n int) *int { return &n }
