package template

import (
	"bytes"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// maxArrayIndex caps auto-grown array length in setJSONPathAbsolute to guard
// against malicious paths like containers[99999999] causing OOM. Any realistic
// k8s resource has far fewer array elements at a single path (Deployments have
// a handful of containers, Services a handful of ports, etc.).
const maxArrayIndex = 1024

type UIModeTemplate struct {
	Resources []UIResource `json:"resources"`
}

type UIResource struct {
	APIVersion string             `json:"apiVersion"`
	Kind       string             `json:"kind"`
	Name       string             `json:"name"`
	Fields     map[string]UIField `json:"fields"` // key = JSON path within the resource, NO Kind[name] prefix
}

type UIField struct {
	Mode       string       `json:"mode"` // "fixed" | "exposed"
	FixedValue any          `json:"fixedValue,omitempty"`
	UISpec     *UISpecEntry `json:"uiSpec,omitempty"`
}

type UISpecEntry struct {
	Path     string   `yaml:"path"     json:"path"`
	Label    string   `yaml:"label"    json:"label"`
	Help     string   `yaml:"help,omitempty"    json:"help,omitempty"`
	Type     string   `yaml:"type"     json:"type"`
	Min      *int     `yaml:"min,omitempty"     json:"min,omitempty"`
	Max      *int     `yaml:"max,omitempty"     json:"max,omitempty"`
	Pattern  string   `yaml:"pattern,omitempty" json:"pattern,omitempty"`
	Values   []string `yaml:"values,omitempty"  json:"values,omitempty"`
	Default  any      `yaml:"default,omitempty" json:"default,omitempty"`
	Required bool     `yaml:"required,omitempty" json:"required,omitempty"`
}

// SerializeUIMode converts the UI editor state into the resources + ui-spec
// YAML pair that the Plan 1 render pipeline understands.
func SerializeUIMode(ui UIModeTemplate) (resourcesYAML, uiSpecYAML string, err error) {
	var resBuf bytes.Buffer
	enc := yaml.NewEncoder(&resBuf)
	enc.SetIndent(2)

	var allFields []UISpecEntry

	for _, r := range ui.Resources {
		if r.APIVersion == "" || r.Kind == "" || r.Name == "" {
			return "", "", fmt.Errorf("resource missing apiVersion/kind/name")
		}
		doc := map[string]any{
			"apiVersion": r.APIVersion,
			"kind":       r.Kind,
			"metadata":   map[string]any{"name": r.Name},
		}
		for fpath, f := range r.Fields {
			switch f.Mode {
			case "fixed":
				if err := setJSONPathAbsolute(doc, fpath, f.FixedValue); err != nil {
					return "", "", fmt.Errorf("resource %s/%s field %q: %w", r.Kind, r.Name, fpath, err)
				}
			case "exposed":
				if f.UISpec == nil {
					return "", "", fmt.Errorf("exposed field %q missing ui-spec", fpath)
				}
				if f.UISpec.Default != nil {
					if err := setJSONPathAbsolute(doc, fpath, f.UISpec.Default); err != nil {
						return "", "", fmt.Errorf("default for %q: %w", fpath, err)
					}
				}
				entry := *f.UISpec
				entry.Path = r.Kind + "[" + r.Name + "]." + fpath
				allFields = append(allFields, entry)
			default:
				return "", "", fmt.Errorf("unknown field mode %q", f.Mode)
			}
		}
		if err := enc.Encode(doc); err != nil {
			return "", "", err
		}
	}
	_ = enc.Close()

	if allFields == nil {
		allFields = []UISpecEntry{}
	}
	spec := map[string]any{"fields": allFields}
	uiBytes, err := yaml.Marshal(spec)
	if err != nil {
		return "", "", err
	}

	return resBuf.String(), string(uiBytes), nil
}

// setJSONPathAbsolute writes v at dotted/indexed path into obj, creating any
// intermediate maps/arrays as needed. The grammar matches jsonpath.go's
// setInto ("a.b[0].c") but, unlike that function, this helper auto-creates
// arrays when the path references an index past the current length — Plan 1's
// renderer refuses to do this on purpose (templates must declare arrays up
// front), but here we're generating a fresh document from scratch so the
// array is expected to be created on demand.
func setJSONPathAbsolute(obj map[string]any, path string, v any) error {
	// Tokenize the path into segments: either a map key or an array index.
	type seg struct {
		key string // set when segment is a map key
		idx int    // set when segment is an array index
		arr bool   // true if array segment
	}
	var segs []seg
	rest := path
	for rest != "" {
		m := uimodeSegRE.FindStringSubmatch(rest)
		if m == nil {
			return fmt.Errorf("bad path remainder %q", rest)
		}
		rest = strings.TrimPrefix(rest[len(m[0]):], ".")
		if m[1] != "" {
			segs = append(segs, seg{key: m[1]})
		} else {
			n, _ := strconv.Atoi(m[2])
			segs = append(segs, seg{idx: n, arr: true})
		}
	}
	if len(segs) == 0 {
		return fmt.Errorf("empty path")
	}
	// Walk with parent/setter closures so we can grow slices (which are
	// value types — growing in place is impossible, we have to reassign
	// into the parent container).
	var setParent func(any)
	var current any = obj
	setParent = func(x any) { /* root — no parent; obj is mutated in place */ }
	for i, s := range segs {
		last := i == len(segs)-1
		if !s.arr {
			mp, ok := current.(map[string]any)
			if !ok {
				return fmt.Errorf("not a map at %q", s.key)
			}
			if last {
				mp[s.key] = v
				return nil
			}
			next := segs[i+1]
			child, exists := mp[s.key]
			if !exists {
				if next.arr {
					child = []any{}
				} else {
					child = map[string]any{}
				}
				mp[s.key] = child
			}
			key := s.key
			parentMap := mp
			setParent = func(x any) { parentMap[key] = x }
			current = mp[s.key]
		} else {
			arr, ok := current.([]any)
			if !ok {
				return fmt.Errorf("not an array at [%d]", s.idx)
			}
			if s.idx > maxArrayIndex {
				return fmt.Errorf("array index %d exceeds limit %d", s.idx, maxArrayIndex)
			}
			if s.idx >= len(arr) {
				grown := make([]any, s.idx+1)
				copy(grown, arr)
				// New slots get container placeholders if another segment
				// will descend into them; trailing writes (last) leave nil
				// because the index s.idx is assigned below.
				if !last {
					next := segs[i+1]
					for j := len(arr); j <= s.idx; j++ {
						if next.arr {
							grown[j] = []any{}
						} else {
							grown[j] = map[string]any{}
						}
					}
				}
				arr = grown
			}
			if last {
				arr[s.idx] = v
				setParent(arr)
				return nil
			}
			// Ensure the existing slot has the right container type for the
			// next segment.
			next := segs[i+1]
			if arr[s.idx] == nil {
				if next.arr {
					arr[s.idx] = []any{}
				} else {
					arr[s.idx] = map[string]any{}
				}
			}
			setParent(arr) // persist any growth
			idx := s.idx
			parentArr := arr
			setParent = func(x any) { parentArr[idx] = x }
			current = arr[s.idx]
		}
	}
	return nil
}

var uimodeSegRE = regexp.MustCompile(`^(?:([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\])`)
