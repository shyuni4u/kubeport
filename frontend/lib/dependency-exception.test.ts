import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

it("keeps the reviewed picomatch exception away from translation extraction", () => {
  const config = readFileSync(join(__dirname, "../next.config.ts"), "utf8");
  // A plugin options object can enable the dev extraction watcher. Reassess
  // its input boundary before expanding this deliberately narrow invocation.
  expect(config).toMatch(/createNextIntlPlugin\("\.\/i18n\/request\.ts"\)/);
  expect(config).not.toMatch(/\bextract\s*:/);
});
