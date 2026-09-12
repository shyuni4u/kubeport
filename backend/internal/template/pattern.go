package template

import (
	"fmt"
	"sort"
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

// Ambiguity is scored as an estimate, in bits, of the extra work a
// backtracking engine does when a match fails: two runs over the same text
// that parted and meet again at one position double it, or more.
const (
	// loopMergeCost is a merge whose runs parted and met again across a loop:
	// where each run left the loop is a choice among up to the value's length
	// (256 characters in the form), so it counts nine bits.
	loopMergeCost = 9
	// maxAmbiguity is the score at which a pattern is refused. Two loop merges
	// reach it — three overlapping loops such as `^[a-z0-9]+[-a-z0-9]*[a-z0-9]+$`,
	// an unanchored `\w+\w+` — and so does any merge on a cycle, which scores
	// without end (`(a+)+`, `(a|a)*`). A merge with no loop between the parting
	// and the meeting is bounded; it counts two bits per doubling (a pair of
	// runs sees about every other independent choice), so the four octets of
	// an IPv4 pattern written with `[01]?[0-9][0-9]?` fit and 2^9 choices do not.
	maxAmbiguity = 18
	// maxExpandedCount: a counted repeat up to this many, with no loop inside,
	// is copied out rather than treated as a loop, so the ambiguity in
	// `(octet\.){3}` is scored as the bounded thing it is.
	maxExpandedCount = 4
	// maxPositions caps copying out; past it a repeat is treated as a loop,
	// which only ever scores higher.
	maxPositions = 400
	// analysisBudget caps the work spent looking. A pattern that needs more is
	// refused as too complex to vouch for.
	analysisBudget = 200000
)

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

// checkPattern returns nil for a pattern both engines read the same way and
// the browser can run without hanging. A pattern that does not compile is left
// for the compiler to report.
func checkPattern(pattern string) *patternProblem {
	if utf8.RuneCountInString(pattern) > maxPatternLength {
		return &patternProblem{kind: "too-long", reason: fmt.Sprintf("is longer than %d characters", maxPatternLength)}
	}
	// A flagless RegExp runs on UTF-16 code units, so a character outside the
	// Basic Multilingual Plane is two characters to the browser and one to Go:
	// `[😀]` is a class of two halves there, and `([😀]|[😁])+` is ambiguous
	// because both share the first half. Refusing them keeps every accepted
	// pattern the same sequence of characters on both sides, which is what the
	// analysis below assumes. (A lone half is refused too; only the frontend's
	// strings can hold one.)
	for _, r := range pattern {
		if r > 0xFFFF || (r >= 0xD800 && r <= 0xDFFF) {
			return dialectProblem("uses `%c`, a character outside the Basic Multilingual Plane, which the browser reads as two separate halves; leave it out of the pattern, or let such characters through with a negated class, as in `[^\\x00-\\x7F]`", r)
		}
	}
	p := &patternParser{s: []rune(pattern), names: map[string]bool{}}
	root := p.parseAlt()
	if p.prob != nil {
		return p.prob
	}
	if p.incomplete || p.i < len(p.s) {
		return nil
	}
	return checkAmbiguity(p, root)
}

// ---- character sets: sorted, merged, inclusive code point ranges ----

type runeRange struct{ lo, hi rune }

type charSet []runeRange

const maxRuneValue = 0x10FFFF

func setOf(bounds ...rune) charSet {
	s := make(charSet, 0, len(bounds)/2)
	for i := 0; i+1 < len(bounds); i += 2 {
		s = append(s, runeRange{bounds[i], bounds[i+1]})
	}
	return normalizeSet(s)
}

func normalizeSet(s charSet) charSet {
	sorted := append(charSet(nil), s...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].lo < sorted[j].lo })
	var out charSet
	for _, r := range sorted {
		if n := len(out); n > 0 && r.lo <= out[n-1].hi+1 {
			if r.hi > out[n-1].hi {
				out[n-1].hi = r.hi
			}
			continue
		}
		out = append(out, r)
	}
	return out
}

