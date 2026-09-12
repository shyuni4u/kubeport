import { describe, expect, it } from "vitest";

import { patternProblem, type PatternProblemKind } from "./ui-spec-pattern";

const r = String.raw;

// The rule table for patternProblem. The API refuses the same patterns on save
// (ValidateSpec), so this list is repeated case for case in
// backend/internal/template/pattern_test.go — change both, or the editor
// preview and the save disagree about the same pattern (#187 #189).
//
// Every "dialect" entry compiles in Go RE2. Each either throws as a JavaScript
// RegExp or compiles here with a different meaning; the comment says which.
const cases: [string, PatternProblemKind | null][] = [
  // Accepted: both engines read these the same way.
  [r`^[a-z]{2}$`, null],
  [r`^[^"$\\;{}]{0,80}$`, null],
  [r`^[a-z][a-z0-9-]*$`, null],
  [r`^[a-z0-9/:.-]+$`, null],
  [r`(?:a)b`, null],
  [r`(?<name>a)b`, null],
  [r`^\x41\t\-\.\/\_$`, null],
  [r`^[\w-]+$`, null],
  [r`^\0$`, null],
  [r`^a{0}b{1,}c{,3}$`, null],
  [r`^[[:]+$`, null], // no `:]` after it, so not a POSIX class in Go either
  [r`^(\d{1,3}\.){3}\d{1,3}$`, null],
  [r`^(a|b)*$`, null],
  [r`^(a+)?$`, null],
  [r`^(a+){1}$`, null],
  // A repeat that can match a given text only one way cannot backtrack
  // catastrophically, whether its separator comes first or last.
  [r`^[a-z]+(?:-[a-z]+)*$`, null],
  [r`^(/[^/]+)+$`, null],
  [r`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`, null], // k8s DNS-1123 subdomain
  [r`^([a-z0-9]([-a-z0-9]*[a-z0-9])?\.)+[a-z]{2,}$`, null], // FQDN
  [r`^([a-z]+,)*[a-z]+$`, null], // comma list
  [r`^([a-z0-9]+(?:[._-][a-z0-9]+)*/)*[a-z0-9]+(?:[._-][a-z0-9]+)*(:[\w][\w.-]{0,127})?$`, null], // image reference
  [r`^(?:[a-z0-9.-]+(?::\d+)?/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[\w][\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$`, null],
  [r`^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$`, null], // semver
  [r`^([0-9a-f]{2}:){5}[0-9a-f]{2}$`, null], // MAC address
  [r`^(foo|bar)*$`, null],
  ["a".repeat(200), null],

  ["a".repeat(201), "too-long"],

  [r`(?i)^web-`, "dialect"], // JS throws
  [r`(?s).*`, "dialect"], // JS throws
  [r`(?U)a+`, "dialect"], // JS throws
  [r`a(?i)b`, "dialect"], // JS throws
  [r`(?i:a)b`, "dialect"], // JS throws (Node 22)
  [r`(?P<n>a)b`, "dialect"], // JS throws
  [r`(?<1a>x)`, "dialect"], // JS throws
  [r`(?<a>x)(?<a>y)`, "dialect"], // JS throws
  [r`^*a`, "dialect"], // JS throws
  [r`^?a`, "dialect"], // JS throws
  [r`\b+`, "dialect"], // JS throws
  [r`\B*`, "dialect"], // JS throws
  [r`$*`, "dialect"], // JS throws
  [r`\b{2}`, "dialect"], // JS throws
  [r`\Aabc`, "dialect"], // JS: literal "A"
  [r`abc\z`, "dialect"], // JS: literal "z"
  [r`\Qa.b\E`, "dialect"], // JS: literal "Q", any char, "E"
  [r`^[[:alpha:]]+$`, "dialect"], // JS: a class of "[:alph" then a literal "]"
  [r`^[[:^alpha:]]$`, "dialect"],
  [r`^\pL+$`, "dialect"], // JS: literal "p"
  [r`^\p{Greek}+$`, "dialect"],
  [r`^\PL$`, "dialect"],
  [r`^[\pN]$`, "dialect"],
  [r`^\a$`, "dialect"], // Go: bell; JS: literal "a"
  [r`^[\a]$`, "dialect"],
  [r`^\x{41}$`, "dialect"], // JS: "x" repeated 41 times
  [r`^[\x{41}]$`, "dialect"],
  [r`^\12$`, "dialect"], // JS: a backreference once there are 12 groups
  [r`^[]a]$`, "dialect"], // JS: an empty class, then "a]"
  [r`^[^]a]$`, "dialect"], // JS: any character, then "a]"
  [r`^a{01}$`, "dialect"], // Go: literal "{01}"; JS: exactly one "a"
  [r`^a{0,01}$`, "dialect"],
  [r`^[a-\d]$`, "dialect"], // the other way round: Go refuses it, JS reads "a", "-" and digits
  // A flagless RegExp reads a character outside the BMP as two UTF-16 halves.
  // (A lone half cannot be held in a Go string; the test below covers it here.)
  [r`^[😀]+$`, "dialect"], // JS: a class of two halves; Go: one character
  [r`^([😀]|[😁])+$`, "dialect"], // ...and both classes share the first half, which is ambiguous too
  [r`^a😀$`, "dialect"], // outside a class as well
  [r`^\uD83D$`, "dialect"], // JS: a lone half; Go refuses \u

  [r`^(a+)+$`, "nested-quantifier"],
  [r`^(a*)*$`, "nested-quantifier"],
  [r`^(\w+\s?)*$`, "nested-quantifier"],
  [r`^(a+){2,}$`, "nested-quantifier"],
  [r`^(a+){2}$`, "nested-quantifier"],
  [r`^((a)+)+$`, "nested-quantifier"],
  [r`^(a.*)*$`, "nested-quantifier"], // the literal "a" is also what ".*" can eat
  [r`^(?:-a|b+)*$`, "nested-quantifier"], // an alternative need not start with "-"
  [r`^(-?[a-z]+)*$`, "nested-quantifier"], // the separator is optional
  [r`^(-[a-z-]+)*$`, "nested-quantifier"], // the inner repeat can eat the separator
  [r`^(a|a)*$`, "nested-quantifier"], // both alternatives match the same text
  [r`^(?:[a-z]|[a-z0-9])+$`, "nested-quantifier"], // ...and here overlap on a-z
  [r`^(a{1,20})+$`, "nested-quantifier"], // a bounded inner repeat splits the text as well
  [r`^(a{0,30}){0,30}b$`, "nested-quantifier"], // bounded on both levels, still exponential
  [r`^(a+,?)*$`, "nested-quantifier"], // the trailing separator is optional
  [r`^([a-z,]+,)*$`, "nested-quantifier"], // the inner class also matches the separator
  // Polynomial, but steep at 256 characters on every keystroke.
  [r`^[a-z0-9]+[-a-z0-9]*[a-z0-9]+$`, "nested-quantifier"], // three overlapping repeats; write `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`
  [r`\w+\w+`, "nested-quantifier"], // unanchored, so the browser retries it from every position
  [r`[a-z]+`, null], // ...which one repeat can afford
  // Ambiguity without a loop is bounded: `[01]?[0-9][0-9]?` reads "10" two
  // ways, and four octets make at most 2^4. Small counts are copied out
  // rather than treated as loops, so these stay accepted.
  [r`^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$`, null], // OWASP IPv4
  [r`^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\/(?:3[0-2]|[12]?[0-9])$`, null], // ...as CIDR
  [r`^(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$`, null],
  ["(?:a|a)".repeat(20), "nested-quantifier"], // but 2^20 ways is not
  // A body that can match nothing: V8 ends `*` on an empty repetition but
  // not a counted repeat, which it spreads the text over every way it can.
  [r`^(a?){25}a{25}$`, "nested-quantifier"], // about a minute at 256 characters
  [r`^([a-z]?){20}x$`, "nested-quantifier"],
  [r`^(a?){25}$`, "nested-quantifier"],
  [r`^(a*){3}b$`, "nested-quantifier"],
  [r`^(a|){10}b$`, "nested-quantifier"],
  [r`^[a-z0-9]+(?:(?:[._]|__|[-]*)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|[-]*)[a-z0-9]+)*)*$`, "nested-quantifier"], // distribution v2 path: 20 s at 32 characters
  [r`^(@(annually|yearly|monthly|weekly|daily|hourly|reboot))|(@every (\d+(ns|us|µs|ms|s|m|h))+)|((((\d+,)+\d+|(\d+(\/|-)\d+)|\d+|\*) ?){5,7})$`, "nested-quantifier"], // cron with macros
];

