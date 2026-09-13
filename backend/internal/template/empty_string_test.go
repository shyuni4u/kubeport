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

// What Render does with an empty or blank string, pinned so the deploy form
// can be held to it (#331). `required` is a presence check: a key that is
// there passes it whatever its value, and a string field accepts any string
// its pattern (if any) matches. The form refuses "" for a required field on
// its own account — an emptied text box is its way of saying "no value" — but
// must not refuse "   ", which the API takes.

const emptyStringImagePath = "Deployment[web].spec.template.spec.containers[0].image"

func renderedImage(t *testing.T, out []byte) any {
	t.Helper()
	dec := yaml.NewDecoder(bytes.NewReader(out))
	for {
		var doc map[string]any
		err := dec.Decode(&doc)
		if errors.Is(err, io.EOF) {
			break
		}
		require.NoError(t, err)
		if doc["kind"] != "Deployment" {
			continue
		}
		spec := doc["spec"].(map[string]any)["template"].(map[string]any)["spec"].(map[string]any)
		return spec["containers"].([]any)[0].(map[string]any)["image"]
	}
	t.Fatal("no Deployment in the rendered output")
	return nil
}

func TestRender_RequiredStringIsAPresenceCheck(t *testing.T) {
	uiSpec := `fields:
  - path: ` + emptyStringImagePath + `
    label: "Image"
    type: string
    required: true
`
	_, err := template.Render(resourcesYAML, uiSpec, json.RawMessage(`{}`), template.Labels{})
	require.ErrorContains(t, err, `field "Image" required`)

	for _, v := range []string{"", "   "} {
		values, _ := json.Marshal(map[string]any{emptyStringImagePath: v})
		out, err := template.Render(resourcesYAML, uiSpec, values, template.Labels{})
		require.NoError(t, err, "%q", v)
		require.Equal(t, v, renderedImage(t, out), "%q", v)
	}
}

func TestRender_RequiredStringPatternStillAppliesToEmpty(t *testing.T) {
	uiSpec := `fields:
  - path: ` + emptyStringImagePath + `
    label: "Image"
    type: string
    required: true
    pattern: "^[a-z]+$"
`
	for _, v := range []string{"", "   "} {
		values, _ := json.Marshal(map[string]any{emptyStringImagePath: v})
		_, err := template.Render(resourcesYAML, uiSpec, values, template.Labels{})
		require.ErrorContains(t, err, "does not match pattern", "%q", v)
	}
}

func TestRender_OptionalEmptyStringOverridesTheDefault(t *testing.T) {
	uiSpec := `fields:
  - path: ` + emptyStringImagePath + `
    label: "Image"
    type: string
    default: "nginx:1.25"
`
	out, err := template.Render(resourcesYAML, uiSpec, json.RawMessage(`{}`), template.Labels{})
	require.NoError(t, err)
	require.Equal(t, "nginx:1.25", renderedImage(t, out), "an omitted key takes the default")

	values, _ := json.Marshal(map[string]any{emptyStringImagePath: ""})
	out, err = template.Render(resourcesYAML, uiSpec, values, template.Labels{})
	require.NoError(t, err)
	require.Equal(t, "", renderedImage(t, out), `"" is a value, written over the default`)
}
