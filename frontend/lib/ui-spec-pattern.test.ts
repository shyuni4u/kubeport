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
  // A repeated group that opens with a literal no inner repeat can match
  // splits the input one way only, so it cannot backtrack catastrophically.
  [r`^[a-z]+(?:-[a-z]+)*$`, null],
  [r`^(/[^/]+)+$`, null],
  [r`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`, null], // k8s DNS-1123 subdomain
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
});
