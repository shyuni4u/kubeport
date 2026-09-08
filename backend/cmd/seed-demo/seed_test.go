package main

import (
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strconv"
	"strings"
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
// does not check that, and Render auto-creates missing map keys, so a typo
// would render "successfully" and only surface as a broken deploy on the demo
// cluster. Check that each path pre-exists in the source documents, then
// render with defaults and with the seeded release values.
func TestFixturesRender(t *testing.T) {
	labels := template.Labels{ReleaseName: "t", TemplateName: "t", TemplateVersion: 1}
	byName := map[string]fixtures.Template{}
	for _, f := range fixtures.All() {
		byName[f.Name] = f
		var spec template.UISpec
		require.NoError(t, yaml.Unmarshal([]byte(f.UISpecYAML), &spec), f.Name)
		docs := parseDocs(t, f.ResourcesYAML)
		values := map[string]any{}
		for _, fld := range spec.Fields {
			require.True(t, pathExists(docs, fld.Path), "%s: ui-spec path %q not found in resources.yaml", f.Name, fld.Path)
			// Required fields have no default by design; supply a sample so
			// the path itself still gets exercised.
			if fld.Required && fld.Default == nil {
				switch fld.Type {
				case template.TypeInteger:
					values[fld.Path] = 1
				case template.TypeBoolean:
					values[fld.Path] = true
				default:
					values[fld.Path] = "sample"
				}
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

func parseDocs(t *testing.T, src string) []map[string]any {
	t.Helper()
	var docs []map[string]any
	dec := yaml.NewDecoder(strings.NewReader(src))
	for {
		var d map[string]any
		if err := dec.Decode(&d); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			t.Fatalf("parse resources: %v", err)
		}
		if d != nil {
			docs = append(docs, d)
		}
	}
	return docs
}

var (
	pathHeadRE = regexp.MustCompile(`^([A-Z][A-Za-z]+)(?:\[([^\]]+)\])?(.*)$`)
	pathSegRE  = regexp.MustCompile(`^(?:([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\])`)
)

// pathExists walks `Kind[selector].a.b[0].c` through existing keys only —
// the strict counterpart of template.Render's auto-creating setter.
func pathExists(docs []map[string]any, p string) bool {
	m := pathHeadRE.FindStringSubmatch(p)
	if m == nil {
		return false
	}
	kind, selector, rest := m[1], m[2], strings.TrimPrefix(m[3], ".")
	var matches []map[string]any
	for _, d := range docs {
		if d["kind"] == kind {
			matches = append(matches, d)
		}
	}
	var node any
	switch {
	case selector == "" && len(matches) == 1:
		node = matches[0]
	default:
		if idx, err := strconv.Atoi(selector); err == nil && idx >= 0 && idx < len(matches) {
			node = matches[idx]
		}
		for _, d := range matches {
			if meta, _ := d["metadata"].(map[string]any); meta != nil && meta["name"] == selector {
				node = d
			}
		}
	}
	if node == nil {
		return false
	}
	for rest != "" {
		s := pathSegRE.FindStringSubmatch(rest)
		if s == nil {
			return false
		}
		rest = strings.TrimPrefix(rest[len(s[0]):], ".")
		if s[1] != "" {
			obj, ok := node.(map[string]any)
			if !ok {
				return false
			}
			node, ok = obj[s[1]]
			if !ok {
				return false
			}
		} else {
			idx, _ := strconv.Atoi(s[2])
			arr, ok := node.([]any)
			if !ok || idx >= len(arr) {
				return false
			}
			node = arr[idx]
		}
	}
	return true
}

func TestPathExists(t *testing.T) {
	docs := parseDocs(t, fixtures.All()[0].ResourcesYAML) // web-app
	require.True(t, pathExists(docs, "Deployment[web].spec.template.spec.containers[0].resources.limits.memory"))
	require.True(t, pathExists(docs, "Service.spec.ports[0].port"))
	require.False(t, pathExists(docs, "Deployment[web].spec.template.spec.containers[0].resources.limit.memory"), "typo must be rejected")
	require.False(t, pathExists(docs, "Deployment[web].spec.template.spec.containers[1].image"), "index out of range")
	require.False(t, pathExists(docs, "Deployment[other].spec.replicas"), "unknown selector")
	require.False(t, pathExists(docs, "ConfigMap.data.missing"))
}

func TestReleaseSpecs(t *testing.T) {
	rs := releaseSpecs()
	require.Len(t, rs, 2)
	require.Equal(t, "web-app-demo", rs[0].Name)
	require.Equal(t, "nightly-job-demo", rs[1].Name)
	require.Contains(t, string(rs[1].Values), "does-not-exist", "second release must fail to pull so the failure UX is visible")
}
