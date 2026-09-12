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

// PathHead is the kind a ui-spec path points into and the first key under that
// resource, read by the same grammar that applies the path; ok is false for a
// path that grammar refuses. key is "" when the path addresses the resource
// itself or starts with an index. Callers that act on where a path points —
// redacting a Secret's data (#196) — ask it rather than re-parsing, so they
// follow the grammar when it changes.
func PathHead(p string) (kind, key string, ok bool) {
	kind, _, rest, err := parseHead(p)
	if err != nil {
		return "", "", false
	}
	segs, err := parsePathSegments(rest)
	if err != nil {
		return "", "", false
	}
	if len(segs) > 0 && !segs[0].arr {
		key = segs[0].key
	}
	return kind, key, true
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

// maxPathDepth bounds how many segments one path may hold.
//
// Depth is its own amplifier, separate from the container budget in
// uimode.go, and it is quadratic twice over:
//
//   - CanonicalPath rebuilds the path a segment at a time with JoinPath, and
//     each step copies the prefix. Refusing a 400KB path AFTER parsing it cost
//     41GB of allocation, measured — the refusal was the denial of service.
//   - The YAML encoder indents, so a document nested N deep writes ~N² bytes.
//     8000 plain segments is only 8000 containers, well inside the container
//     budget, and still produced 64MB of resources.yaml from 16KB of path.
//
// So the limit belongs here, in the one tokenizer every path goes through
// (CanonicalPath, setInto's render walk, setJSONPathAbsolute), and it is
// checked while scanning rather than after, so an abusive path never gets its
// segment slice built at all.
//
// 128 is an order of magnitude past real manifests: the deepest field anyone
// writes runs about nine segments, as in
// spec.template.spec.containers[0].env[0].valueFrom.secretKeyRef.name.
const maxPathDepth = 128

var plainSegRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*`)

func isDecimalDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

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
		if len(segs) >= maxPathDepth {
			return nil, fmt.Errorf(
				"path is deeper than %d levels: %.60q…; a manifest field is about nine deep",
				maxPathDepth, path)
		}
		if rest[0] == '[' {
			if len(rest) > 1 && (rest[1] == '"' || rest[1] == '\'') {
				quote := rest[1]
				end := strings.IndexByte(rest[2:], quote)
				if end < 0 {
					return nil, fmt.Errorf(`unterminated quoted segment in %q: add the closing quote and "]"`, rest)
				}
				key, after := rest[2:2+end], rest[2+end+1:]
				if !strings.HasPrefix(after, "]") {
					return nil, fmt.Errorf(`expected ] after quoted segment in %q: a quoted key is written ["key"]`, rest)
				}
				segs = append(segs, pathSeg{key: key})
				rest = strings.TrimPrefix(after[1:], ".")
				continue
			}
			end := strings.IndexByte(rest, ']')
			if end < 0 {
				return nil, fmt.Errorf("unterminated index in %q", rest)
			}
			body := rest[1:end]
			// Decimal digits only, checked before Atoi rather than after:
			// Atoi accepts a leading sign, so `[+1]` would parse here while
			// template-path.ts (`/^\d+$/`) rejects it. A path that validates
			// on one side and not the other is the differential this mirror
			// exists to prevent.
			if !isDecimalDigits(body) {
				return nil, fmt.Errorf("bad array index %q", body)
			}
			idx, err := strconv.Atoi(body)
			if err != nil {
				return nil, fmt.Errorf("bad array index %q", body)
			}
			// Unreachable given the digit check, kept because
			// setJSONPathAbsolute grows arrays and guards only the upper
			// bound — a negative index would reach an indexing expression.
			if idx < 0 {
				return nil, fmt.Errorf("negative array index %d", idx)
			}
			segs = append(segs, pathSeg{idx: idx, arr: true})
			rest = strings.TrimPrefix(rest[end+1:], ".")
			continue
		}
		name := plainSegRE.FindString(rest)
		if name == "" {
			// Name the remedy, not just the offending text. The caller is
			// usually an admin or an agent that has never seen this grammar,
			// and "bad path remainder \"/name\"" invites deleting the `/name`
			// — which silently addresses a different key.
			return nil, fmt.Errorf(
				"bad path remainder %q: a bare segment may hold only [A-Za-z0-9_]; "+
					"quote a key containing `.`, `-` or `/`, as in %s",
				rest, FormatSegment(rest))
		}
		segs = append(segs, pathSeg{key: name})
		rest = strings.TrimPrefix(rest[len(name):], ".")
	}
	return segs, nil
}

// Addressable reports whether key can be written as a path segment at all.
//
// With no escape character, a key is quoted with whichever style it does not
// contain — so a key containing BOTH is unrepresentable. Kubernetes keys can
// hold neither quote, but ConfigMap data keys and CRD fields are unconstrained,
// so the case is reachable and has to be refused where it is understood rather
// than emitted as a path that will not parse back.
func Addressable(key string) bool {
	return !strings.Contains(key, `"`) || !strings.Contains(key, "'")
}

// FormatSegment renders a map key as a path segment, quoting it only when the
// bare form cannot express it. It is the inverse of parsePathSegments for every
// key Addressable accepts, and the definition the frontend's template-path.ts
// mirrors — anything generating a path must go through here, or it can emit
// paths this package cannot read.
//
// An unaddressable key yields "", which JoinPath and the generators surface as
// an error. Returning a broken path would be worse: it parses as something
// else, or not at all, a long way from the key that caused it.
func FormatSegment(key string) string {
	if plainSegRE.FindString(key) == key && key != "" {
		return key
	}
	if !Addressable(key) {
		return ""
	}
	quote := byte('"')
	if strings.ContainsRune(key, '"') {
		quote = '\''
	}
	return "[" + string(quote) + key + string(quote) + "]"
}

// JoinPath appends key to prefix, quoting the key when necessary. A bracketed
// segment is self-delimiting, so it takes no separating dot. Returns an error
// for a key FormatSegment cannot express.
func JoinPath(prefix, key string) (string, error) {
	seg := FormatSegment(key)
	if seg == "" {
		return "", fmt.Errorf("key %q holds both quote styles and cannot be written as a path segment", key)
	}
	if prefix == "" {
		return seg, nil
	}
	if strings.HasPrefix(seg, "[") {
		return prefix + seg, nil
	}
	return prefix + "." + seg, nil
}

// CanonicalPath re-spells a resource-relative path in the one form the
// generators emit, so that two spellings of the same path compare equal.
//
// The tokenizer accepts more than FormatSegment produces — `['a']` for
// `["a"]`, `["replicas"]` for `replicas` — which is right for input and wrong
// for a map key. Field paths ARE map keys here, so without this two entries
// can describe the same document location and the later write wins at random.
func CanonicalPath(path string) (string, error) {
	segs, err := parsePathSegments(path)
	if err != nil {
		return "", err
	}
	var out string
	for _, s := range segs {
		if s.arr {
			out += "[" + strconv.Itoa(s.idx) + "]"
			continue
		}
		if out, err = JoinPath(out, s.key); err != nil {
			return "", err
		}
	}
	return out, nil
}

func setInto(node any, rest string, v any) error {
	segs, err := parsePathSegments(rest)
	if err != nil {
		return err
	}
	// Matches setJSONPathAbsolute, which has always rejected this. Without the
	// guard `Deployment[web]` — a path naming a resource and no field — walked
	// zero segments and returned nil, so the user's value vanished and the
	// deploy reported success.
	if len(segs) == 0 {
		return fmt.Errorf("path selects a whole resource, not a field")
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
