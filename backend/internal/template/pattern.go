package template

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// A ui-spec pattern is checked twice: by Field.Validate on deploy, in Go RE2,
// and by the deploy form on every keystroke, as a JavaScript RegExp (no flags).
// checkPattern refuses, at save time, the patterns those two cannot agree on —
// and the ones the browser could hang on — so the admin hears about it while
// the template can still be fixed, rather than a user hearing about it from a
// 400 on deploy (#189) or a frozen tab (#187).
//
// frontend/lib/ui-spec-pattern.ts implements the same rules; the two test
// files share one case table. Change both together.

// maxPatternLength caps a pattern, counted in characters (code points, which
// is also what the frontend counts).
const maxPatternLength = 200

type patternProblem struct {
	// kind is "too-long", "dialect" or "nested-quantifier" — the names the
	// frontend uses for the same outcomes.
	kind string
	// reason completes the sentence "the pattern ...".
	reason string
}

func dialectProblem(format string, args ...any) *patternProblem {
	return &patternProblem{kind: "dialect", reason: fmt.Sprintf(format, args...)}
}

// charSet answers "could this atom match r?". It may say yes too often (an
// over-approximation is always safe here), never no too often.
type charSet func(rune) bool

func anyRune(rune) bool { return true }

type itemKind int

const (
	itemNone itemKind = iota // nothing a quantifier could apply to
	itemAssert
	itemAtom
	itemGroup
)

type patternItem struct {
	kind  itemKind
	set   charSet
	exact bool // set is exact, so a negated class may use it
	isLit bool
	lit   rune
	group *patternFrame
	first bool // the first item of its group's body
}

func literalItem(c rune) patternItem {
	return patternItem{kind: itemAtom, set: func(r rune) bool { return r == c }, exact: true, isLit: true, lit: c}
}

// patternFrame is one group's body (or the whole pattern).
type patternFrame struct {
	hasAlt          bool
	hasFirst        bool
	firstIsLit      bool
	firstLit        rune
	firstQuantified bool
	// unbounded holds every atom in the body, nested groups included, that
	// sits under `*`, `+` or `{n,}`.
	unbounded []charSet
}

// canBacktrackCatastrophically reports whether repeating this group can split
// one input many ways. That needs an unlimited repeat inside. It is ruled out
// when every repetition must open with the same literal that none of those
// inner repeats can match — `(-[a-z]+)*`, `(\.[a-z0-9]+)*` — because then each
// repetition starts at exactly one place.
func (f *patternFrame) canBacktrackCatastrophically() bool {
	if len(f.unbounded) == 0 {
		return false
	}
	if f.hasAlt || !f.firstIsLit || f.firstQuantified {
		return true
	}
	for _, set := range f.unbounded {
		if set(f.firstLit) {
			return true
		}
	}
	return false
}

// checkPattern returns nil for a pattern both engines read the same way and
// the browser can run without hanging. It is a scanner, not a parser: a
// pattern that does not compile is left for the compiler to report.
func checkPattern(p string) *patternProblem {
	if utf8.RuneCountInString(p) > maxPatternLength {
		return &patternProblem{kind: "too-long", reason: fmt.Sprintf("is longer than %d characters", maxPatternLength)}
	}
	s := []rune(p)
	n := len(s)
	stack := []*patternFrame{{}}
	names := map[string]bool{}
	var last patternItem

	emit := func(it patternItem) {
		top := stack[len(stack)-1]
		if !top.hasFirst {
			top.hasFirst = true
			top.firstIsLit, top.firstLit = it.isLit, it.lit
			it.first = true
		}
		last = it
	}
	quantify := func(repeats, unbounded bool) *patternProblem {
		it := last
		last = patternItem{}
		switch it.kind {
		case itemNone:
			return nil // `*` with nothing before it: both compilers refuse it
		case itemAssert:
			return dialectProblem("repeats `^`, `$`, `\\b` or `\\B`, which the browser refuses")
		}
		top := stack[len(stack)-1]
		if it.first {
			top.firstQuantified = true
		}
		if unbounded {
			top.unbounded = append(top.unbounded, it.set)
		}
		if it.kind == itemGroup && repeats && it.group.canBacktrackCatastrophically() {
			return &patternProblem{
				kind:   "nested-quantifier",
				reason: "repeats a group that itself holds an unlimited repeat, as in `(a+)+`; the deploy form runs the pattern in the browser on every keystroke, and this shape can freeze the page",
			}
		}
		return nil
	}

	for i := 0; i < n; {
		switch c := s[i]; c {
		case '\\':
			it, size, prob := scanEscape(s, i, false)
			if prob != nil || size == 0 {
				return prob
			}
			emit(it)
			i += size
		case '[':
			it, size, prob := scanClass(s, i)
			if prob != nil || size == 0 {
				return prob
			}
			emit(it)
			i += size
		case '(':
			size, prob := scanGroupOpen(s, i, names)
			if prob != nil || size == 0 {
				return prob
			}
			stack = append(stack, &patternFrame{})
			last = patternItem{}
			i += size
		case ')':
			if len(stack) == 1 {
				return nil
			}
			f := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			parent := stack[len(stack)-1]
			parent.unbounded = append(parent.unbounded, f.unbounded...)
			emit(patternItem{kind: itemGroup, set: anyRune, group: f})
			i++
		case '|':
			stack[len(stack)-1].hasAlt = true
			last = patternItem{}
			i++
		case '^', '$':
			emit(patternItem{kind: itemAssert})
			i++
		case '*', '+', '?':
			if prob := quantify(c != '?', c != '?'); prob != nil {
				return prob
			}
			i++
			if i < n && s[i] == '?' {
				i++
			}
		case '{':
			size, repeats, unbounded, prob := scanRepeat(s, i)
			if prob != nil {
				return prob
			}
			if size == 0 {
				emit(literalItem('{'))
				i++
				continue
			}
			if prob := quantify(repeats, unbounded); prob != nil {
				return prob
			}
			i += size
			if i < n && s[i] == '?' {
				i++
			}
		case '.':
			emit(patternItem{kind: itemAtom, set: anyRune})
			i++
		default:
			emit(literalItem(c))
			i++
		}
	}
	return nil
}

