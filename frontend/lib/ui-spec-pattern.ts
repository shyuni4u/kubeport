/**
 * A ui-spec pattern is checked twice: by the API on deploy, in Go RE2, and by
 * the deploy form on every keystroke, as a JavaScript RegExp (no flags).
 * `patternProblem` names the patterns those two cannot agree on — and the ones
 * the browser could hang on. The API refuses exactly these on save
 * (backend/internal/template/pattern.go implements the same rules, and the two
 * test files share one case table — change both together), and the form sets
 * them aside, so neither side runs a rule the other does not have (#187 #189).
 *
 * A pattern that does not compile is left for `new RegExp` to report.
 */

/** Longest pattern accepted, in characters (code points, as the API counts). */
export const MAX_PATTERN_LENGTH = 200;

// Ambiguity is scored as an estimate, in bits, of the extra work a
// backtracking engine does when a match fails: two runs over the same text
// that parted and meet again at one position double it, or more.

/**
 * A merge whose runs parted and met again across a loop: where each run left
 * the loop is a choice among up to the value's length (256 characters in the
 * form), so it counts nine bits.
 */
const LOOP_MERGE_COST = 9;

/**
 * The score at which a pattern is refused. Two loop merges reach it — three
 * overlapping loops such as `^[a-z0-9]+[-a-z0-9]*[a-z0-9]+$`, an unanchored
 * `\w+\w+` — and so does any merge on a cycle, which scores without end
 * (`(a+)+`, `(a|a)*`). A merge with no loop between the parting and the
 * meeting is bounded; it counts two bits per doubling (a pair of runs sees
 * about every other independent choice), so the four octets of an IPv4
 * pattern written with `[01]?[0-9][0-9]?` fit and 2^9 choices do not.
 */
const MAX_AMBIGUITY = 18;

/**
 * A counted repeat up to this many, with no loop inside, is copied out rather
 * than treated as a loop, so the ambiguity in `(octet\.){3}` is scored as the
 * bounded thing it is.
 */
const MAX_EXPANDED_COUNT = 4;

/** Caps copying out; past it a repeat is treated as a loop, which only ever scores higher. */
const MAX_POSITIONS = 400;

/** Work spent looking; a pattern that needs more is refused as too complex. */
const ANALYSIS_BUDGET = 200_000;

export type PatternProblemKind = "too-long" | "dialect" | "nested-quantifier";

class Rejected {
  constructor(readonly kind: PatternProblemKind) {}
}

/** Not a pattern either compiler accepts; `new RegExp` reports it. */
class Incomplete {}

export function patternProblem(pattern: string): PatternProblemKind | null {
  const s = Array.from(pattern, (ch) => ch.codePointAt(0)!);
  if (s.length > MAX_PATTERN_LENGTH) return "too-long";
  // A flagless RegExp runs on UTF-16 code units, so a character outside the
  // Basic Multilingual Plane is two characters here and one to Go: `[😀]` is
  // a class of two halves, and `([😀]|[😁])+` is ambiguous because both share
  // the first half. Refusing them — and any lone half — keeps every accepted
  // pattern the same sequence of characters on both sides, which is what the
  // analysis assumes. With them gone, code points and code units also count
  // the pattern's length the same way.
  if (s.some((c) => c > 0xffff || (c >= 0xd800 && c <= 0xdfff))) return "dialect";
  try {
    const parser = new Parser(s);
    const root = parser.parseAlt();
    if (parser.i < s.length) return null;
    checkAmbiguity(parser, root);
    return null;
  } catch (e) {
    if (e instanceof Rejected) return e.kind;
    if (e instanceof Incomplete) return null;
    throw e;
  }
}

// ---- character sets: sorted, merged, inclusive code point ranges ----

type CharSet = [number, number][];

const MAX_CODE_POINT = 0x10ffff;
const cp = (ch: string) => ch.codePointAt(0)!;

function setOf(...bounds: number[]): CharSet {
  const s: CharSet = [];
  for (let i = 0; i + 1 < bounds.length; i += 2) s.push([bounds[i], bounds[i + 1]]);
  return normalizeSet(s);
}

function normalizeSet(s: CharSet): CharSet {
  const sorted = [...s].sort((a, b) => a[0] - b[0]);
  const out: CharSet = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + 1) {
      if (hi > last[1]) last[1] = hi;
      continue;
    }
    out.push([lo, hi]);
  }
  return out;
}

