package template

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Labels struct {
	ReleaseName     string
	TemplateName    string
	TemplateVersion int
	ReleaseID       string
	AppliedBy       string
}

// ValidateSpec parses the resources and ui-spec YAML pair and returns a
// non-nil error if either is malformed, if any ui-spec field has an invalid
// pattern, or if any field path is unparseable. It skips value injection and
// required-field checks so admins can register templates whose fields are
// required at deploy time.
//
// Path syntax is checked here rather than only at render time because every
// caller is a write: an unparseable path saved now surfaces as a failed deploy
// later, in front of the user rather than the admin who mistyped it. Quoted
// segments make that more likely, since they are the one part of the grammar
// an admin writes by hand.
func ValidateSpec(resourcesYAML, uiSpecYAML string) error {
	if _, err := parseMultiDoc(resourcesYAML); err != nil {
		return err
	}
	spec, err := parseSpec(uiSpecYAML)
	if err != nil {
		return err
	}
	for i, f := range spec.Fields {
		if err := validatePath(f.Path); err != nil {
			// fields[i] rather than the label alone: a label is a display
			// string, is not unique, and is translated, so it is a poor
			// handle for a client deciding which entry to correct.
			// The path is delimited with backticks, not %q: paths now carry
			// quote characters of their own, and %q escapes them into
			// something the author cannot paste back.
			return fmt.Errorf("fields[%d] (label %q) has an unusable path `%s`: %w", i, f.Label, f.Path, err)
		}
	}
	return nil
}

// validatePath rejects a ui-spec path that Render could not use, or could use
// in a way the author did not mean.
//
// Canonical spelling is required, not merely accepted. The parser takes
// `spec["replicas"]` and `spec.replicas` as the same node, but Render looks a
// value up by exact string — `input[f.Path]` — so a values payload written with
// the other spelling misses, and the field silently falls back to its default
// while the deploy returns 201. One spelling per path removes the whole class,
// and it costs nothing: every generator already emits only this one.
func validatePath(path string) error {
	_, _, rest, err := parseHead(path)
	if err != nil {
		return err
	}
	segs, err := parsePathSegments(rest)
	if err != nil {
		return err
	}
	if len(segs) == 0 {
		return fmt.Errorf("path selects a whole resource; append the field to set, as in %s.spec.replicas", path)
	}
	canon, err := CanonicalPath(rest)
	if err != nil {
		return err
	}
	if canon != rest {
		return fmt.Errorf("path is not canonical: write it as `%s` (quote a key only when the bare form cannot express it)",
			strings.TrimSuffix(path, rest)+canon)
	}
	if reservedPath(canon) {
		return fmt.Errorf("path sets %s, which kubeport decides: a release's objects live in the release's namespace and keep the kind and apiVersion the template gives them (#137)", canon)
	}
	return nil
}

// reservedPath reports whether a canonical resource-relative path writes a
// field kubeport's release model depends on. An exposed field's value comes
// from whoever deploys, not from the template author.
//
// metadata.namespace matters most: an object sent to another namespace is
// orphaned as soon as it is applied, because deletion and status look only in
// the release's. kind and apiVersion change what is being applied at all, and
// setting `metadata` whole reaches the namespace by the back door. Templates
// saved before this check are still caught at deploy time, where CheckApply
// refuses a pinned namespace.
//
// metadata.name is deliberately not reserved. Exposing it is how a template
// lets two releases share a namespace, and the ownership check at deploy time
// (#161) is what makes a user-chosen name safe.
func reservedPath(canon string) bool {
	switch canon {
	case "kind", "apiVersion", "metadata", "metadata.namespace":
		return true
	}
	for _, prefix := range []string{"kind.", "apiVersion.", "metadata.namespace."} {
		if strings.HasPrefix(canon, prefix) {
			return true
		}
	}
	return false
}