describe("patternProblem", () => {
  it.each(cases)("%s → %s", (pattern, kind) => {
    expect(patternProblem(pattern)).toBe(kind);
  });

  // Scanning an unfinished pattern must not throw: `new RegExp`, not the
  // scanner, is what reports these.
  it.each(["\\", "[", "[^", "[a-", "[a-\\", "(", "(?", "(?<", "(?<a", ")", "a{", "a{1", "a{1,", "\\x", "\\x4", "[[:", "*", "|*"])(
    "does not throw on %s",
    (pattern) => {
      expect(() => patternProblem(pattern)).not.toThrow();
    },
  );

  // Only a JavaScript string can hold half a surrogate pair, so the Go table
  // has no counterpart; the API never sees one (JSON decodes it as U+FFFD).
  it("refuses a lone surrogate written into the pattern", () => {
    expect(patternProblem("^\uD83D$")).toBe("dialect");
    expect(patternProblem("^[\uDE00]$")).toBe("dialect");
  });

  // The analysis runs on every keystroke in the editor preview too.
  it.each([
    "(?:[a-z]-)*".repeat(18),
    "[a-z]*".repeat(33),
    "(a|b)".repeat(40),
    "a?".repeat(100),
    "(?:(?:(?:(?:a|b|c|d|e|f|g|h|i|j)*)*)*)*".repeat(4),
    "[\\w.-]".repeat(28),
  ])("decides %s quickly", (pattern) => {
    const started = performance.now();
    patternProblem(pattern);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

/**
 * Inputs that make a backtracking engine work hard on a pattern: every
 * character the pattern mentions — separators and class bounds included —
 * repeated, and every pair of them alternated, each ending in a character
 * that breaks the match.
 */
function adversarialInputs(pattern: string): string[] {
  const chars = new Set(["a", "0", "A", "_", "-", ".", "/", ":", ",", " "]);
  for (const ch of pattern) if (ch >= " " && ch <= "~") chars.add(ch);
  const list = [...chars];
  const out: string[] = [];
  for (const c of list) out.push(c.repeat(256) + "!", c.repeat(256) + "\n");
  for (const c of list) for (const d of list) if (c !== d) out.push((c + d).repeat(128) + "!");
  // Characters outside the BMP and lone halves of one: a flagless RegExp sees
  // each half as its own character, and `.` or a negated class matches it.
  // Lengths around every count the pattern names, and a spread of others: a
  // counted repeat fails slowest just short of the count it needs.
  const counts = new Set([7, 8, 15, 16, 31, 32, 63, 64, 127]);
  for (const m of pattern.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
    for (const d of [m[1], m[2]]) {
      const k = Number(d);
      if (d && k > 0 && k <= 255) for (const len of [k - 1, k, 2 * k - 1, 2 * k]) if (len > 0 && len <= 255) counts.add(len);
    }
  }
  for (const c of list) for (const len of counts) out.push(c.repeat(len) + "!");
  for (const c of list) out.push(("😀" + c).repeat(85) + "!");
  out.push("😀".repeat(128) + "!", "\uD83D".repeat(255) + "!", "\uDE00".repeat(255) + "!", "\uDE00\uD83D".repeat(127) + "!");
  return out;
}

// The rule is judged by what the browser does, not by the shape it looks for:
// everything the table accepts has to stay fast on inputs chosen to make it
// backtrack, at the longest value the form checks (#187).
describe("patterns patternProblem accepts run quickly in the browser's engine", () => {
  const accepted = cases.filter(([, kind]) => kind === null).map(([pattern]) => pattern);
  it.each(accepted)("%s", (pattern) => {
    // The form also runs the pattern in Unicode mode, for values that hold
    // characters outside the BMP (ui-spec-to-zod.ts).
    const regexes = [new RegExp(pattern)];
    try {
      regexes.push(new RegExp(pattern, "u"));
    } catch {
      // Not valid in Unicode mode: the form leaves such values to the API.
    }
    for (const re of regexes) for (const input of adversarialInputs(pattern)) {
      let best = Infinity;
      for (let k = 0; k < 3 && best >= 5; k++) {
        const started = performance.now();
        re.test(input);
        best = Math.min(best, performance.now() - started);
      }
      expect(best, JSON.stringify(input.slice(0, 6))).toBeLessThan(50);
    }
  });
});
