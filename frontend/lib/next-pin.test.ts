import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const pkg = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf8"),
);

// next and eslint-config-next are pinned to the same exact version on
// purpose (.github/dependabot.yml, `next` group). dependabot has split the
// pair before (#454: next went out in the prod group, eslint-config-next
// stayed behind), so the pin is checked here rather than trusted to config.
describe("next pin", () => {
  const next = pkg.dependencies?.next;
  const eslintConfig = pkg.devDependencies?.["eslint-config-next"];

  it("pins next to an exact version", () => {
    expect(next).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("keeps eslint-config-next on the same version as next", () => {
    expect(eslintConfig).toBe(next);
  });
});