function negateSet(s: CharSet): CharSet {
  const out: CharSet = [];
  let next = 0;
  for (const [lo, hi] of s) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= MAX_CODE_POINT) out.push([next, MAX_CODE_POINT]);
  return out;
}

function setsIntersect(a: CharSet, b: CharSet): boolean {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i][1] < b[j][0]) i++;
    else if (b[j][1] < a[i][0]) j++;
    else return true;
  }
  return false;
}

function singleCodePoint(s: CharSet): number | undefined {
  return s.length === 1 && s[0][0] === s[0][1] ? s[0][0] : undefined;
}

// The browser's meaning of the classes, since that is where backtracking
// happens. Sets run to U+10FFFF: for a flagless RegExp, which sees only code
// units, that over-approximates (safe); for the Unicode-mode run the form uses
// on values holding surrogates, it is exact.
const DIGIT = setOf(0x30, 0x39);
const WORD = setOf(0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a);
const SPACE = setOf(
  0x09, 0x0d, 0x20, 0x20, 0xa0, 0xa0, 0x1680, 0x1680, 0x2000, 0x200a,
  0x2028, 0x2029, 0x202f, 0x202f, 0x205f, 0x205f, 0x3000, 0x3000, 0xfeff, 0xfeff,
);
const DOT = negateSet(setOf(0x0a, 0x0a, 0x0d, 0x0d, 0x2028, 0x2029));

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isAlnum = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isHex = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

// ---- parsing ----

interface PatternNode {
  op: "lit" | "empty" | "cat" | "alt" | "rep";
  /** lit: its position. */
  pos: number;
  subs: PatternNode[];
  /** rep; max < 0 is unbounded. */
  min: number;
  max: number;
  assert: boolean;
  /** The assertion is `^`. */
  caret: boolean;
  /** The source code points it covers. */
  start: number;
  end: number;
  /** The source positions created inside it. */
  posLo: number;
  posHi: number;
}

function node(fields: Partial<PatternNode> & Pick<PatternNode, "op">): PatternNode {
  return { pos: -1, subs: [], min: 0, max: 0, assert: false, caret: false, start: 0, end: 0, posLo: 0, posHi: 0, ...fields };
}

class Parser {
  i = 0;
  /** One per position (a character the pattern consumes). */
  readonly sets: CharSet[] = [];
  /** The source position each position was copied from. */
  readonly origin: number[] = [];
  private readonly names = new Set<string>();

  constructor(readonly s: number[]) {}

  private lit(set: CharSet): PatternNode {
    this.sets.push(set);
    this.origin.push(this.sets.length - 1);
    return node({ op: "lit", pos: this.sets.length - 1 });
  }

  parseAlt(): PatternNode {
    const start = this.i;
    const posLo = this.sets.length;
    const branches: PatternNode[] = [];
    for (;;) {
      branches.push(this.parseCat());
      if (this.i < this.s.length && this.s[this.i] === cp("|")) {
        this.i++;
        continue;
      }
      break;
    }
    if (branches.length === 1) return branches[0];
    return node({ op: "alt", subs: branches, start, end: this.i, posLo, posHi: this.sets.length });
  }

  private parseCat(): PatternNode {
    const cat = node({ op: "cat", start: this.i, posLo: this.sets.length });
    const s = this.s;
    while (this.i < s.length && s[this.i] !== cp("|") && s[this.i] !== cp(")")) {
      const start = this.i;
      const posLo = this.sets.length;
      let atom = this.parseAtom();
      const q = this.quantifierAt(this.i);
      if (q) {
        if (atom.assert) throw new Rejected("dialect");
        this.i += q.size;
        if (this.i < s.length && s[this.i] === cp("?")) this.i++;
        // A repeat of a repeat (`a**`, `a{2}{3}`): both compilers refuse it.
        if (this.quantifierAt(this.i)) throw new Incomplete();
        atom = node({
          op: "rep", subs: [atom], min: q.min, max: q.max,
          start, end: this.i, posLo, posHi: this.sets.length,
        });
      }
      cat.subs.push(atom);
    }
    cat.end = this.i;
    cat.posHi = this.sets.length;
    return cat;
  }