// scanEscape reads the escape at s[i] == '\\'. size 0 means the pattern ends
// there. Letters and digits are an allowlist: what is not on it either does not
// compile in Go or means something else in the browser (`\A`, `\z`, `\pL`,
// `\Q`, `\a`, `\1`), and the browser reads them all without complaint.
func scanEscape(s []rune, i int, inClass bool) (patternItem, int, *patternProblem) {
	n := len(s)
	if i+1 >= n {
		return patternItem{}, 0, nil
	}
	c := s[i+1]
	if c >= utf8.RuneSelf {
		return patternItem{}, 0, dialectProblem("uses `\\%c`, which the browser reads differently", c)
	}
	if !isASCIIAlnum(c) {
		return literalItem(c), 2, nil
	}
	switch c {
	case 'f':
		return literalItem('\f'), 2, nil
	case 'n':
		return literalItem('\n'), 2, nil
	case 'r':
		return literalItem('\r'), 2, nil
	case 't':
		return literalItem('\t'), 2, nil
	case 'v':
		return literalItem('\v'), 2, nil
	case '0':
		// Octal: both engines take up to two more octal digits.
		size := 2
		for size < 4 && i+size < n && s[i+size] >= '0' && s[i+size] <= '7' {
			size++
		}
		return patternItem{kind: itemAtom, set: anyRune}, size, nil
	case 'x':
		if i+3 < n && isHexDigit(s[i+2]) && isHexDigit(s[i+3]) {
			return literalItem(hexValue(s[i+2])<<4 | hexValue(s[i+3])), 4, nil
		}
		return patternItem{}, 0, dialectProblem("uses `\\x` without exactly two hex digits after it; `\\x{...}` is Go-only")
	case 'd':
		return patternItem{kind: itemAtom, set: isASCIIDigit, exact: true}, 2, nil
	case 'D':
		return patternItem{kind: itemAtom, set: func(r rune) bool { return !isASCIIDigit(r) }, exact: true}, 2, nil
	case 'w':
		return patternItem{kind: itemAtom, set: isASCIIWord, exact: true}, 2, nil
	case 'W':
		return patternItem{kind: itemAtom, set: func(r rune) bool { return !isASCIIWord(r) }, exact: true}, 2, nil
	case 's':
		// The browser's \s also takes Unicode spaces; say yes to all of those.
		return patternItem{kind: itemAtom, set: func(r rune) bool { return isASCIISpace(r) || r >= utf8.RuneSelf }}, 2, nil
	case 'S':
		return patternItem{kind: itemAtom, set: anyRune}, 2, nil
	case 'b', 'B':
		if !inClass {
			return patternItem{kind: itemAssert}, 2, nil
		}
	}
	return patternItem{}, 0, dialectProblem("uses `\\%c`, which the browser reads differently", c)
}