func negateSet(s charSet) charSet {
	var out charSet
	next := rune(0)
	for _, r := range s {
		if r.lo > next {
			out = append(out, runeRange{next, r.lo - 1})
		}
		next = r.hi + 1
	}
	if next <= maxRuneValue {
		out = append(out, runeRange{next, maxRuneValue})
	}
	return out
}

func setsIntersect(a, b charSet) bool {
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		switch {
		case a[i].hi < b[j].lo:
			i++
		case b[j].hi < a[i].lo:
			j++
		default:
			return true
		}
	}
	return false
}

func singleRune(s charSet) (rune, bool) {
	if len(s) == 1 && s[0].lo == s[0].hi {
		return s[0].lo, true
	}
	return 0, false
}

// The browser's meaning of the classes, since that is where backtracking
// happens. Sets run to U+10FFFF: for a flagless RegExp, which sees only code
// units, that over-approximates (safe); for the Unicode-mode run the form uses
// on values holding surrogates, it is exact.
var (
	digitSet = setOf('0', '9')
	wordSet  = setOf('0', '9', 'A', 'Z', '_', '_', 'a', 'z')
	spaceSet = setOf('\t', '\r', ' ', ' ', 0xA0, 0xA0, 0x1680, 0x1680, 0x2000, 0x200A,
		0x2028, 0x2029, 0x202F, 0x202F, 0x205F, 0x205F, 0x3000, 0x3000, 0xFEFF, 0xFEFF)
	dotSet = negateSet(setOf('\n', '\n', '\r', '\r', 0x2028, 0x2029))
)

// ---- parsing ----

type nodeOp int

const (
	opLit nodeOp = iota
	opEmpty
	opCat
	opAlt
	opRep
)

type patternNode struct {
	op           nodeOp
	pos          int // opLit: its position
	subs         []*patternNode
	min, max     int // opRep; max < 0 is unbounded
	assert       bool
	caret        bool // the assertion is `^`
	start, end   int  // the source runes it covers
	posLo, posHi int  // the source positions created inside it
}

type patternParser struct {
	s          []rune
	i          int
	sets       []charSet // one per position (a character the pattern consumes)
	origin     []int     // the source position each position was copied from
	names      map[string]bool
	prob       *patternProblem
	incomplete bool // the compiler, not this, reports what is wrong
}

func (p *patternParser) failed() bool { return p.prob != nil || p.incomplete }

func (p *patternParser) lit(set charSet) *patternNode {
	p.sets = append(p.sets, set)
	p.origin = append(p.origin, len(p.sets)-1)
	return &patternNode{op: opLit, pos: len(p.sets) - 1}
}

func (p *patternParser) parseAlt() *patternNode {
	start, posLo := p.i, len(p.sets)
	var branches []*patternNode
	for {
		b := p.parseCat()
		if p.failed() {
			return nil
		}
		branches = append(branches, b)
		if p.i < len(p.s) && p.s[p.i] == '|' {
			p.i++
			continue
		}
		break
	}
	if len(branches) == 1 {
		return branches[0]
	}
	return &patternNode{op: opAlt, subs: branches, start: start, end: p.i, posLo: posLo, posHi: len(p.sets)}
}

