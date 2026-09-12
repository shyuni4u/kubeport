/**
 * A ui-spec pattern is checked twice: by the API on deploy, in Go RE2, and by
 * the deploy form on every keystroke, as a JavaScript RegExp (no flags).
 * `patternProblem` names the patterns those two cannot agree on — and the ones
 * the browser could hang on. The API refuses exactly these on save
 * (backend/internal/template/pattern.go implements the same rules, and the two
 * test files share one case table — change both together), and the form sets
 * them aside, so neither side runs a rule the other does not have (#187 #189).
 *
 * It is a scanner, not a parser: a pattern that does not compile is left for
 * `new RegExp` to report.
 */

/** Longest pattern accepted, in characters (code points, as the API counts). */
export const MAX_PATTERN_LENGTH = 200;

export type PatternProblemKind = "too-long" | "dialect" | "nested-quantifier";

/**
 * "Could this atom match c?" It may say yes too often (always safe here),
 * never no too often.
 */
type CharSet = (c: number) => boolean;

const anyChar: CharSet = () => true;

interface Frame {
  hasAlt: boolean;
  hasFirst: boolean;
  firstLit: number | undefined;
  firstQuantified: boolean;
  /** Every atom in the body, nested groups included, under `*`, `+` or `{n,}`. */
  unbounded: CharSet[];
}

interface Item {
  kind: "none" | "assert" | "atom" | "group";
  set: CharSet;
  /** `set` is exact, so a negated class may use it. */
  exact: boolean;
  lit?: number;
  group?: Frame;
  /** The first item of its group's body. */
  first?: boolean;
}

class Rejected {
  constructor(readonly kind: PatternProblemKind) {}
}

const NONE: Item = { kind: "none", set: anyChar, exact: false };
const ASSERT: Item = { kind: "assert", set: anyChar, exact: false };

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isAlnum = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isWord = (c: number) => isAlnum(c) || c === 0x5f;
const isSpace = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d);
const isHex = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const cp = (ch: string) => ch.codePointAt(0)!;

function literal(c: number): Item {
  return { kind: "atom", set: (r) => r === c, exact: true, lit: c };
}

/**
 * Whether repeating this group can split one input many ways. That needs an
 * unlimited repeat inside. It is ruled out when every repetition must open
 * with the same literal that none of those inner repeats can match —
 * `(-[a-z]+)*`, `(\.[a-z0-9]+)*` — because then each repetition starts at
 * exactly one place.
 */
function canBacktrackCatastrophically(f: Frame): boolean {
  if (f.unbounded.length === 0) return false;
  if (f.hasAlt || f.firstLit === undefined || f.firstQuantified) return true;
  const lit = f.firstLit;
  return f.unbounded.some((set) => set(lit));
}

export function patternProblem(pattern: string): PatternProblemKind | null {
  const s = Array.from(pattern, cp);
  if (s.length > MAX_PATTERN_LENGTH) return "too-long";
  try {
    scan(s);
    return null;
  } catch (e) {
    if (e instanceof Rejected) return e.kind;
    throw e;
  }
}

function scan(s: number[]): void {
  const n = s.length;
  const stack: Frame[] = [newFrame()];
  const names = new Set<string>();
  let last: Item = NONE;

  const top = () => stack[stack.length - 1];
  const emit = (it: Item) => {
    const f = top();
    if (!f.hasFirst) {
      f.hasFirst = true;
      f.firstLit = it.lit;
      it = { ...it, first: true };
    }
    last = it;
  };
  const quantify = (repeats: boolean, unbounded: boolean) => {
    const it = last;
    last = NONE;
    if (it.kind === "none") return; // `*` with nothing before it: both compilers refuse it
    if (it.kind === "assert") throw new Rejected("dialect");
    const f = top();
    if (it.first) f.firstQuantified = true;
    if (unbounded) f.unbounded.push(it.set);
    if (it.kind === "group" && repeats && canBacktrackCatastrophically(it.group!)) {
      throw new Rejected("nested-quantifier");
    }
  };

  for (let i = 0; i < n; ) {
    const c = s[i];
    switch (c) {
      case cp("\\"): {
        const [it, size] = scanEscape(s, i, false);
        if (size === 0) return;
        emit(it);
        i += size;
        break;
      }
      case cp("["): {
        const [it, size] = scanClass(s, i);
        if (size === 0) return;
        emit(it);
        i += size;
        break;
      }
      case cp("("): {
        const size = scanGroupOpen(s, i, names);
        if (size === 0) return;
        stack.push(newFrame());
        last = NONE;
        i += size;
        break;
      }
      case cp(")"): {
        if (stack.length === 1) return;
        const f = stack.pop()!;
        top().unbounded.push(...f.unbounded);
        emit({ kind: "group", set: anyChar, exact: false, group: f });
        i++;
        break;
      }
      case cp("|"):
        top().hasAlt = true;
        last = NONE;
        i++;
        break;
      case cp("^"):
      case cp("$"):
        emit(ASSERT);
        i++;
        break;
      case cp("*"):
      case cp("+"):
      case cp("?"):
        quantify(c !== cp("?"), c !== cp("?"));
        i++;
        if (i < n && s[i] === cp("?")) i++;
        break;
      case cp("{"): {
        const repeat = scanRepeat(s, i);
        if (repeat === null) {
          emit(literal(c));
          i++;
          break;
        }
        quantify(repeat.repeats, repeat.unbounded);
        i += repeat.size;
        if (i < n && s[i] === cp("?")) i++;
        break;
      }
      case cp("."):
        emit({ kind: "atom", set: anyChar, exact: false });
        i++;
        break;
      default:
        emit(literal(c));
        i++;
    }
  }
}