  private parseAtom(): PatternNode {
    const s = this.s;
    const i = this.i;
    switch (s[i]) {
      case cp("("): {
        const size = scanGroupOpen(s, i, this.names);
        const posLo = this.sets.length;
        this.i += size;
        const inner = this.parseAlt();
        if (this.i >= s.length || s[this.i] !== cp(")")) throw new Incomplete();
        this.i++;
        // Wrapped, so that a group around an assertion — `(^)*` — is not one.
        return node({ op: "cat", subs: [inner], start: i, end: this.i, posLo, posHi: this.sets.length });
      }
      case cp("["): {
        const [set, size] = scanClass(s, i);
        this.i += size;
        return this.lit(set);
      }
      case cp("\\"): {
        const esc = scanEscape(s, i, false);
        this.i += esc.size;
        return esc.assert ? node({ op: "empty", assert: true }) : this.lit(esc.set);
      }
      case cp("^"):
      case cp("$"):
        this.i++;
        return node({ op: "empty", assert: true, caret: s[i] === cp("^") });
      case cp("."):
        this.i++;
        return this.lit(DOT);
      case cp("*"):
      case cp("+"):
      case cp("?"):
        throw new Incomplete();
      case cp("{"):
        // A brace is literal text unless it is a counted repeat, and a repeat
        // with nothing before it is refused by both compilers.
        if (this.quantifierAt(i)) throw new Incomplete();
    }
    this.i++;
    return this.lit(setOf(s[i], s[i]));
  }

  /** The quantifier at s[i], or null when there is none. */
  private quantifierAt(i: number): { min: number; max: number; size: number } | null {
    if (i >= this.s.length) return null;
    switch (this.s[i]) {
      case cp("*"):
        return { min: 0, max: -1, size: 1 };
      case cp("+"):
        return { min: 1, max: -1, size: 1 };
      case cp("?"):
        return { min: 0, max: 1, size: 1 };
      case cp("{"):
        return scanRepeat(this.s, i);
    }
    return null;
  }

  clone(nd: PatternNode): PatternNode {
    if (nd.op === "lit") {
      this.sets.push(this.sets[nd.pos]);
      this.origin.push(this.origin[nd.pos]);
      return { ...nd, pos: this.sets.length - 1 };
    }
    return { ...nd, subs: nd.subs.map((sub) => this.clone(sub)) };
  }
}

/**
 * The escape at s[i] === "\\". Letters and digits are an allowlist: what is
 * not on it either does not compile in Go or means something else here (`\A`,
 * `\z`, `\pL`, `\Q`, `\a`, `\1`, `\u`), and `new RegExp` reads them all
 * without complaint.
 */
function scanEscape(s: number[], i: number, inClass: boolean): { set: CharSet; assert: boolean; size: number } {
  const n = s.length;
  if (i + 1 >= n) throw new Incomplete();
  const c = s[i + 1];
  if (c >= 0x80) throw new Rejected("dialect");
  const lit = (v: number, size: number) => ({ set: setOf(v, v), assert: false, size });
  if (!isAlnum(c)) return lit(c, 2);
  const cls = (set: CharSet) => ({ set, assert: false, size: 2 });
  switch (String.fromCharCode(c)) {
    case "f":
      return lit(0x0c, 2);
    case "n":
      return lit(0x0a, 2);
    case "r":
      return lit(0x0d, 2);
    case "t":
      return lit(0x09, 2);
    case "v":
      return lit(0x0b, 2);
    case "0": {
      // Octal: both engines take up to two more octal digits.
      let v = 0;
      let size = 2;
      while (size < 4 && i + size < n && s[i + size] >= 0x30 && s[i + size] <= 0x37) {
        v = v * 8 + s[i + size] - 0x30;
        size++;
      }
      return lit(v, size);
    }
    case "x":
      if (i + 3 < n && isHex(s[i + 2]) && isHex(s[i + 3])) {
        return lit(parseInt(String.fromCharCode(s[i + 2], s[i + 3]), 16), 4);
      }
      throw new Rejected("dialect");
    case "d":
      return cls(DIGIT);
    case "D":
      return cls(negateSet(DIGIT));
    case "w":
      return cls(WORD);
    case "W":
      return cls(negateSet(WORD));
    case "s":
      return cls(SPACE);
    case "S":
      return cls(negateSet(SPACE));
    case "b":
    case "B":
      if (!inClass) return { set: [], assert: true, size: 2 };
  }
  throw new Rejected("dialect");
}