func (p *patternParser) parseCat() *patternNode {
	cat := &patternNode{op: opCat, start: p.i, posLo: len(p.sets)}
	for p.i < len(p.s) && p.s[p.i] != '|' && p.s[p.i] != ')' {
		start, posLo := p.i, len(p.sets)
		atom := p.parseAtom()
		if p.failed() {
			return nil
		}
		min, max, size := p.quantifierAt(p.i)
		if p.failed() {
			return nil
		}
		if size > 0 {
			if atom.assert {
				p.prob = dialectProblem("repeats `^`, `$`, `\\b` or `\\B`, which the browser refuses")
				return nil
			}
			p.i += size
			if p.i < len(p.s) && p.s[p.i] == '?' {
				p.i++
			}
			// A repeat of a repeat (`a**`, `a{2}{3}`): both compilers refuse it.
			if _, _, again := p.quantifierAt(p.i); p.failed() || again > 0 {
				p.incomplete = p.prob == nil
				return nil
			}
			atom = &patternNode{op: opRep, subs: []*patternNode{atom}, min: min, max: max,
				start: start, end: p.i, posLo: posLo, posHi: len(p.sets)}
		}
		cat.subs = append(cat.subs, atom)
	}
	cat.end, cat.posHi = p.i, len(p.sets)
	return cat
}

func (p *patternParser) parseAtom() *patternNode {
	s, i := p.s, p.i
	switch s[i] {
	case '(':
		size, prob := scanGroupOpen(s, i, p.names)
		if prob != nil {
			p.prob = prob
			return nil
		}
		if size == 0 {
			p.incomplete = true
			return nil
		}
		posLo := len(p.sets)
		p.i += size
		inner := p.parseAlt()
		if p.failed() {
			return nil
		}
		if p.i >= len(s) || s[p.i] != ')' {
			p.incomplete = true
			return nil
		}
		p.i++
		// Wrapped, so that a group around an assertion — `(^)*` — is not one.
		return &patternNode{op: opCat, subs: []*patternNode{inner}, start: i, end: p.i, posLo: posLo, posHi: len(p.sets)}
	case '[':
		set, size, prob := scanClass(s, i)
		if prob != nil {
			p.prob = prob
			return nil
		}
		if size == 0 {
			p.incomplete = true
			return nil
		}
		p.i += size
		return p.lit(set)
	case '\\':
		set, assert, size, prob := scanEscape(s, i, false)
		if prob != nil {
			p.prob = prob
			return nil
		}
		if size == 0 {
			p.incomplete = true
			return nil
		}
		p.i += size
		if assert {
			return &patternNode{op: opEmpty, assert: true}
		}
		return p.lit(set)
	case '^', '$':
		p.i++
		return &patternNode{op: opEmpty, assert: true, caret: s[i] == '^'}
	case '.':
		p.i++
		return p.lit(dotSet)
	case '*', '+', '?':
		p.incomplete = true
		return nil
	case '{':
		// A brace is literal text unless it is a counted repeat, and a repeat
		// with nothing before it is refused by both compilers.
		if _, _, size := p.quantifierAt(i); p.failed() || size > 0 {
			p.incomplete = p.prob == nil
			return nil
		}
	}
	p.i++
	return p.lit(setOf(s[i], s[i]))
}

// quantifierAt reads a quantifier at s[i]; size 0 means there is none.
func (p *patternParser) quantifierAt(i int) (min, max, size int) {
	if i >= len(p.s) {
		return 0, 0, 0
	}
	switch p.s[i] {
	case '*':
		return 0, -1, 1
	case '+':
		return 1, -1, 1
	case '?':
		return 0, 1, 1
	case '{':
		size, lo, hi, prob := scanRepeat(p.s, i)
		if prob != nil {
			p.prob = prob
			return 0, 0, 0
		}
		return lo, hi, size
	}
	return 0, 0, 0
}