function newFrame(): Frame {
  return { hasAlt: false, hasFirst: false, firstLit: undefined, firstQuantified: false, unbounded: [] };
}

/**
 * The escape at s[i] === "\\". Size 0 means the pattern ends there. Letters
 * and digits are an allowlist: what is not on it either does not compile in
 * Go or means something else here (`\A`, `\z`, `\pL`, `\Q`, `\a`, `\1`), and
 * `new RegExp` reads them all without complaint.
 */
function scanEscape(s: number[], i: number, inClass: boolean): [Item, number] {
  const n = s.length;
  if (i + 1 >= n) return [NONE, 0];
  const c = s[i + 1];
  if (c >= 0x80) throw new Rejected("dialect");
  if (!isAlnum(c)) return [literal(c), 2];
  switch (String.fromCharCode(c)) {
    case "f":
      return [literal(0x0c), 2];
    case "n":
      return [literal(0x0a), 2];
    case "r":
      return [literal(0x0d), 2];
    case "t":
      return [literal(0x09), 2];
    case "v":
      return [literal(0x0b), 2];
    case "0": {
      // Octal: both engines take up to two more octal digits.
      let size = 2;
      while (size < 4 && i + size < n && s[i + size] >= 0x30 && s[i + size] <= 0x37) size++;
      return [{ kind: "atom", set: anyChar, exact: false }, size];
    }
    case "x":
      if (i + 3 < n && isHex(s[i + 2]) && isHex(s[i + 3])) {
        return [literal(parseInt(String.fromCharCode(s[i + 2], s[i + 3]), 16)), 4];
      }
      throw new Rejected("dialect");
    case "d":
      return [{ kind: "atom", set: isDigit, exact: true }, 2];
    case "D":
      return [{ kind: "atom", set: (r) => !isDigit(r), exact: true }, 2];
    case "w":
      return [{ kind: "atom", set: isWord, exact: true }, 2];
    case "W":
      return [{ kind: "atom", set: (r) => !isWord(r), exact: true }, 2];
    case "s":
      // This \s also takes Unicode spaces; say yes to all of those.
      return [{ kind: "atom", set: (r) => isSpace(r) || r >= 0x80, exact: false }, 2];
    case "S":
      return [{ kind: "atom", set: anyChar, exact: false }, 2];
    case "b":
    case "B":
      if (!inClass) return [ASSERT, 2];
  }
  throw new Rejected("dialect");
}

/** The class at s[i] === "[". Size 0 means it is not closed. */
function scanClass(s: number[], i: number): [Item, number] {
  const n = s.length;
  let j = i + 1;
  let negate = false;
  if (j < n && s[j] === cp("^")) {
    negate = true;
    j++;
  }
  // Go takes a leading `]` as a member; here it closes an empty class.
  if (j < n && s[j] === cp("]")) throw new Rejected("dialect");
  const member = (k: number): [Item, number] => (s[k] === cp("\\") ? scanEscape(s, k, true) : [literal(s[k]), 1]);
  const parts: CharSet[] = [];
  let exact = true;
  while (j < n && s[j] !== cp("]")) {
    // Go's rule: `[:` with a `:]` anywhere after it is a POSIX class (or an
    // error). Here it is plain members.
    if (s[j] === cp("[") && j + 1 < n && s[j + 1] === cp(":") && String.fromCodePoint(...s.slice(j + 2)).includes(":]")) {
      throw new Rejected("dialect");
    }
    const [lo, size] = member(j);
    if (size === 0) return [NONE, 0];
    j += size;
    if (lo.lit !== undefined && j + 1 < n && s[j] === cp("-") && s[j + 1] !== cp("]")) {
      const [hi, hiSize] = member(j + 1);
      if (hiSize === 0) return [NONE, 0];
      j += 1 + hiSize;
      if (hi.lit !== undefined) {
        const from = lo.lit;
        const to = hi.lit;
        parts.push((r) => r >= from && r <= to);
      } else {
        parts.push(anyChar);
        exact = false;
      }
      continue;
    }
    parts.push(lo.set);
    exact = exact && lo.exact;
  }
  if (j >= n) return [NONE, 0];
  let set: CharSet = (r) => (parts.some((part) => part(r)) ? !negate : negate);
  if (negate && !exact) set = anyChar;
  return [{ kind: "atom", set, exact }, j + 1 - i];
}

/** The group opening at s[i] === "(". Size 0 means the pattern ends inside it. */
function scanGroupOpen(s: number[], i: number, names: Set<string>): number {
  const n = s.length;
  if (i + 1 >= n || s[i + 1] !== cp("?")) return 1;
  if (i + 2 >= n) return 0;
  switch (String.fromCodePoint(s[i + 2])) {
    case ":":
      return 3;
    case "<": {
      // Lookbehind: Go does not support it.
      if (i + 3 < n && (s[i + 3] === cp("=") || s[i + 3] === cp("!"))) throw new Rejected("dialect");
      const end = s.indexOf(cp(">"), i + 3);
      if (end < 0) return 0;
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
function scanRepeat(s: number[], i: number): { size: number; repeats: boolean; unbounded: boolean } | null {
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
  const unbounded = comma && hi === "";
  return { size: j - i, repeats: unbounded || hi.length > 1 || hi > "1", unbounded };
}
