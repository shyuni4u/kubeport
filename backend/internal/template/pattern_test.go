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
	// A repeat that can match a given text only one way cannot backtrack
	// catastrophically, whether its separator comes first or last.
	{`^[a-z]+(?:-[a-z]+)*$`, ""},
	{`^(/[^/]+)+$`, ""},
	{`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`, ""},                   // k8s DNS-1123 subdomain
	{`^([a-z0-9]([-a-z0-9]*[a-z0-9])?\.)+[a-z]{2,}$`, ""},                                       // FQDN
	{`^([a-z]+,)*[a-z]+$`, ""},                                                                  // comma list
	{`^([a-z0-9]+(?:[._-][a-z0-9]+)*/)*[a-z0-9]+(?:[._-][a-z0-9]+)*(:[\w][\w.-]{0,127})?$`, ""}, // image reference
	{`^(?:[a-z0-9.-]+(?::\d+)?/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[\w][\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$`, ""},
	{`^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$`, ""}, // semver
	{`^([0-9a-f]{2}:){5}[0-9a-f]{2}$`, ""},                                                  // MAC address
	{`^(foo|bar)*$`, ""},
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
	{`^[a-\d]$`, "dialect"}, // the other way round: Go refuses it, JS reads "a", "-" and digits
	// A flagless RegExp reads a character outside the BMP as two UTF-16 halves.
	// (A lone half cannot be held in a Go string; ui-spec-pattern.test.ts
	// covers that case on its own.)
	{`^[😀]+$`, "dialect"},       // JS: a class of two halves; Go: one character
	{`^([😀]|[😁])+$`, "dialect"}, // ...and both classes share the first half, which is ambiguous too
	{`^a😀$`, "dialect"},         // outside a class as well
	{`^\uD83D$`, "dialect"},     // JS: a lone half; Go refuses \u

	{`^(a+)+$`, "nested-quantifier"},
	{`^(a*)*$`, "nested-quantifier"},
	{`^(\w+\s?)*$`, "nested-quantifier"},
	{`^(a+){2,}$`, "nested-quantifier"},
	{`^(a+){2}$`, "nested-quantifier"},
	{`^((a)+)+$`, "nested-quantifier"},
	{`^(a.*)*$`, "nested-quantifier"},              // the literal "a" is also what ".*" can eat
	{`^(?:-a|b+)*$`, "nested-quantifier"},          // an alternative need not start with "-"
	{`^(-?[a-z]+)*$`, "nested-quantifier"},         // the separator is optional
	{`^(-[a-z-]+)*$`, "nested-quantifier"},         // the inner repeat can eat the separator
	{`^(a|a)*$`, "nested-quantifier"},              // both alternatives match the same text
	{`^(?:[a-z]|[a-z0-9])+$`, "nested-quantifier"}, // ...and here overlap on a-z
	{`^(a{1,20})+$`, "nested-quantifier"},          // a bounded inner repeat splits the text as well
	{`^(a{0,30}){0,30}b$`, "nested-quantifier"},    // bounded on both levels, still exponential
	{`^(a+,?)*$`, "nested-quantifier"},             // the trailing separator is optional
	{`^([a-z,]+,)*$`, "nested-quantifier"},         // the inner class also matches the separator
	// Polynomial, but steep at 256 characters on every keystroke.
	{`^[a-z0-9]+[-a-z0-9]*[a-z0-9]+$`, "nested-quantifier"}, // three overlapping repeats; write `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`
	{`\w+\w+`, "nested-quantifier"},                         // unanchored, so the browser retries it from every position
	{`[a-z]+`, ""},                                          // ...which one repeat can afford
	// Ambiguity without a loop is bounded: `[01]?[0-9][0-9]?` reads "10" two
	// ways, and four octets make at most 2^4. Small counts are copied out
	// rather than treated as loops, so these stay accepted.
	{`^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$`, ""},                        // OWASP IPv4
	{`^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\/(?:3[0-2]|[12]?[0-9])$`, ""}, // ...as CIDR
	{`^(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$`, ""},
	{strings.Repeat("(?:a|a)", 20), "nested-quantifier"}, // but 2^20 ways is not
	// A body that can match nothing: V8 ends `*` on an empty repetition but
	// not a counted repeat, which it spreads the text over every way it can.
	{`^(a?){25}a{25}$`, "nested-quantifier"}, // about a minute at 256 characters
	{`^([a-z]?){20}x$`, "nested-quantifier"},
	{`^(a?){25}$`, "nested-quantifier"},
	{`^(a*){3}b$`, "nested-quantifier"},
	{`^(a|){10}b$`, "nested-quantifier"},
	{`^[a-z0-9]+(?:(?:[._]|__|[-]*)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|[-]*)[a-z0-9]+)*)*$`, "nested-quantifier"},                                                     // distribution v2 path: 20 s at 32 characters
	{`^(@(annually|yearly|monthly|weekly|daily|hourly|reboot))|(@every (\d+(ns|us|µs|ms|s|m|h))+)|((((\d+,)+\d+|(\d+(\/|-)\d+)|\d+|\*) ?){5,7})$`, "nested-quantifier"}, // cron with macros
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