// scanEscape reads the escape at s[i] == '\\'. size 0 means the pattern ends
// there. Letters and digits are an allowlist: what is not on it either does not
// compile in Go or means something else in the browser (`\A`, `\z`, `\pL`,
// `\Q`, `\a`, `\1`, `\u`), and the browser reads them all without complaint.
func scanEscape(s []rune, i int, inClass bool) (set charSet, assert bool, size int, prob *patternProblem) {
	n := len(s)
	if i+1 >= n {
		return nil, false, 0, nil
	}
	c := s[i+1]
	if c >= utf8.RuneSelf {
		return nil, false, 0, dialectProblem("uses `\\%c`, which the browser reads differently", c)
	}
	if !isASCIIAlnum(c) {
		return setOf(c, c), false, 2, nil
	}
	switch c {
	case 'f':
		return setOf('\f', '\f'), false, 2, nil
	case 'n':
		return setOf('\n', '\n'), false, 2, nil
	case 'r':
		return setOf('\r', '\r'), false, 2, nil
	case 't':
		return setOf('\t', '\t'), false, 2, nil
	case 'v':
		return setOf('\v', '\v'), false, 2, nil
	case '0':
		// Octal: both engines take up to two more octal digits.
		v, size := rune(0), 2
		for size < 4 && i+size < n && s[i+size] >= '0' && s[i+size] <= '7' {
			v = v*8 + s[i+size] - '0'
			size++
		}
		return setOf(v, v), false, size, nil
	case 'x':
		if i+3 < n && isHexDigit(s[i+2]) && isHexDigit(s[i+3]) {
			v := hexValue(s[i+2])<<4 | hexValue(s[i+3])
			return setOf(v, v), false, 4, nil
		}
		return nil, false, 0, dialectProblem("uses `\\x` without exactly two hex digits after it; `\\x{...}` is Go-only")
	case 'd':
		return digitSet, false, 2, nil
	case 'D':
		return negateSet(digitSet), false, 2, nil
	case 'w':
		return wordSet, false, 2, nil
	case 'W':
		return negateSet(wordSet), false, 2, nil
	case 's':
		return spaceSet, false, 2, nil
	case 'S':
		return negateSet(spaceSet), false, 2, nil
	case 'b', 'B':
		if !inClass {
			return nil, true, 2, nil
		}
	case 'p', 'P':
		return nil, false, 0, dialectProblem("uses `\\%c`, which the browser reads as a plain `%c`; list the characters instead, as in `[a-zA-Z]`", c, c)
	}
	return nil, false, 0, dialectProblem("uses `\\%c`, which the browser reads differently", c)
}

// scanClass reads the character class at s[i] == '['. size 0 means it is not
// closed, or not valid in either engine.
func scanClass(s []rune, i int) (charSet, int, *patternProblem) {
	n := len(s)
	j := i + 1
	negate := false
	if j < n && s[j] == '^' {
		negate = true
		j++
	}
	if j < n && s[j] == ']' {
		// Go takes a leading `]` as a member; the browser closes an empty class.
		return nil, 0, dialectProblem("starts a character class with `]`, which the browser reads as an empty class; write it as `\\]`")
	}
	member := func(k int) (charSet, int, *patternProblem) {
		if s[k] == '\\' {
			set, _, size, prob := scanEscape(s, k, true)
			return set, size, prob
		}
		return setOf(s[k], s[k]), 1, nil
	}
	var members charSet
	for j < n && s[j] != ']' {
		// Go's rule: `[:` with a `:]` anywhere after it is a POSIX class (or
		// an error). The browser reads it as plain members.
		if s[j] == '[' && j+1 < n && s[j+1] == ':' && strings.Contains(string(s[j+2:]), ":]") {
			return nil, 0, dialectProblem("uses a POSIX class such as `[:alpha:]`, which the browser does not read; list the characters instead, as in `[a-zA-Z]`")
		}
		lo, size, prob := member(j)
		if prob != nil || size == 0 {
			return nil, 0, prob
		}
		j += size
		if from, ok := singleRune(lo); ok && j+1 < n && s[j] == '-' && s[j+1] != ']' {
			hi, size, prob := member(j + 1)
			if prob != nil || size == 0 {
				return nil, 0, prob
			}
			j += 1 + size
			to, ok := singleRune(hi)
			if !ok {
				// Go refuses it; the browser reads a, -, and the class.
				return nil, 0, dialectProblem("ends a range in a class, as in `[a-\\d]`, which Go refuses; put `-` last, as in `[a\\d-]`")
			}
			if to < from {
				return nil, 0, nil
			}
			members = append(members, runeRange{from, to})
			continue
		}
		members = append(members, lo...)
	}
	if j >= n {
		return nil, 0, nil
	}
	set := normalizeSet(members)
	if negate {
		set = negateSet(set)
	}
	return set, j + 1 - i, nil
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
		return 0, dialectProblem("uses `(?%c`; the browser reads only `(?:` and `(?<name>` here, so flags such as `(?i)` cannot be used — spell out both cases instead, as in `[aA][bB]`", s[i+2])
	}
}

