package template

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
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
	for _, f := range spec.Fields {
		if _, _, rest, err := parseHead(f.Path); err != nil {
			return fmt.Errorf("field %q: %w", f.Label, err)
		} else if _, err := parsePathSegments(rest); err != nil {
			return fmt.Errorf("field %q has an unusable path %q: %w", f.Label, f.Path, err)
		}
	}
	return nil
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
		stampLabels(d, l)
	}

	return marshalMultiDoc(docs)
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
