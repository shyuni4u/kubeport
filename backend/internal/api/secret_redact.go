package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"gopkg.in/yaml.v3"
)

// redactedSecret stands in for a Secret's value wherever a release is read
// back (#196). The cluster's RBAC decides who reads a Secret; the demo Role
// lets a visitor write Secrets and deliberately not read them back, and a
// self-hosted kubeport-admin need not be able to either. Handing the stored
// values out of kubeport's own database would read around that.
const redactedSecret = "<redacted>"

// isSecretPath reports whether a ui-spec path points into a Secret, whose value
// is the Secret's content. The path's head is its kind, then either a selector
// in brackets or nothing at all — `Secret.stringData.KEY` names the template's
// only Secret (template.parseHead) — so the kind has to end at "[", "." or the
// end of the path; `SecretStore[x]` is another kind (codex review).
func isSecretPath(path string) bool {
	const kind = "Secret"
	if !strings.HasPrefix(path, kind) {
		return false
	}
	rest := path[len(kind):]
	return rest == "" || rest[0] == '[' || rest[0] == '.'
}

// redactRenderedSecrets returns rendered with every value under a Secret's
// data and stringData replaced by redactedSecret. YAML that does not decode is
// returned as "": what cannot be read cannot be told apart from a Secret.
func redactRenderedSecrets(rendered string) string {
	dec := yaml.NewDecoder(strings.NewReader(rendered))
	var out bytes.Buffer
	enc := yaml.NewEncoder(&out)
	enc.SetIndent(2)
	for {
		var doc yaml.Node
		if err := dec.Decode(&doc); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return ""
		}
		redactSecretDocument(&doc)
		if err := enc.Encode(&doc); err != nil {
			return ""
		}
	}
	if err := enc.Close(); err != nil {
		return ""
	}
	return out.String()
}

func redactSecretDocument(doc *yaml.Node) {
	root := doc
	if root.Kind == yaml.DocumentNode {
		if len(root.Content) != 1 {
			return
		}
		root = root.Content[0]
	}
	if root.Kind != yaml.MappingNode {
		return
	}
	if kind := mappingValue(root, "kind"); kind == nil || kind.Value != "Secret" {
		return
	}
	for i := 0; i+1 < len(root.Content); i += 2 {
		switch root.Content[i].Value {
		case "data", "stringData":
		default:
			continue
		}
		v := root.Content[i+1]
		if v.Kind != yaml.MappingNode {
			root.Content[i+1] = redactedNode()
			continue
		}
		for j := 1; j < len(v.Content); j += 2 {
			v.Content[j] = redactedNode()
		}
	}
}

func mappingValue(m *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

func redactedNode() *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: redactedSecret}
}

// redactSecretValues returns values with the value of every Secret path
// replaced by redactedSecret. Values that are not a JSON object carry no path
// and are returned as they are.
func redactSecretValues(values json.RawMessage) json.RawMessage {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(values, &m); err != nil {
		return values
	}
	changed := false
	for k := range m {
		if isSecretPath(k) {
			m[k] = json.RawMessage(`"` + redactedSecret + `"`)
			changed = true
		}
	}
	if !changed {
		return values
	}
	out, err := json.Marshal(m)
	if err != nil {
		return values
	}
	return out
}

// restoreRedactedSecrets puts back the stored value of every Secret path that
// next sends as redactedSecret — a form filled from the release's own
// redacted read, submitted without touching that field — so an update does
// not overwrite a Secret with the placeholder. A Secret path with no stored
// value is dropped, leaving the template's default. Values that are not a
// JSON object are returned as they are, for the update's own validation.
func restoreRedactedSecrets(next, previous json.RawMessage) json.RawMessage {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(next, &m); err != nil {
		return next
	}
	var prev map[string]json.RawMessage
	_ = json.Unmarshal(previous, &prev)
	changed := false
	for k, v := range m {
		if !isSecretPath(k) {
			continue
		}
		var s string
		if json.Unmarshal(v, &s) != nil || s != redactedSecret {
			continue
		}
		if old, ok := prev[k]; ok {
			m[k] = old
		} else {
			delete(m, k)
		}
		changed = true
	}
	if !changed {
		return next
	}
	out, err := json.Marshal(m)
	if err != nil {
		return next
	}
	return out
}
