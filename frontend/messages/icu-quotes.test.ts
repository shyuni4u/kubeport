import { describe, expect, it } from "vitest";

import en from "./en.json";
import ko from "./ko.json";

// In ICU MessageFormat a lone apostrophe opens a quoted literal, so '{owner}'
// renders as the text "{owner}" rather than the value, with no error anywhere.
// The convention here is to double it: ''{name}'' prints 'name-value'.
//
// This happened in #161, and was caught only because a component test rendered
// that one message in Korean. The English copy had the same mistake and no test
// that would ever render it, which is why this checks every message instead.
function leaves(node: unknown, path = ""): Array<[string, string]> {
  if (typeof node === "string") return [[path, node]];
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([key, value]) =>
      leaves(value, path ? `${path}.${key}` : key),
    );
  }
  return [];
}

describe("messages", () => {
  it.each([
    ["ko", ko],
    ["en", en],
  ])("%s has no placeholder swallowed by a lone apostrophe", (_locale, messages) => {
    const swallowed = leaves(messages).filter(([, text]) => /(?<!')'\{/.test(text));
    expect(swallowed).toEqual([]);
  });
});