/** The class at s[i] === "[". */
function scanClass(s: number[], i: number): [CharSet, number] {
  const n = s.length;
  let j = i + 1;
  let negate = false;
  if (j < n && s[j] === cp("^")) {
    negate = true;
    j++;
  }
  // Go takes a leading `]` as a member; here it closes an empty class.
  if (j < n && s[j] === cp("]")) throw new Rejected("dialect");
  const member = (k: number): [CharSet, number] => {
    if (s[k] === cp("\\")) {
      const esc = scanEscape(s, k, true);
      return [esc.set, esc.size];
    }
    return [setOf(s[k], s[k]), 1];
  };
  const members: CharSet = [];
  while (j < n && s[j] !== cp("]")) {
    // Go's rule: `[:` with a `:]` anywhere after it is a POSIX class (or an
    // error). Here it is plain members.
    if (s[j] === cp("[") && j + 1 < n && s[j + 1] === cp(":") && String.fromCodePoint(...s.slice(j + 2)).includes(":]")) {
      throw new Rejected("dialect");
    }
    const [lo, size] = member(j);
    j += size;
    const from = singleCodePoint(lo);
    if (from !== undefined && j + 1 < n && s[j] === cp("-") && s[j + 1] !== cp("]")) {
      const [hi, hiSize] = member(j + 1);
      j += 1 + hiSize;
      const to = singleCodePoint(hi);
      // `[a-\d]`: Go refuses it; this reads a, -, and the class.
      if (to === undefined) throw new Rejected("dialect");
      if (to < from) throw new Incomplete();
      members.push([from, to]);
      continue;
    }
    members.push(...lo);
  }
  if (j >= n) throw new Incomplete();
  const set = normalizeSet(members);
  return [negate ? negateSet(set) : set, j + 1 - i];
}

/** The length of the group opening at s[i] === "(". */
function scanGroupOpen(s: number[], i: number, names: Set<string>): number {
  const n = s.length;
  if (i + 1 >= n || s[i + 1] !== cp("?")) return 1;
  if (i + 2 >= n) throw new Incomplete();
  switch (String.fromCodePoint(s[i + 2])) {
    case ":":
      return 3;
    case "<": {
      // Lookbehind: Go does not support it.
      if (i + 3 < n && (s[i + 3] === cp("=") || s[i + 3] === cp("!"))) throw new Rejected("dialect");
      const end = s.indexOf(cp(">"), i + 3);
      if (end < 0) throw new Incomplete();
      const name = String.fromCodePoint(...s.slice(i + 3, end));
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.has(name)) throw new Rejected("dialect");
      names.add(name);
      return end + 1 - i;
    }
    default:
      // `(?P<name>`, flags such as `(?i)`, lookahead: only `(?:` and
      // `(?<name>` mean the same in both engines.
      throw new Rejected("dialect");
  }
}

/**
 * A counted repeat at s[i] === "{", or null when the brace is literal text —
 * which it is in both engines unless it is `{n}`, `{n,}` or `{n,m}`.
 */
function scanRepeat(s: number[], i: number): { min: number; max: number; size: number } | null {
  const n = s.length;
  const digitsAt = (k: number) => {
    let e = k;
    while (e < n && isDigit(s[e])) e++;
    return String.fromCharCode(...s.slice(k, e));
  };
  let j = i + 1;
  const lo = digitsAt(j);
  if (lo === "") return null;
  j += lo.length;
  let hi = lo;
  let comma = false;
  if (j < n && s[j] === cp(",")) {
    comma = true;
    j++;
    hi = digitsAt(j);
    j += hi.length;
  }
  if (j >= n || s[j] !== cp("}")) return null;
  j++;
  // Go reads `{01}` as literal text; here it is a count.
  if ([lo, hi].some((d) => d.length > 1 && d[0] === "0")) throw new Rejected("dialect");
  return { min: repeatCount(lo), max: !comma || hi !== "" ? repeatCount(hi) : -1, size: j - i };
}

function repeatCount(digits: string): number {
  let v = 0;
  for (const d of digits) if (v <= 100000) v = v * 10 + Number(d);
  return v;
}

// ---- ambiguity ----

const loops = (nd: PatternNode) => nd.op === "rep" && (nd.max < 0 || nd.max >= 2);

function nullable(nd: PatternNode): boolean {
  switch (nd.op) {
    case "lit":
      return false;
    case "empty":
      return true;
    case "alt":
      return nd.subs.some(nullable);
    case "rep":
      return nd.max === 0 || nd.min === 0 || nullable(nd.subs[0]);
  }
  return nd.subs.every(nullable);
}

/**
 * A repeat of more than one whose body can match nothing. The browser ends
 * `*` and `+` at an empty repetition, but a counted repeat such as `(a?){25}`
 * it spreads the text over its repetitions in every way it can: a minute at
 * 256 characters. No ui-spec needs one, so all are refused.
 */