// scanRepeat reads a counted repeat at s[i] == '{'. size 0 means the brace is
// literal text, which it is in both engines unless it is `{n}`, `{n,}` or
// `{n,m}`. hi < 0 means unbounded.
func scanRepeat(s []rune, i int) (size, lo, hi int, prob *patternProblem) {
	n := len(s)
	j := i + 1
	loDigits := asciiDigitsAt(s, j)
	if loDigits == "" {
		return 0, 0, 0, nil
	}
	j += len(loDigits)
	hiDigits, comma := loDigits, false
	if j < n && s[j] == ',' {
		comma = true
		j++
		hiDigits = asciiDigitsAt(s, j)
		j += len(hiDigits)
	}
	if j >= n || s[j] != '}' {
		return 0, 0, 0, nil
	}
	j++
	for _, d := range []string{loDigits, hiDigits} {
		if len(d) > 1 && d[0] == '0' {
			return 0, 0, 0, dialectProblem("writes the repeat `%s` with a leading zero, which Go reads as literal text and the browser as a count", string(s[i:j]))
		}
	}
	hi = -1
	if !comma || hiDigits != "" {
		hi = repeatCount(hiDigits)
	}
	return j - i, repeatCount(loDigits), hi, nil
}

func repeatCount(digits string) int {
	v := 0
	for _, r := range digits {
		if v <= 100000 {
			v = v*10 + int(r-'0')
		}
	}
	return v
}

// ---- ambiguity ----

func loops(nd *patternNode) bool { return nd.op == opRep && (nd.max < 0 || nd.max >= 2) }

func nullable(nd *patternNode) bool {
	switch nd.op {
	case opLit:
		return false
	case opEmpty:
		return true
	case opAlt:
		for _, sub := range nd.subs {
			if nullable(sub) {
				return true
			}
		}
		return false
	case opRep:
		return nd.max == 0 || nd.min == 0 || nullable(nd.subs[0])
	}
	for _, sub := range nd.subs {
		if !nullable(sub) {
			return false
		}
	}
	return true
}

// emptyRepeat finds a repeat of more than one whose body can match nothing.
// The browser ends `*` and `+` at an empty repetition, but a counted repeat
// such as `(a?){25}` it spreads the text over its repetitions in every way it
// can: a minute at 256 characters. No ui-spec needs one, so all are refused.
func (p *patternParser) emptyRepeat(nd *patternNode) *patternProblem {
	if loops(nd) && nullable(nd.subs[0]) {
		return &patternProblem{
			kind: "nested-quantifier",
			reason: fmt.Sprintf("repeats `%s`, whose body can match nothing, so the browser tries every way of spreading the text over the repetitions, which can freeze the page; "+
				"make the body match at least one character, as in `a{0,25}` rather than `(a?){25}`", string(p.s[nd.start:nd.end])),
		}
	}
	for _, sub := range nd.subs {
		if prob := p.emptyRepeat(sub); prob != nil {
			return prob
		}
	}
	return nil
}

func hasLoop(nd *patternNode) bool {
	if loops(nd) {
		return true
	}
	for _, sub := range nd.subs {
		if hasLoop(sub) {
			return true
		}
	}
	return false
}

func countPositions(nd *patternNode) int {
	if nd.op == opLit {
		return 1
	}
	c := 0
	for _, sub := range nd.subs {
		c += countPositions(sub)
	}
	return c
}

