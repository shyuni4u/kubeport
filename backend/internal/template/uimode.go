package template

import (
	"bytes"
	"fmt"

	"gopkg.in/yaml.v3"
)

// maxArrayIndex caps auto-grown array length in setJSONPathAbsolute to guard
// against malicious paths like containers[99999999] causing OOM. Any realistic
// k8s resource has far fewer array elements at a single path (Deployments have
// a handful of containers, Services a handful of ports, etc.).
//
// It bounds ONE array segment, which is not the same as bounding a request —
// see maxNewContainers.
const maxArrayIndex = 1024

// maxNewContainers bounds how many containers — intermediate maps, and array
// slots auto-grown to reach an index — one SerializeUIMode call may create.
//
// maxArrayIndex alone left a hole the size of a multiplication. A path may
// hold as many array segments as it likes; each one grows a fresh 1025-slot
// slice and fills every slot with a placeholder, while the walk descends into
// exactly one of them. Cost multiplies down the path, path text grows by 8
// bytes a step, and plain segments amplify too — every one of them creates a
// map. Measured in this package before this limit existed:
//
//	a[1024]. × 100    801 B of path    196 MB left on the heap
//	a[1024]. × 500      4 KB of path   1.9 GB, ~8 s of CPU
//	a.       × 10000   20 KB of path    326 MB — no array index at all
//
// The backend runs one replica under a 256Mi limit, so a request of a few
// hundred bytes was enough to take the deployment down, and the 4MiB body cap
// did not narrow it: the amplification is ~244,000:1.
//
// The budget is per CALL rather than per field or per resource. A per-field
// allowance multiplies straight back up by the number of fields a 4MiB body
// can carry.
//
// 8192 is ~2.5× the containers in a deliberately oversized real manifest (5
// resources × 10 containers × 50 env vars, in budget_test.go). It also bounds
// the cost of REFUSING: the walk stops at the budget, so an abusive path
// allocates the budget's worth and not the path's.
const maxNewContainers = 8192

// (maxPathDepth, the other half of this guard, lives with the tokenizer in
// jsonpath.go — it has to bite while parsing, before anything walks a path.)

// containerBudget is the per-call allowance, spent by setJSONPathAbsolute.
type containerBudget struct{ left int }

// spend charges n containers, reporting the path that ran the budget out
// rather than a bare limit — with a whole template in the body, which path is
// the expensive one is not otherwise visible to the admin who has to fix it.
func (b *containerBudget) spend(n int, path string) error {
	b.left -= n
	if b.left < 0 {
		return fmt.Errorf(
			"template creates too many nested objects (limit %d per request); "+
				"path %q reaches far deeper or further into an array than a manifest needs",
			maxNewContainers, path)
	}
	return nil
}

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

	// One allowance for the whole call — see maxNewContainers. Declared out
	// here rather than inside the resource loop on purpose: a per-resource
	// budget would multiply by the number of resources in the body.
	budget := &containerBudget{left: maxNewContainers}

	for _, r := range ui.Resources {
		if r.APIVersion == "" || r.Kind == "" || r.Name == "" {
			return "", "", fmt.Errorf("resource missing apiVersion/kind/name")
		}
		doc := map[string]any{
			"apiVersion": r.APIVersion,
			"kind":       r.Kind,
			"metadata":   map[string]any{"name": r.Name},
		}
		// Two field paths that canonicalize to the same location would both be
		// written into the same key, and Go's map iteration order decides
		// which value survives. Refuse rather than save something the admin
		// cannot predict — the editor cannot produce this, but the API takes a
		// UIModeTemplate directly.
		canon := make(map[string]string, len(r.Fields))
		for fpath := range r.Fields {
			c, err := CanonicalPath(fpath)
			if err != nil {
				return "", "", fmt.Errorf("resource %s/%s field %q: %w", r.Kind, r.Name, fpath, err)
			}
			if prev, dup := canon[c]; dup {
				return "", "", fmt.Errorf("resource %s/%s: fields %q and %q address the same path", r.Kind, r.Name, prev, fpath)
			}
			canon[c] = fpath
		}

		for fpath, f := range r.Fields {
			switch f.Mode {
			case "fixed":
				if err := setJSONPathAbsolute(doc, fpath, f.FixedValue, budget); err != nil {
					return "", "", fmt.Errorf("resource %s/%s field %q: %w", r.Kind, r.Name, fpath, err)
				}
			case "exposed":
				if f.UISpec == nil {
					return "", "", fmt.Errorf("exposed field %q missing ui-spec", fpath)
				}
				if f.UISpec.Default != nil {
					if err := setJSONPathAbsolute(doc, fpath, f.UISpec.Default, budget); err != nil {
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
// Every container it creates is charged to budget, which is shared across the
// whole SerializeUIMode call.
func setJSONPathAbsolute(obj map[string]any, path string, v any, budget *containerBudget) error {
	// One tokenizer, shared with jsonpath.go. The two used to carry separate
	// copies of the same regex, which is why issue #129's bug existed twice:
	// this function generates the paths that setInto then has to read back.
	segs, err := parsePathSegments(path)
	if err != nil {
		return err
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
				// A plain segment amplifies too, one map per step, which is
				// why the budget is not limited to array growth.
				if err := budget.spend(1, path); err != nil {
					return err
				}
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
				// Charge every slot, not just the one descended into: the
				// others are filled with placeholders below and stay attached
				// to the document for the rest of the request.
				if err := budget.spend(s.idx+1-len(arr), path); err != nil {
					return err
				}
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
				// A slot left empty by an earlier trailing write; growing it
				// was charged, the container going into it now was not.
				if err := budget.spend(1, path); err != nil {
					return err
				}
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
