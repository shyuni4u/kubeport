package template_test

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	"kubeport/internal/template"
)

// The path grammar's plain segment is a Go-style identifier, but a Kubernetes
// map key is not. Label and annotation keys carry `.`, `-` and `/`
// (`app.kubernetes.io/name` is the recommended-label standard), and ConfigMap
// data keys are usually filenames. Quoted segments are how those are addressed.
//
// Two properties matter and they are different:
//
//   - a quoted segment is ONE key, even when it contains the `.` that separates
//     plain segments. `labels["app.kubernetes.io/name"]` must not become four
//     nested maps.
//   - the writer and the reader agree. yaml-to-ui-state.ts generates these
//     paths from a document and SerializeUIMode parses them back into one, so a
//     key that survives generation but not parsing is a 400 on a valid
//     template — which is what issue #129 was.
const labelPath = `metadata.labels["app.kubernetes.io/name"]`

// renderWith exposes exactly one field at path and renders value into it. The
// values payload is marshalled rather than concatenated: these paths contain
// the quote characters that would otherwise terminate the JSON string early.
func renderWith(t *testing.T, resources, path string, value any) map[string]any {
	t.Helper()
	uispec, err := yaml.Marshal(map[string]any{
		"fields": []map[string]any{{"path": path, "label": "L", "type": "string"}},
	})
	require.NoError(t, err)
	values, err := json.Marshal(map[string]any{path: value})
	require.NoError(t, err)

	out, err := template.Render(resources, string(uispec), values, template.Labels{})
	require.NoError(t, err)
	var doc map[string]any
	require.NoError(t, yaml.Unmarshal([]byte(out), &doc))
	return doc
}

func TestSetJSONPath_QuotedSegmentIsOneKey(t *testing.T) {
	resources := `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels:
    app.kubernetes.io/name: placeholder
spec:
  replicas: 1
`
	doc := renderWith(t, resources, `Deployment[web].`+labelPath, "web-app")

	meta := doc["metadata"].(map[string]any)
	labels := meta["labels"].(map[string]any)
	require.Equal(t, "web-app", labels["app.kubernetes.io/name"],
		"the quoted segment must address one key")
	require.NotContains(t, labels, "app",
		"a quoted segment must not be split on its dots into nested maps")
}

func TestSetJSONPath_QuotedSegmentAcceptsBothQuoteStyles(t *testing.T) {
	// Single quotes exist so a key containing a double quote is still
	// addressable without an escape mechanism, and vice versa. Kubernetes keys
	// cannot contain either, but ConfigMap data and CRD fields are freer.
	resources := `apiVersion: v1
kind: ConfigMap
metadata:
  name: conf
data:
  app.properties: placeholder
`
	doc := renderWith(t, resources, `ConfigMap[conf].data['app.properties']`, "key=value")
	require.Equal(t, "key=value", doc["data"].(map[string]any)["app.properties"])
}

func TestSetJSONPath_RejectsUnterminatedQuotedSegment(t *testing.T) {
	// A missing closing bracket must not be silently read as a plain segment;
	// that is the "quiet wrong document" failure mode issue #129 warned about.
	resources := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: conf\ndata:\n  a: b\n"
	uispec, err := yaml.Marshal(map[string]any{
		"fields": []map[string]any{{
			"path":    `ConfigMap[conf].data["unterminated`,
			"label":   "L",
			"type":    "string",
			"default": "x",
		}},
	})
	require.NoError(t, err)

	_, err = template.Render(resources, string(uispec), []byte(`{}`), template.Labels{})
	require.Error(t, err)
	require.Contains(t, err.Error(), "unterminated")
}

func TestSetJSONPath_PlainSegmentsStillWork(t *testing.T) {
	// The quoted form is additive. Every path shape that worked before has to
	// keep working, including array indices next to plain keys.
	resources := `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:1.24
`
	doc := renderWith(t, resources, "Deployment[web].spec.template.spec.containers[0].image", "nginx:1.25")
	ctr := doc["spec"].(map[string]any)["template"].(map[string]any)["spec"].(map[string]any)["containers"].([]any)[0].(map[string]any)
	require.Equal(t, "nginx:1.25", ctr["image"])
}