function refuseEmptyRepeats(nd: PatternNode): void {
  if (loops(nd) && nullable(nd.subs[0])) throw new Rejected("nested-quantifier");
  nd.subs.forEach(refuseEmptyRepeats);
}

const hasLoop = (nd: PatternNode): boolean => loops(nd) || nd.subs.some(hasLoop);

const countPositions = (nd: PatternNode): number =>
  nd.op === "lit" ? 1 : nd.subs.reduce((c, sub) => c + countPositions(sub), 0);

/**
 * Copies out a counted repeat of at most MAX_EXPANDED_COUNT with no loop
 * inside — `x{1,3}` becomes `x(x(x)?)?` — so its bounded ambiguity is scored as
 * bounded instead of as a loop's.
 */
function expand(parser: Parser, nd: PatternNode): PatternNode {
  const c: PatternNode = { ...nd, subs: nd.subs.map((sub) => expand(parser, sub)) };
  if (
    !loops(c) || c.max > MAX_EXPANDED_COUNT || c.min > c.max || hasLoop(c.subs[0]) ||
    parser.sets.length + countPositions(c.subs[0]) * (c.max - 1) > MAX_POSITIONS
  ) {
    return c;
  }
  const copies = [c.subs[0]];
  while (copies.length < c.max) copies.push(parser.clone(c.subs[0]));
  const wrap = (op: "cat" | "rep", subs: PatternNode[]) =>
    node({ op, subs, min: 0, max: 1, start: c.start, end: c.end, posLo: c.posLo, posHi: c.posHi });
  let tail: PatternNode | null = null;
  for (let i = c.max - 1; i >= c.min; i--) {
    tail = wrap("rep", [tail ? wrap("cat", [copies[i], tail]) : copies[i]]);
  }
  const out = wrap("cat", copies.slice(0, c.min));
  if (tail) out.subs.push(tail);
  return out;
}

/**
 * One node of the pattern as a position automaton that keeps count (up to 2)
 * of how many distinct ways lead to each position.
 */
interface Glushkov {
  nullable: number;
  first: Uint8Array;
  last: Uint8Array;
}

const cap2 = (v: number) => (v > 2 ? 2 : v);

function nonZero(v: Uint8Array): number[] {
  const idx: number[] = [];
  v.forEach((x, i) => {
    if (x !== 0) idx.push(i);
  });
  return idx;
}

function ceilLog2(v: number): number {
  let bits = 0;
  while (2 ** bits < v) bits++;
  return bits;
}

class AmbiguityAnalyzer {
  /** n*n: ways from one position straight to the next. */
  readonly follow: Uint8Array;
  /** n*n: the transition goes around a loop. */
  readonly loopEdge: Uint8Array;

  constructor(readonly n: number) {
    this.follow = new Uint8Array(n * n);
    this.loopEdge = new Uint8Array(n * n);
  }

  private connect(last: Uint8Array, first: Uint8Array, loop: boolean) {
    for (const x of nonZero(last)) {
      for (const y of nonZero(first)) {
        const k = x * this.n + y;
        this.follow[k] = cap2(this.follow[k] + last[x] * first[y]);
        if (loop) this.loopEdge[k] = 1;
      }
    }
  }

  info(nd: PatternNode): Glushkov {
    const n = this.n;
    const g: Glushkov = { nullable: 0, first: new Uint8Array(n), last: new Uint8Array(n) };
    switch (nd.op) {
      case "lit":
        g.first[nd.pos] = 1;
        g.last[nd.pos] = 1;
        break;
      case "empty":
        g.nullable = 1;
        break;
      case "cat":
        g.nullable = 1;
        for (const sub of nd.subs) {
          const b = this.info(sub);
          this.connect(g.last, b.first, false);
          for (let y = 0; y < n; y++) {
            g.first[y] = cap2(g.first[y] + g.nullable * b.first[y]);
            g.last[y] = cap2(b.last[y] + b.nullable * g.last[y]);
          }
          g.nullable = cap2(g.nullable * b.nullable);
        }
        break;
      case "alt":
        for (const sub of nd.subs) {
          const b = this.info(sub);
          for (let y = 0; y < n; y++) {
            g.first[y] = cap2(g.first[y] + b.first[y]);
            g.last[y] = cap2(g.last[y] + b.last[y]);
          }
          g.nullable = cap2(g.nullable + b.nullable);
        }
        break;
      case "rep": {
        if (nd.max === 0) {
          g.nullable = 1;
          break;
        }
        const b = this.info(nd.subs[0]);
        g.first = b.first;
        g.last = b.last;
        if (nd.max === 1) {
          g.nullable = nd.min === 0 ? cap2(b.nullable + 1) : b.nullable;
        } else {
          // A count above MAX_EXPANDED_COUNT is treated as unbounded:
          // `(a{1,20})+` backtracks like `(a+)+`. Its body cannot match
          // nothing — refuseEmptyRepeats saw to that — so every repetition
          // consumes and only non-empty ones connect.
          this.connect(b.last, b.first, true);
          g.nullable = nd.min === 0 ? 1 : b.nullable;
        }
        break;
      }
    }
    return g;
  }
}

