package template_test

import (
	"testing"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	"kubeport/internal/template"
)

// codex review: a multiple-instance template saved from the UI editor lost the
// setting — SerializeUIMode wrote a ui-spec of fields alone — and quietly
// became single again. The UI state carries it now.
func TestSerializeUIMode_CarriesInstances(t *testing.T) {
	ui := template.UIModeTemplate{
		Instances: template.InstancesMultiple,
		Resources: []template.UIResource{{APIVersion: "v1", Kind: "ConfigMap", Name: "conf", Fields: map[string]template.UIField{}}},
	}

	res, spec, err := template.SerializeUIMode(ui)
	require.NoError(t, err)
	var doc map[string]any
	require.NoError(t, yaml.Unmarshal([]byte(spec), &doc))
	require.Equal(t, "multiple", doc["instances"])
	require.NoError(t, template.ValidateSpec(res, spec))

	ui.Instances = ""
	_, spec, err = template.SerializeUIMode(ui)
	require.NoError(t, err)
	doc = nil
	require.NoError(t, yaml.Unmarshal([]byte(spec), &doc))
	_, present := doc["instances"]
	require.False(t, present, "a template that never chose keeps the ui-spec it always produced")
}