// scanClass reads the character class at s[i] == '['. size 0 means it is not
// closed.
func scanClass(s []rune, i int) (patternItem, int, *patternProblem) {
	n := len(s)
	j := i + 1
	negate := false
	if j < n && s[j] == '^' {
		negate = true
		j++
	}
	if j < n && s[j] == ']' {
		// Go takes a leading `]` as a member; the browser closes an empty class.
		return patternItem{}, 0, dialectProblem("starts a character class with `]`, which the browser reads as an empty class; write it as `\\]`")
	}
	member := func(j int) (patternItem, int, *patternProblem) {
		if s[j] == '\\' {
			return scanEscape(s, j, true)
		}
		return literalItem(s[j]), 1, nil
	}
	var parts []charSet
	exact := true
	for j < n && s[j] != ']' {
		// Go's rule: `[:` with a `:]` anywhere after it is a POSIX class (or
		// an error). The browser reads it as plain members.
		if s[j] == '[' && j+1 < n && s[j+1] == ':' && strings.Contains(string(s[j+2:]), ":]") {
			return patternItem{}, 0, dialectProblem("uses a POSIX class such as `[:alpha:]`, which the browser does not read")
		}
		lo, size, prob := member(j)
		if prob != nil || size == 0 {
			return patternItem{}, 0, prob
		}
		j += size
		if lo.isLit && j+1 < n && s[j] == '-' && s[j+1] != ']' {
			hi, size, prob := member(j + 1)
			if prob != nil || size == 0 {
				return patternItem{}, 0, prob
			}
			j += 1 + size
			if hi.isLit {
				from, to := lo.lit, hi.lit
				parts = append(parts, func(r rune) bool { return r >= from && r <= to })
			} else {
				parts, exact = append(parts, anyRune), false
			}
			continue
		}
		parts = append(parts, lo.set)
		exact = exact && lo.exact
	}
	if j >= n {
		return patternItem{}, 0, nil
	}
	set := func(r rune) bool {
		for _, part := range parts {
			if part(r) {
				return !negate
			}
		}
		return negate
	}
	if negate && !exact {
		set = anyRune
	}
	return patternItem{kind: itemAtom, set: set, exact: exact}, j + 1 - i, nil
}

// scanGroupOpen reads the group opening at s[i] == '(' and returns its length.
// size 0 means the pattern ends inside it.
func scanGroupOpen(s []rune, i int, names map[string]bool) (int, *patternProblem) {
	n := len(s)
	if i+1 >= n || s[i+1] != '?' {
		return 1, nil
	}
	if i+2 >= n {
		return 0, nil
	}
	switch s[i+2] {
	case ':':
		return 3, nil
	case '<':
		if i+3 < n && (s[i+3] == '=' || s[i+3] == '!') {
			return 0, dialectProblem("uses `(?<%c`, which Go does not support", s[i+3])
		}
		end := -1
		for j := i + 3; j < n; j++ {
			if s[j] == '>' {
				end = j
				break
			}
		}
		if end < 0 {
			return 0, nil
		}
		name := string(s[i+3 : end])
		if !validGroupName(name) {
			return 0, dialectProblem("names a group `%s`; a group name starts with a letter or underscore and has only letters, digits and underscores", name)
		}
		if names[name] {
			return 0, dialectProblem("names two groups `%s`, which the browser refuses", name)
		}
		names[name] = true
		return end + 1 - i, nil
	case 'P':
		return 0, dialectProblem("uses `(?P`; write a named group as `(?<name>...)`, which the browser also reads")
	default:
		return 0, dialectProblem("uses `(?%c`; the browser reads only `(?:` and `(?<name>` here, so flags such as `(?i)` cannot be used", s[i+2])
	}
}

// scanRepeat reads a counted repeat at s[i] == '{'. size 0 means the brace is
// literal text, which it is in both engines unless it is `{n}`, `{n,}` or
// `{n,m}`.
func scanRepeat(s []rune, i int) (size int, repeats, unbounded bool, prob *patternProblem) {
	n := len(s)
	j := i + 1
	lo := asciiDigitsAt(s, j)
	if lo == "" {
		return 0, false, false, nil
	}
	j += len(lo)
	hi, comma := lo, false
	if j < n && s[j] == ',' {
		comma = true
		j++
		hi = asciiDigitsAt(s, j)
		j += len(hi)
	}
	if j >= n || s[j] != '}' {
		return 0, false, false, nil
	}
	j++
	for _, d := range []string{lo, hi} {
		if len(d) > 1 && d[0] == '0' {
			return 0, false, false, dialectProblem("writes the repeat `%s` with a leading zero, which Go reads as literal text and the browser as a count", string(s[i:j]))
		}
	}
	unbounded = comma && hi == ""
	repeats = unbounded || len(hi) > 1 || hi > "1"
	return j - i, repeats, unbounded, nil
}

func validGroupName(name string) bool {
	if name == "" {
		return false
	}
	for k, r := range name {
		letter := r == '_' || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z')
		if !letter && (k == 0 || !isASCIIDigit(r)) {
			return false
		}
	}
	return true
}

func asciiDigitsAt(s []rune, j int) string {
	k := j
	for k < len(s) && isASCIIDigit(s[k]) {
		k++
	}
	return string(s[j:k])
}

func isASCIIDigit(r rune) bool { return r >= '0' && r <= '9' }

func isASCIIAlnum(r rune) bool {
	return isASCIIDigit(r) || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z')
}

func isASCIIWord(r rune) bool { return isASCIIAlnum(r) || r == '_' }

func isASCIISpace(r rune) bool { return r == ' ' || (r >= '\t' && r <= '\r') }

func isHexDigit(r rune) bool {
	return isASCIIDigit(r) || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')
}

func hexValue(r rune) rune {
	switch {
	case r >= 'a':
		return r - 'a' + 10
	case r >= 'A':
		return r - 'A' + 10
	}
	return r - '0'
}