func (p *patternParser) clone(nd *patternNode) *patternNode {
	c := *nd
	if nd.op == opLit {
		p.sets = append(p.sets, p.sets[nd.pos])
		p.origin = append(p.origin, p.origin[nd.pos])
		c.pos = len(p.sets) - 1
		return &c
	}
	c.subs = make([]*patternNode, len(nd.subs))
	for i, sub := range nd.subs {
		c.subs[i] = p.clone(sub)
	}
	return &c
}

// expand copies out a counted repeat of at most maxExpandedCount with no loop
// inside — `x{1,3}` becomes `x(x(x)?)?` — so its bounded ambiguity is scored as
// bounded instead of as a loop's.
func (p *patternParser) expand(nd *patternNode) *patternNode {
	c := *nd
	c.subs = make([]*patternNode, len(nd.subs))
	for i, sub := range nd.subs {
		c.subs[i] = p.expand(sub)
	}
	if !loops(&c) || c.max > maxExpandedCount || c.min > c.max || hasLoop(c.subs[0]) ||
		len(p.sets)+countPositions(c.subs[0])*(c.max-1) > maxPositions {
		return &c
	}
	copies := []*patternNode{c.subs[0]}
	for len(copies) < c.max {
		copies = append(copies, p.clone(c.subs[0]))
	}
	wrap := func(op nodeOp, subs ...*patternNode) *patternNode {
		return &patternNode{op: op, subs: subs, min: 0, max: 1, start: c.start, end: c.end, posLo: c.posLo, posHi: c.posHi}
	}
	var tail *patternNode
	for i := c.max - 1; i >= c.min; i-- {
		body := copies[i]
		if tail != nil {
			body = wrap(opCat, copies[i], tail)
		}
		tail = wrap(opRep, body)
	}
	out := wrap(opCat, copies[:c.min]...)
	if tail != nil {
		out.subs = append(out.subs, tail)
	}
	return out
}

// glushkov describes one node of the pattern as a position automaton that
// keeps count (up to 2) of how many distinct ways lead to each position.
type glushkov struct {
	null        int
	first, last []uint8
}

type ambiguityAnalyzer struct {
	n        int
	follow   []uint8        // n*n: ways from one position straight to the next
	loopEdge []bool         // n*n: the transition goes around a loop
	dup      []*patternNode // n*n: the repeat that made a transition two ways
	stack    []*patternNode
	loops    []*patternNode // repeats that loop
}

func cap2(v int) uint8 {
	if v > 2 {
		return 2
	}
	return uint8(v)
}

func nonZero(v []uint8) []int {
	var idx []int
	for i, x := range v {
		if x != 0 {
			idx = append(idx, i)
		}
	}
	return idx
}

func ceilLog2(v int) int {
	bits := 0
	for (1 << bits) < v {
		bits++
	}
	return bits
}

func (a *ambiguityAnalyzer) connect(last, first []uint8, loop bool) {
	for _, x := range nonZero(last) {
		for _, y := range nonZero(first) {
			k := x*a.n + y
			before := a.follow[k]
			a.follow[k] = cap2(int(before) + int(last[x])*int(first[y]))
			if loop {
				a.loopEdge[k] = true
			}
			if before < 2 && a.follow[k] == 2 && len(a.stack) > 0 {
				a.dup[k] = a.stack[len(a.stack)-1]
			}
		}
	}
}

