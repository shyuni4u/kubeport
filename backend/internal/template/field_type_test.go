package template_test

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/template"
)

const fieldTypeResources = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: web
          image: nginx
`

// #136: an unknown or misspelled type fell through every case of Validate and
// returned nil, so whatever the caller sent — a whole object included — was
// written into the manifest unchecked.
func TestField_ValidateRefusesAnUnknownType(t *testing.T) {
	for _, typ := range []template.FieldType{"", "str", "int", "object"} {
		t.Run(string(typ), func(t *testing.T) {
			f := template.Field{Path: "Deployment[web].spec.template.spec.containers[0]", Label: "container", Type: typ}

			err := f.Validate(map[string]any{"securityContext": map[string]any{"privileged": true}})

			require.Error(t, err)
			require.Contains(t, err.Error(), "unsupported field type")
		})
	}
}

// A version saved before ValidateSpec checked types still renders, so Render
// is where that version is stopped. This is the defence that matters for data
// already in the database.
func TestRender_RefusesAStoredSpecWithAnUnknownType(t *testing.T) {
	spec := `fields:
  - path: Deployment[web].spec.template.spec.containers[0]
    label: container
    type: str
`
	values := json.RawMessage(`{"Deployment[web].spec.template.spec.containers[0]": {"name": "web", "securityContext": {"privileged": true}}}`)

	_, err := template.Render(fieldTypeResources, spec, values, template.Labels{ReleaseName: "r"})

	require.Error(t, err)
	require.Contains(t, err.Error(), `unsupported field type "str"`)
}

func TestValidateSpec_RefusesAnUnknownType(t *testing.T) {
	spec := `fields:
  - path: Deployment[web].spec.replicas
    label: replicas
    type: int
`
	err := template.ValidateSpec(fieldTypeResources, spec)

	require.Error(t, err)
	require.Contains(t, err.Error(), "fields[0]")
	require.Contains(t, err.Error(), `unknown type "int"`)
}

func TestValidateSpec_RefusesAMissingType(t *testing.T) {
	spec := `fields:
  - path: Deployment[web].spec.replicas
    label: replicas
`
	err := template.ValidateSpec(fieldTypeResources, spec)

	require.Error(t, err)
	require.Contains(t, err.Error(), `unknown type ""`)
}

// #152: the contract marks label required and the editor refused a blank one,
// but the API saved it, and the form then showed an input with nothing beside it.
func TestValidateSpec_RefusesABlankLabel(t *testing.T) {
	for _, label := range []string{`""`, `"   "`} {
		t.Run(label, func(t *testing.T) {
			spec := "fields:\n  - path: Deployment[web].spec.replicas\n    label: " + label + "\n    type: integer\n"

			err := template.ValidateSpec(fieldTypeResources, spec)

			require.Error(t, err)
			require.Contains(t, err.Error(), "fields[0]")
			require.Contains(t, err.Error(), "has no label")
		})
	}
}

func TestValidateSpec_AcceptsEveryDocumentedType(t *testing.T) {
	spec := `fields:
  - path: Deployment[web].spec.replicas
    label: replicas
    type: integer
  - path: Deployment[web].spec.template.spec.containers[0].image
    label: image
    type: string
  - path: Deployment[web].spec.template.spec.containers[0].name
    label: name
    type: enum
    values: [web, api]
  - path: Deployment[web].metadata.labels.tier
    label: tier
    type: autocomplete
    values: [front]
  - path: Deployment[web].spec.paused
    label: paused
    type: boolean
`
	require.NoError(t, template.ValidateSpec(fieldTypeResources, spec))
}

// A stored version without a label must not produce ": not an integer".
func TestField_ValidateNamesAnUnlabelledFieldByPath(t *testing.T) {
	f := template.Field{Path: "Deployment[web].spec.replicas", Type: template.TypeInteger}

	err := f.Validate("three")

	require.EqualError(t, err, "Deployment[web].spec.replicas: not an integer")
}
