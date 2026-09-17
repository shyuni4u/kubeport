package template_test

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
	"kubeport/internal/template"
)

func TestResourceBindingAcrossKinds(t *testing.T) {
	for _, kind := range []string{"Deployment", "Service", "ConfigMap", "Secret"} {
		t.Run(kind, func(t *testing.T) {
			res, spec, err := template.SerializeUIMode(template.UIModeTemplate{Resources: []template.UIResource{{APIVersion: "v1", Kind: kind, Name: "original", Fields: map[string]template.UIField{
				"metadata.name":             {Mode: "exposed", UISpec: &template.UISpecEntry{Label: "Name", Type: "string", Default: "renamed"}},
				"metadata.annotations.note": {Mode: "exposed", UISpec: &template.UISpecEntry{Label: "Note", Type: "string", Default: "hello"}},
			}}}})
			require.NoError(t, err)
			require.Contains(t, res, "name: original")
			require.NoError(t, template.ValidateSpec(res, spec))
			// Name first must not invalidate the second field's binding.
			spec = fmt.Sprintf("fields:\n- path: %s[original].metadata.name\n  label: Name\n  type: string\n  default: renamed\n- path: %s[original].metadata.annotations.note\n  label: Note\n  type: string\n  default: hello\n", kind, kind)
			out, err := template.Render(res, spec, json.RawMessage(`{}`), template.Labels{})
			require.NoError(t, err)
			require.Contains(t, string(out), "name: renamed")
			require.Contains(t, string(out), "note: hello")
		})
	}
}

func TestValidateSpecRejectsUnresolvableTargets(t *testing.T) {
	res := "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: original\nspec:\n  template:\n    spec:\n      containers:\n      - name: app\n        image: nginx\n"
	for _, path := range []string{"Deployment[missing].spec.replicas", "Service[original].spec.type", "Deployment[original].spec.template.spec.containers[2].image"} {
		t.Run(path, func(t *testing.T) {
			spec := "fields:\n- path: " + path + "\n  label: Test\n  type: string\n"
			require.Error(t, template.ValidateSpec(res, spec))
		})
	}
	require.Error(t, template.ValidateSpec("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: 자유 텍스트\n", "fields: []"))
}

func TestFixedNameKeepsOtherFieldsBound(t *testing.T) {
	res, spec, err := template.SerializeUIMode(template.UIModeTemplate{Resources: []template.UIResource{{APIVersion: "v1", Kind: "ConfigMap", Name: "original", Fields: map[string]template.UIField{
		"metadata.name": {Mode: "fixed", FixedValue: "renamed"},
		"data.message":  {Mode: "exposed", UISpec: &template.UISpecEntry{Label: "Message", Type: "string", Default: "hello"}},
	}}}})
	require.NoError(t, err)
	require.Contains(t, spec, "ConfigMap[renamed].data.message")
	require.NoError(t, template.ValidateSpec(res, spec))
	_, err = template.Render(res, spec, json.RawMessage(`{}`), template.Labels{})
	require.NoError(t, err)
}

func TestInvalidNameDefaultAndInputAreRejected(t *testing.T) {
	res := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: original\n"
	spec := "fields:\n- path: ConfigMap[original].metadata.name\n  label: Name\n  type: string\n  default: 자유 텍스트\n"
	require.ErrorContains(t, template.ValidateSpec(res, spec), "default")
	_, err := template.Render(res, spec, json.RawMessage(`{"ConfigMap[original].metadata.name":"INVALID NAME"}`), template.Labels{})
	require.ErrorContains(t, err, "metadata.name")
}
