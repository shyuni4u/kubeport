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

describe("messages", () => {
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
});
