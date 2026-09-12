package template

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"
)

// patternCases is the rule table for checkPattern. The deploy form applies the
// same rules in the browser, so this list is repeated case for case in
// frontend/lib/ui-spec-pattern.test.ts — change both, or the editor preview and
// the save disagree about the same pattern (#187 #189).
//
// Every "dialect" entry compiles in Go RE2. Each either throws as a JavaScript
// RegExp (so the form used to drop it silently) or compiles there with a
// different meaning; the comment says which.
var patternCases = []struct {
	pattern string
	kind    string // "" means accepted
}{
	// Accepted: both engines read these the same way.
	{`^[a-z]{2}$`, ""},
	{`^[^"$\\;{}]{0,80}$`, ""},
	{`^[a-z][a-z0-9-]*$`, ""},
	{`^[a-z0-9/:.-]+$`, ""},
	{`(?:a)b`, ""},
	{`(?<name>a)b`, ""},
	{`^\x41\t\-\.\/\_$`, ""},
	{`^[\w-]+$`, ""},
	{`^\0$`, ""},
	{`^a{0}b{1,}c{,3}$`, ""},
	{`^[[:]+$`, ""}, // no `:]` after it, so not a POSIX class in Go either
	{`^(\d{1,3}\.){3}\d{1,3}$`, ""},
	{`^(a|b)*$`, ""},
	{`^(a+)?$`, ""},
	{`^(a+){1}$`, ""},
	// A repeated group that opens with a literal no inner repeat can match
	// splits the input one way only, so it cannot backtrack catastrophically.
	{`^[a-z]+(?:-[a-z]+)*$`, ""},
	{`^(/[^/]+)+$`, ""},
	{`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`, ""}, // k8s DNS-1123 subdomain
	{strings.Repeat("a", 200), ""},

	{strings.Repeat("a", 201), "too-long"},

	{`(?i)^web-`, "dialect"},      // JS throws
	{`(?s).*`, "dialect"},         // JS throws
	{`(?U)a+`, "dialect"},         // JS throws
	{`a(?i)b`, "dialect"},         // JS throws
	{`(?i:a)b`, "dialect"},        // JS throws (Node 22)
	{`(?P<n>a)b`, "dialect"},      // JS throws
	{`(?<1a>x)`, "dialect"},       // JS throws
	{`(?<a>x)(?<a>y)`, "dialect"}, // JS throws
	{`^*a`, "dialect"},            // JS throws
	{`^?a`, "dialect"},            // JS throws
	{`\b+`, "dialect"},            // JS throws
	{`\B*`, "dialect"},            // JS throws
	{`$*`, "dialect"},             // JS throws
	{`\b{2}`, "dialect"},          // JS throws
	{`\Aabc`, "dialect"},          // JS: literal "A"
	{`abc\z`, "dialect"},          // JS: literal "z"
	{`\Qa.b\E`, "dialect"},        // JS: literal "Q", any char, "E"
	{`^[[:alpha:]]+$`, "dialect"}, // JS: a class of "[:alph" then a literal "]"
	{`^[[:^alpha:]]$`, "dialect"},
	{`^\pL+$`, "dialect"}, // JS: literal "p"
	{`^\p{Greek}+$`, "dialect"},
	{`^\PL$`, "dialect"},
	{`^[\pN]$`, "dialect"},
	{`^\a$`, "dialect"}, // Go: bell; JS: literal "a"
	{`^[\a]$`, "dialect"},
	{`^\x{41}$`, "dialect"}, // JS: "x" repeated 41 times
	{`^[\x{41}]$`, "dialect"},
	{`^\12$`, "dialect"},   // JS: a backreference once there are 12 groups
	{`^[]a]$`, "dialect"},  // JS: an empty class, then "a]"
	{`^[^]a]$`, "dialect"}, // JS: any character, then "a]"
	{`^a{01}$`, "dialect"}, // Go: literal "{01}"; JS: exactly one "a"
	{`^a{0,01}$`, "dialect"},

	{`^(a+)+$`, "nested-quantifier"},
	{`^(a*)*$`, "nested-quantifier"},
	{`^(\w+\s?)*$`, "nested-quantifier"},
	{`^(a+){2,}$`, "nested-quantifier"},
	{`^(a+){2}$`, "nested-quantifier"},
	{`^((a)+)+$`, "nested-quantifier"},
	{`^(a.*)*$`, "nested-quantifier"},      // the literal "a" is also what ".*" can eat
	{`^(?:-a|b+)*$`, "nested-quantifier"},  // an alternative need not start with "-"
	{`^(-?[a-z]+)*$`, "nested-quantifier"}, // the separator is optional
	{`^(-[a-z-]+)*$`, "nested-quantifier"}, // the inner repeat can eat the separator
}

func TestCheckPattern(t *testing.T) {
	for _, tc := range patternCases {
		t.Run(tc.pattern, func(t *testing.T) {
			got := checkPattern(tc.pattern)
			if tc.kind == "" {
				require.Nil(t, got, "want accepted")
				return
			}
			require.NotNil(t, got, "want %s", tc.kind)
			require.Equal(t, tc.kind, got.kind, got.reason)
		})
	}
}

// Scanning an unfinished pattern must not panic: the compiler, not the
// scanner, is what reports these.
func TestCheckPattern_UnfinishedPatternsDoNotPanic(t *testing.T) {
	for _, p := range []string{`\`, `[`, `[^`, `[a-`, `[a-\`, `(`, `(?`, `(?<`, `(?<a`, `)`, `a{`, `a{1`, `a{1,`, `\x`, `\x4`, `[[:`, `*`, `|*`} {
		require.NotPanics(t, func() { checkPattern(p) }, p)
	}
}

// The live demo reseeds from these fixtures every day; a rule that refuses one
// of their patterns empties the demo catalog.
func TestCheckPattern_AcceptsEverySeededPattern(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("..", "..", "cmd", "seed-demo", "fixtures", "*.ui-spec.yaml"))
	require.NoError(t, err)
	require.NotEmpty(t, files)

	var seen int
	for _, file := range files {
		raw, err := os.ReadFile(file)
		require.NoError(t, err)
		var spec UISpec
		require.NoError(t, yaml.Unmarshal(raw, &spec), file)
		for _, f := range spec.Fields {
			if f.Pattern == "" {
				continue
			}
			seen++
			require.Nil(t, checkPattern(f.Pattern), "%s: %s", filepath.Base(file), f.Pattern)
		}
	}
	require.NotZero(t, seen, "no seeded patterns found — this test no longer checks anything")
}