/**
 * Walks pairs of runs over the same text, starting together, and scores each
 * time two runs that parted meet again at one position.
 */
function checkAmbiguity(parser: Parser, parsed: PatternNode): void {
  refuseEmptyRepeats(parsed);
  const root = expand(parser, parsed);
  if (parser.sets.length === 0) return;
  // A pattern that does not start with `^` is tried again from every position
  // of the value. Model that as a loop over any character in front of it, at
  // position parser.sets.length.
  const anchored = root.op === "cat" && root.subs.length > 0 && root.subs[0].caret;
  const sets = anchored ? parser.sets : [...parser.sets, [[0, MAX_CODE_POINT]] as CharSet];
  const n = sets.length;
  const a = new AmbiguityAnalyzer(n);
  const start = a.info(root);
  if (!anchored) {
    const prefix = n - 1;
    a.follow[prefix * n + prefix] = 1;
    a.loopEdge[prefix * n + prefix] = 1;
    for (const y of nonZero(start.first)) a.follow[prefix * n + y] = start.first[y];
    start.first[prefix] = 1;
  }

  const compat = new Uint8Array(n * n);
  const succ: number[][] = Array.from({ length: n }, () => []);
  const inWays = new Int32Array(n);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      compat[x * n + y] = setsIntersect(sets[x], sets[y]) ? 1 : 0;
      if (a.follow[x * n + y] > 0) {
        succ[x].push(y);
        inWays[y] += a.follow[x * n + y];
      }
    }
  }
  // A merge with no loop between parting and meeting: the ways into the
  // position bound how many runs meet there.
  const finiteMerge = (x: number) => 2 * ceilLog2(Math.max(2, inWays[x]));

  // State: a pair of positions, and for a pair that has parted, whether the
  // parting has gone around a loop since.
  const key = (u: number, v: number, acrossLoop: boolean) => (u * n + v) * 2 + (acrossLoop ? 1 : 0);
  const dist = new Int32Array(2 * n * n).fill(-1);
  const queued = new Uint8Array(2 * n * n);
  const queue: number[] = [];
  const relax = (k: number, w: number) => {
    if (w <= dist[k]) return;
    dist[k] = w;
    if (w >= MAX_AMBIGUITY) throw new Rejected("nested-quantifier");
    if (!queued[k]) {
      queued[k] = 1;
      queue.push(k);
    }
  };

  const firsts = nonZero(start.first);
  for (const x of firsts) {
    for (const y of firsts) {
      if (!compat[x * n + y]) continue;
      relax(key(x, y, false), x === y && start.first[x] === 2 ? 2 : 0);
    }
  }
  let work = 0;
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head];
    queued[k] = 0;
    const pair = Math.floor(k / 2);
    const u = Math.floor(pair / n);
    const v = pair % n;
    const parted = k % 2 === 1;
    for (const x of succ[u]) {
      for (const y of succ[v]) {
        if (++work > ANALYSIS_BUDGET) throw new Rejected("nested-quantifier");
        if (!compat[x * n + y]) continue;
        let w = dist[k];
        let acrossLoop = parted || a.loopEdge[u * n + x] === 1 || a.loopEdge[v * n + y] === 1;
        if (u === v && x === y) {
          if (a.follow[u * n + x] === 2) w += a.loopEdge[u * n + x] ? LOOP_MERGE_COST : 2;
          relax(key(x, x, false), w);
        } else if (x === y) {
          w += acrossLoop ? LOOP_MERGE_COST : finiteMerge(x);
          relax(key(x, x, false), w);
        } else {
          if (u === v) acrossLoop = a.loopEdge[u * n + x] === 1 || a.loopEdge[u * n + y] === 1;
          relax(key(x, y, acrossLoop), w);
        }
      }
    }
  }
}