func TestSerializeUIMode_QuotedSegmentRoundTrips(t *testing.T) {
	// The generator side. SerializeUIMode builds a document from field paths,
	// so it must place a quoted key as one key — otherwise the UI editor
	// writes a document that does not match what the admin saw.
	ui := template.UIModeTemplate{
		Resources: []template.UIResource{{
			APIVersion: "apps/v1", Kind: "Deployment", Name: "web",
			Fields: map[string]template.UIField{
				labelPath:                     {Mode: "fixed", FixedValue: "web-app"},
				`metadata.labels["app-tier"]`: {Mode: "fixed", FixedValue: "frontend"},
				"spec.replicas":               {Mode: "fixed", FixedValue: 2},
			},
		}},
	}

	resources, _, err := template.SerializeUIMode(ui)
	require.NoError(t, err)

	var doc map[string]any
	require.NoError(t, yaml.Unmarshal([]byte(resources), &doc))
	labels := doc["metadata"].(map[string]any)["labels"].(map[string]any)
	require.Equal(t, "web-app", labels["app.kubernetes.io/name"])
	require.Equal(t, "frontend", labels["app-tier"],
		"a hyphen is not a separator either — it was rejected by the identifier class")
	require.NotContains(t, labels, "app")
}

func TestSerializeUIMode_ExposedQuotedPathKeepsPrefix(t *testing.T) {
	// The ui-spec path is `Kind[name].` + the field path. A quoted segment has
	// to survive that concatenation, because Render parses the whole string
	// back and yaml-to-ui-state.ts splits the prefix off again.
	ui := template.UIModeTemplate{
		Resources: []template.UIResource{{
			APIVersion: "apps/v1", Kind: "Deployment", Name: "web",
			Fields: map[string]template.UIField{
				labelPath: {Mode: "exposed", UISpec: &template.UISpecEntry{
					Label: "앱 이름", Type: "string", Default: "web-app",
				}},
			},
		}},
	}

	resources, uispec, err := template.SerializeUIMode(ui)
	require.NoError(t, err)

	var parsed struct {
		Fields []template.UISpecEntry `yaml:"fields"`
	}
	require.NoError(t, yaml.Unmarshal([]byte(uispec), &parsed))
	require.Len(t, parsed.Fields, 1)
	require.Equal(t, `Deployment[web].`+labelPath, parsed.Fields[0].Path)

	// And the pair the editor just produced has to render — this is the exact
	// round trip that failed in #129.
	values, err := json.Marshal(map[string]any{`Deployment[web].` + labelPath: "renamed"})
	require.NoError(t, err)
	out, err := template.Render(resources, uispec, values, template.Labels{})
	require.NoError(t, err)
	var doc map[string]any
	require.NoError(t, yaml.Unmarshal([]byte(out), &doc))
	require.Equal(t, "renamed",
		doc["metadata"].(map[string]any)["labels"].(map[string]any)["app.kubernetes.io/name"])
}

// ValidateSpec runs on every write (create template, create version, patch
// version, seed) and on no read. Catching a broken path there moves the
// failure from the user's deploy back to the admin's save.
func TestValidateSpec_RejectsUnparseablePath(t *testing.T) {
	resources := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: conf\ndata:\n  a: b\n"

	for name, path := range map[string]string{
		"unquoted key with a slash": "ConfigMap[conf].data.app.kubernetes.io/name",
		"unterminated quote":        `ConfigMap[conf].data["oops`,
		"missing bracket":           `ConfigMap[conf].data["oops"`,
		"negative index":            "ConfigMap[conf].data[-1]",
	} {
		t.Run(name, func(t *testing.T) {
			uispec, err := yaml.Marshal(map[string]any{
				"fields": []map[string]any{{"path": path, "label": "필드", "type": "string"}},
			})
			require.NoError(t, err)

			err = template.ValidateSpec(resources, string(uispec))
			require.Error(t, err)
			require.Contains(t, err.Error(), "필드",
				"the admin needs to know which field to fix")
		})
	}
}

func TestValidateSpec_AcceptsQuotedPath(t *testing.T) {
	resources := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: conf\ndata:\n  a: b\n"
	uispec, err := yaml.Marshal(map[string]any{
		"fields": []map[string]any{{
			"path":  `ConfigMap[conf].data["app.kubernetes.io/name"]`,
			"label": "필드", "type": "string",
		}},
	})
	require.NoError(t, err)
	require.NoError(t, template.ValidateSpec(resources, string(uispec)))
}