func (a *ambiguityAnalyzer) info(nd *patternNode) glushkov {
	g := glushkov{first: make([]uint8, a.n), last: make([]uint8, a.n)}
	switch nd.op {
	case opLit:
		g.first[nd.pos], g.last[nd.pos] = 1, 1
	case opEmpty:
		g.null = 1
	case opCat:
		g.null = 1
		for _, sub := range nd.subs {
			b := a.info(sub)
			a.connect(g.last, b.first, false)
			for y := 0; y < a.n; y++ {
				g.first[y] = cap2(int(g.first[y]) + g.null*int(b.first[y]))
				g.last[y] = cap2(int(b.last[y]) + b.null*int(g.last[y]))
			}
			g.null = int(cap2(g.null * b.null))
		}
	case opAlt:
		for _, sub := range nd.subs {
			b := a.info(sub)
			for y := 0; y < a.n; y++ {
				g.first[y] = cap2(int(g.first[y]) + int(b.first[y]))
				g.last[y] = cap2(int(g.last[y]) + int(b.last[y]))
			}
			g.null = int(cap2(g.null + b.null))
		}
	case opRep:
		if nd.max == 0 {
			g.null = 1
			return g
		}
		a.stack = append(a.stack, nd)
		b := a.info(nd.subs[0])
		g.first, g.last = b.first, b.last
		switch {
		case nd.max == 1 && nd.min == 0:
			g.null = int(cap2(b.null + 1))
		case nd.max == 1:
			g.null = b.null
		default:
			// A count above maxExpandedCount is treated as unbounded:
			// `(a{1,20})+` backtracks like `(a+)+`. Its body cannot match
			// nothing — emptyRepeat refused that — so every repetition
			// consumes and only non-empty ones connect.
			a.loops = append(a.loops, nd)
			a.connect(b.last, b.first, true)
			g.null = b.null
			if nd.min == 0 {
				g.null = 1
			}
		}
		a.stack = a.stack[:len(a.stack)-1]
	}
	return g
}

// checkAmbiguity walks pairs of runs over the same text, starting together,
// and scores each time two runs that parted meet again at one position.
func checkAmbiguity(p *patternParser, root *patternNode) *patternProblem {
	if prob := p.emptyRepeat(root); prob != nil {
		return prob
	}
	root = p.expand(root)
	if len(p.sets) == 0 {
		return nil
	}
	// A pattern that does not start with `^` is tried again from every
	// position of the value. Model that as a loop over any character in front
	// of it, at position len(p.sets).
	anchored := root.op == opCat && len(root.subs) > 0 && root.subs[0].caret
	n := len(p.sets)
	sets := p.sets
	if !anchored {
		n++
		sets = append(append([]charSet(nil), p.sets...), charSet{{0, maxRuneValue}})
	}
	a := &ambiguityAnalyzer{n: n, follow: make([]uint8, n*n), loopEdge: make([]bool, n*n), dup: make([]*patternNode, n*n)}
	start := a.info(root)
	if !anchored {
		prefix := n - 1
		a.follow[prefix*n+prefix] = 1
		a.loopEdge[prefix*n+prefix] = true
		for _, y := range nonZero(start.first) {
			a.follow[prefix*n+y] = start.first[y]
		}
		start.first[prefix] = 1
	}

	compat := make([]bool, n*n)
	succ := make([][]int, n)
	inWays := make([]int, n)
	for x := 0; x < n; x++ {
		for y := 0; y < n; y++ {
			compat[x*n+y] = setsIntersect(sets[x], sets[y])
			if a.follow[x*n+y] > 0 {
				succ[x] = append(succ[x], y)
				inWays[y] += int(a.follow[x*n+y])
			}
		}
	}
	// A merge with no loop between parting and meeting: the ways into the
	// position bound how many runs meet there.
	finiteMerge := func(x int) int { return 2 * ceilLog2(max(2, inWays[x])) }

	// State: a pair of positions, and for a pair that has parted, whether
	// the parting has gone around a loop since.
	key := func(u, v int, acrossLoop bool) int {
		k := (u*n + v) * 2
		if acrossLoop {
			k++
		}
		return k
	}
	dist := make([]int, 2*n*n)
	for k := range dist {
		dist[k] = -1
	}
	queued := make([]bool, 2*n*n)
	var queue []int
	relax := func(k, w int) bool {
		if w <= dist[k] {
			return false
		}
		dist[k] = w
		if w >= maxAmbiguity {
			return true
		}
		if !queued[k] {
			queued[k] = true
			queue = append(queue, k)
		}
		return false
	}

	firsts := nonZero(start.first)
	for _, x := range firsts {
		for _, y := range firsts {
			if !compat[x*n+y] {
				continue
			}
			w := 0
			if x == y && start.first[x] == 2 {
				w = 2
			}
			if relax(key(x, y, false), w) {
				return a.ambiguous(p, anchored, false, nil, x, y)
			}
		}
	}
	work := 0
	for head := 0; head < len(queue); head++ {
		k := queue[head]
		queued[k] = false
		u, v, parted := k/2/n, k/2%n, k%2 == 1
		for _, x := range succ[u] {
			for _, y := range succ[v] {
				work++
				if work > analysisBudget {
					return &patternProblem{kind: "nested-quantifier", reason: "is too complex to check for repeats that can freeze the browser; split it or simplify it"}
				}
				if !compat[x*n+y] {
					continue
				}
				w := dist[k]
				acrossLoop := parted || a.loopEdge[u*n+x] || a.loopEdge[v*n+y]
				var rep *patternNode
				switch {
				case u == v && x == y:
					if a.follow[u*n+x] == 2 {
						acrossLoop = a.loopEdge[u*n+x]
						rep = a.dup[u*n+x]
						w += 2
						if acrossLoop {
							w += loopMergeCost - 2
						}
					}
					if relax(key(x, x, false), w) {
						return a.ambiguous(p, anchored, acrossLoop, rep, u, x)
					}
				case x == y:
					if acrossLoop {
						w += loopMergeCost
					} else {
						w += finiteMerge(x)
					}
					if relax(key(x, x, false), w) {
						return a.ambiguous(p, anchored, acrossLoop, nil, u, v, x)
					}
				default:
					if u == v {
						acrossLoop = a.loopEdge[u*n+x] || a.loopEdge[u*n+y]
					}
					if relax(key(x, y, acrossLoop), w) {
						return a.ambiguous(p, anchored, acrossLoop, nil, u, v, x, y)
					}
				}
			}
		}
	}
	return nil
}