func Render(resourcesYAML, uiSpecYAML string, values json.RawMessage, l Labels) ([]byte, error) {
	docs, err := parseMultiDoc(resourcesYAML)
	if err != nil {
		return nil, err
	}
	spec, err := parseSpec(uiSpecYAML)
	if err != nil {
		return nil, err
	}

	var input map[string]any
	if err := json.Unmarshal(values, &input); err != nil {
		return nil, fmt.Errorf("values not a JSON object: %w", err)
	}

	for _, f := range spec.Fields {
		raw, present := input[f.Path]
		if !present {
			if f.Required {
				return nil, fmt.Errorf("field %q required", f.Label)
			}
			if f.Default == nil {
				continue
			}
			raw = f.Default
		}
		if err := f.Validate(raw); err != nil {
			return nil, err
		}
		if err := setJSONPath(docs, f.Path, raw); err != nil {
			return nil, err
		}
	}

	for _, d := range docs {
		stringifyStringMaps(d)
		stampLabels(d, l)
	}

	return marshalMultiDoc(docs)
}

// stringifyStringMaps turns scalar values in the fields the API types as
// map[string]string into strings. A ui-spec field keeps its own type — a
// boolean for a feature flag, an integer for a port — which is right almost
// everywhere and wrong in exactly these maps: rendered as a YAML bool or number,
// the apiserver refuses the whole object at apply ("expected string").
// app-with-config exposes a boolean into ConfigMap data, so every deploy of it
// failed with a 502; it surfaced when #161 made it the demo's seed release.
//
// Only ConfigMap data and Secret stringData. Secret data is base64, where a
// stringified scalar would be a wrong value instead of a refused one, and
// binaryData is bytes. Scalars anywhere else keep their type.
func stringifyStringMaps(doc map[string]any) {
	var field string
	switch doc["kind"] {
	case "ConfigMap":
		field = "data"
	case "Secret":
		field = "stringData"
	default:
		return
	}
	m, ok := doc[field].(map[string]any)
	if !ok {
		return
	}
	for k, v := range m {
		switch v.(type) {
		case string, nil, map[string]any, []any:
			// Already a string, or null or a composite value: the template's own
			// mistake, left for the apiserver to name rather than guessed at.
		default:
			m[k] = fmt.Sprint(v)
		}
	}
}

func parseMultiDoc(src string) ([]map[string]any, error) {
	var docs []map[string]any
	dec := yaml.NewDecoder(bytes.NewReader([]byte(src)))
	for {
		m := map[string]any{}
		if err := dec.Decode(&m); err != nil {
			if err == io.EOF {
				break
			}
			return nil, err
		}
		if len(m) > 0 {
			docs = append(docs, m)
		}
	}
	return docs, nil
}

func marshalMultiDoc(docs []map[string]any) ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	for _, d := range docs {
		if err := enc.Encode(d); err != nil {
			return nil, err
		}
	}
	_ = enc.Close()
	return buf.Bytes(), nil
}

func stampLabels(obj map[string]any, l Labels) {
	meta := ensureMap(obj, "metadata")
	stampLabelsOnto(meta, l)
	anns := ensureMap(meta, "annotations")
	anns["kubeport.io/release-id"] = l.ReleaseID
	anns["kubeport.io/applied-by"] = l.AppliedBy
	anns["kubeport.io/applied-at"] = time.Now().UTC().Format(time.RFC3339)

	// Propagate labels to pod template metadata so runtime pods carry
	// kubeport.io/release — otherwise release status (which queries pods by
	// this label) returns 0 instances even when the Deployment is healthy.
	if spec, ok := obj["spec"].(map[string]any); ok {
		if tmpl, ok := spec["template"].(map[string]any); ok {
			stampLabelsOnto(ensureMap(tmpl, "metadata"), l)
		}
		// CronJob nests pod template under spec.jobTemplate.spec.template
		if jobTmpl, ok := spec["jobTemplate"].(map[string]any); ok {
			if jobSpec, ok := jobTmpl["spec"].(map[string]any); ok {
				if tmpl, ok := jobSpec["template"].(map[string]any); ok {
					stampLabelsOnto(ensureMap(tmpl, "metadata"), l)
				}
			}
		}
	}
}

// stampLabelsOnto writes kubeport-owned labels into meta. Reserved keys under
// the kubeport.io/ prefix intentionally overwrite any user-provided values —
// templates should not try to set these themselves.
func stampLabelsOnto(meta map[string]any, l Labels) {
	lbls := ensureMap(meta, "labels")
	lbls["kubeport.io/managed"] = "true"
	lbls["kubeport.io/release"] = l.ReleaseName
	lbls["kubeport.io/template"] = l.TemplateName
	lbls["kubeport.io/template-version"] = fmt.Sprintf("%d", l.TemplateVersion)
}
