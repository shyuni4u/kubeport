package template

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// setJSONPath mutates docs in place to assign v at path.
// Path grammar (minimal, MVP):
//
//	Kind[selector] (".prop" | "[" INT "]")*
//	selector ::= INT | NAME
func setJSONPath(docs []map[string]any, path string, v any) error {
	kind, selector, rest, err := parseHead(path)
	if err != nil {
		return err
	}
	target, err := findDoc(docs, kind, selector)
	if err != nil {
		return err
	}
	return setInto(target, rest, v)
}

var headRE = regexp.MustCompile(`^([A-Z][A-Za-z]+)(?:\[([^\]]+)\])?(.*)$`)

func parseHead(p string) (string, string, string, error) {
	m := headRE.FindStringSubmatch(p)
	if m == nil {
		return "", "", "", fmt.Errorf("path %q invalid", p)
	}
	return m[1], m[2], strings.TrimPrefix(m[3], "."), nil
}

func findDoc(docs []map[string]any, kind, selector string) (map[string]any, error) {
	var matches []map[string]any
	for _, d := range docs {
		if d["kind"] == kind {
			matches = append(matches, d)
		}
	}
	if selector == "" && len(matches) == 1 {
		return matches[0], nil
	}
	if idx, err := strconv.Atoi(selector); err == nil && idx >= 0 && idx < len(matches) {
		return matches[idx], nil
	}
	for _, d := range matches {
		meta, _ := d["metadata"].(map[string]any)
		if meta != nil && meta["name"] == selector {
			return d, nil
		}
	}
	return nil, fmt.Errorf("no %s matching %q", kind, selector)
}

var segRE = regexp.MustCompile(`^(?:([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\])`)

func setInto(node any, rest string, v any) error {
	for rest != "" {
		m := segRE.FindStringSubmatch(rest)
		if m == nil {
			return fmt.Errorf("bad path remainder %q", rest)
		}
		rest = strings.TrimPrefix(rest[len(m[0]):], ".")
		if m[1] != "" {
			obj, ok := node.(map[string]any)
			if !ok {
				return fmt.Errorf("not a map at %q", m[1])
			}
			if rest == "" {
				obj[m[1]] = v
				return nil
			}
			if _, exists := obj[m[1]]; !exists {
				if strings.HasPrefix(rest, "[") {
					return fmt.Errorf("cannot auto-create array at %q: add the field to the template", m[1])
				}
				obj[m[1]] = map[string]any{}
			}
			node = obj[m[1]]
		} else {
			idx, _ := strconv.Atoi(m[2])
			arr, ok := node.([]any)
			if !ok {
				return fmt.Errorf("not an array at [%d]", idx)
			}
			if idx < 0 || idx >= len(arr) {
				return fmt.Errorf("index %d out of range (len=%d)", idx, len(arr))
			}
			if rest == "" {
				arr[idx] = v
				return nil
			}
			node = arr[idx]
		}
	}
	return nil
}

func ensureMap(m map[string]any, key string) map[string]any {
	if v, ok := m[key].(map[string]any); ok {
		return v
	}
	nm := map[string]any{}
	m[key] = nm
	return nm
}
