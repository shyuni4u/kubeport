import { describe, expect, it } from "vitest";

import en from "./en.json";
import ko from "./ko.json";

/**
 * Every test that renders with next-intl uses the Korean bundle, so a key
 * added to only one locale goes unnoticed until an English-locale user hits
 * a MISSING_MESSAGE at runtime. Pin the two bundles to the same key set.
 */
function leafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([k, v]) =>
    leafKeys(v, prefix ? `${prefix}.${k}` : k),
  );
}

/**
 * Argument names in an ICU message. A select's branch bodies are text, not
 * arguments — in `{kube, select, true {This pod} other {…}}` there is no
 * placeholder named "This" — so walk the message rather than match every
 * brace, which took a Latin branch's first word for one (#260 review).
 */
function placeholders(s: string): string[] {
  const names: string[] = [];
  let i = 0;
  // Text up to the `}` that closes the enclosing branch, or the end.
  const text = (): void => {
    while (i < s.length && s[i] !== "}") {
      if (s[i] === "{") argument();
      else i++;
    }
  };
  const argument = (): void => {
    i++; // {
    const head = /^\s*(\w+)\s*(?:,\s*(\w+)\s*)?/.exec(s.slice(i));
    if (head) {
      names.push(head[1]);
      i += head[0].length;
    }
    if (head && ["select", "plural", "selectordinal"].includes(head[2] ?? "")) {
      i++; // the comma before the branches
      for (;;) {
        const branch = /^\s*(?:offset:\d+\s*)?=?\w+\s*\{/.exec(s.slice(i));
        if (!branch) break;
        i += branch[0].length;
        text();
        i++; // } closing the branch
      }
      while (i < s.length && s[i] !== "}") i++;
    } else {
      // `{name}` or `{n, number, style}`: nothing nested to read.
      while (i < s.length && s[i] !== "}") i++;
    }
    i++; // } closing the argument
  };
  while (i < s.length) {
    text();
    i++; // a stray } at the top level
  }
  return names.sort();
}

describe("messages", () => {
  it("reads a select's branches as text, and arguments inside them as arguments", () => {
    expect(placeholders("{kube, select, true {This pod} other {This instance}} ended")).toEqual(["kube"]);
    expect(placeholders("{n, plural, one {# item} other {{n} items in {where}}}")).toEqual(["n", "n", "where"]);
    expect(placeholders("{count}개 중 {total}, {n, number, integer}")).toEqual(["count", "n", "total"]);
  });

  it("ko 와 en 의 키 집합이 같다", () => {
    const koKeys = leafKeys(ko).sort();
    const enKeys = leafKeys(en).sort();
    expect(koKeys).toEqual(enKeys);
  });

  it("빈 문자열 값이 없다", () => {
    for (const [locale, bundle] of [
      ["ko", ko],
      ["en", en],
    ] as const) {
      const empty = leafKeys(bundle).filter((path) => {
        const value = path
          .split(".")
          .reduce<unknown>(
            (acc, k) => (acc as Record<string, unknown>)?.[k],
            bundle,
          );
        return typeof value === "string" && value.trim() === "";
      });
      expect(empty, `${locale} 에 빈 문자열 키가 있습니다`).toEqual([]);
    }
  });

  // Interpolations are part of the contract: `{count}` in one locale and
  // `{total}` in the other silently renders the placeholder.
  it("양쪽 로케일이 같은 플레이스홀더를 쓴다", () => {
    const read = (bundle: unknown, path: string): unknown =>
      path
        .split(".")
        .reduce<unknown>(
          (acc, k) => (acc as Record<string, unknown>)?.[k],
          bundle,
        );

    for (const key of leafKeys(ko).sort()) {
      const k = read(ko, key);
      const e = read(en, key);
      if (typeof k !== "string" || typeof e !== "string") continue;
      expect(placeholders(e), `placeholders differ at ${key}`).toEqual(
        placeholders(k),
      );
    }
  });
});