// ambiguous says which part to rewrite: the smallest loop the ambiguity sits
// in, or — when no loop is involved — that the ways multiply along the whole
// pattern.
func (a *ambiguityAnalyzer) ambiguous(p *patternParser, anchored, acrossLoop bool, rep *patternNode, positions ...int) *patternProblem {
	if !acrossLoop {
		return &patternProblem{
			kind: "nested-quantifier",
			reason: "can match the same text in too many ways: the ways multiply along the whole pattern, not only inside a repeat (`[01]?[0-9][0-9]?` reads `10` two ways), " +
				"and the deploy form runs it in the browser on every keystroke, where that can freeze the page; " +
				"write each part so it matches one way, as in `(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])`",
		}
	}
	if rep == nil {
		lo, hi := -1, -1
		for _, x := range positions {
			if x >= len(p.origin) {
				continue // the unanchored prefix is not part of the source
			}
			o := p.origin[x]
			if lo < 0 || o < lo {
				lo = o
			}
			hi = max(hi, o)
		}
		for _, l := range a.loops {
			if lo >= 0 && l.posLo <= lo && hi < l.posHi && (rep == nil || l.end-l.start < rep.end-rep.start) {
				rep = l
			}
		}
	}
	part := string(p.s)
	if rep != nil {
		part = string(p.s[rep.start:rep.end])
	}
	hint := ""
	if !anchored {
		hint = ", and start the pattern with `^` so the browser does not try it again from every position"
	}
	return &patternProblem{
		kind: "nested-quantifier",
		reason: fmt.Sprintf("can match the same text in more than one way in `%s`, and the deploy form runs it in the browser on every keystroke, where that can freeze the page; "+
			"make each repetition start or end with a character nothing else in it can match, as in `^[a-z]+(-[a-z]+)*$` rather than `^([a-z]+-?)+$`%s", part, hint),
	}
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
