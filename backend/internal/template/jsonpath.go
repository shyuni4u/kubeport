package template

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// setJSONPath mutates docs in place to assign v at path.
// Path grammar:
//
//	Kind[selector] ("." ? segment)*
//	selector ::= INT | NAME
//	segment  ::= NAME | "[" INT "]" | "[" QUOTED "]"
//	NAME     ::= [A-Za-z_][A-Za-z0-9_]*
//	QUOTED   ::= '"' [^"]* '"' | "'" [^']* "'"
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

// The selector is an index or a metadata.name (DNS-1123: lowercase
// alphanumerics, `-` and `.`), so it can never open with a quote. Excluding
// that one character is what keeps `Kind["some.key"]` — a quoted first
// segment on a resource whose top-level key needs quoting — from being read
// as a resource selector named `"some.key"`.
var headRE = regexp.MustCompile(`^([A-Z][A-Za-z]+)(?:\[([^"'\]][^\]]*)\])?(.*)$`)

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

// pathSeg is one step of a resource-relative path: a map key or an array index.
type pathSeg struct {
	key string
	idx int
	arr bool
}

var plainSegRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*`)

// parsePathSegments tokenizes the part of a path that follows Kind[selector].
//
// NAME covers the Go-identifier-shaped keys that make up most of a manifest,
// and deliberately does not cover `.`, `-` or `/` — all three are legal in a
// Kubernetes map key. Widening the class cannot fix that, because `.` is this
// grammar's own separator: given metadata.labels.app.kubernetes.io/name there
// is no way to know whether that tail is one key or four. Accepting `/` alone
// would turn today's loud 400 into a document with app→kubernetes→io/name
// nested three deep, which is worse — the render succeeds and is wrong.
//
// QUOTED is how the caller says which, and it is why `app.kubernetes.io/name`
// (the recommended-label standard, so the more correct a manifest is the more
// likely it hits this) is addressable at all. See issue #129.
//
// Both quote styles are accepted and there is no escape character: a key
// containing one style is written with the other. Kubernetes keys can contain
// neither, but ConfigMap data keys and CRD fields are less constrained.
func parsePathSegments(path string) ([]pathSeg, error) {
	var segs []pathSeg
	rest := path
	for rest != "" {
		if rest[0] == '[' {
			if len(rest) > 1 && (rest[1] == '"' || rest[1] == '\'') {
				quote := rest[1]
				end := strings.IndexByte(rest[2:], quote)
				if end < 0 {
					return nil, fmt.Errorf("unterminated quoted segment in %q", rest)
				}
				key, after := rest[2:2+end], rest[2+end+1:]
				if !strings.HasPrefix(after, "]") {
					return nil, fmt.Errorf("expected ] after quoted segment in %q", rest)
				}
				segs = append(segs, pathSeg{key: key})
				rest = strings.TrimPrefix(after[1:], ".")
				continue
			}
			end := strings.IndexByte(rest, ']')
			if end < 0 {
				return nil, fmt.Errorf("unterminated index in %q", rest)
			}
			idx, err := strconv.Atoi(rest[1:end])
			if err != nil {
				return nil, fmt.Errorf("bad array index %q", rest[1:end])
			}
			// Rejected here rather than at each use: setJSONPathAbsolute grows
			// arrays and only guards the upper bound, so a negative index
			// reaches an indexing expression and panics.
			if idx < 0 {
				return nil, fmt.Errorf("negative array index %d", idx)
			}
			segs = append(segs, pathSeg{idx: idx, arr: true})
			rest = strings.TrimPrefix(rest[end+1:], ".")
			continue
		}
		name := plainSegRE.FindString(rest)
		if name == "" {
			return nil, fmt.Errorf("bad path remainder %q", rest)
		}
		segs = append(segs, pathSeg{key: name})
		rest = strings.TrimPrefix(rest[len(name):], ".")
	}
	return segs, nil
}

// FormatSegment renders a map key as a path segment, quoting it only when the
// bare form cannot express it. It is the inverse of parsePathSegments and the
// definition the frontend's template-path.ts mirrors — anything that generates
// a path must go through here, or it can emit paths this package cannot read.
func FormatSegment(key string) string {
	if plainSegRE.FindString(key) == key && key != "" {
		return key
	}
	quote := byte('"')
	if strings.ContainsRune(key, '"') {
		quote = '\''
	}
	return "[" + string(quote) + key + string(quote) + "]"
}

// JoinPath appends key to prefix, quoting the key when necessary. A bracketed
// segment is self-delimiting, so it takes no separating dot.
func JoinPath(prefix, key string) string {
	seg := FormatSegment(key)
	if prefix == "" {
		return seg
	}
	if strings.HasPrefix(seg, "[") {
		return prefix + seg
	}
	return prefix + "." + seg
}

func setInto(node any, rest string, v any) error {
	segs, err := parsePathSegments(rest)
	if err != nil {
		return err
	}
	for i, s := range segs {
		last := i == len(segs)-1
		if !s.arr {
			obj, ok := node.(map[string]any)
			if !ok {
				return fmt.Errorf("not a map at %q", s.key)
			}
			if last {
				obj[s.key] = v
				return nil
			}
			if _, exists := obj[s.key]; !exists {
				// Whether the next step is an array is a property of the
				// parsed segment, not of the raw text: a quoted key also
				// starts with '[', so testing the string would misread
				// labels["app.kubernetes.io/name"] as an array.
				if segs[i+1].arr {
					return fmt.Errorf("cannot auto-create array at %q: add the field to the template", s.key)
				}
				obj[s.key] = map[string]any{}
			}
			node = obj[s.key]
		} else {
			arr, ok := node.([]any)
			if !ok {
				return fmt.Errorf("not an array at [%d]", s.idx)
			}
			if s.idx >= len(arr) {
				return fmt.Errorf("index %d out of range (len=%d)", s.idx, len(arr))
			}
			if last {
				arr[s.idx] = v
				return nil
			}
			node = arr[s.idx]
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
