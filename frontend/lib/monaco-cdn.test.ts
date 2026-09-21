import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  MONACO_CDN,
  MONACO_VERSION,
  MONACO_VS_PATH,
  pinMonacoSource,
} from "./monaco-cdn";
import { defaultCsp } from "./security-headers";

const pkg = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf8"),
);

// The version @monaco-editor/loader would fetch if nothing configured it.
function loaderDefault(): string {
  const fromReact = createRequire(require.resolve("@monaco-editor/react"));
  const loaderPkg = fromReact.resolve("@monaco-editor/loader/package.json");
  const config = readFileSync(
    join(dirname(loaderPkg), "lib/es/config/index.js"),
    "utf8",
  );
  const vs = /vs:\s*'([^']+)'/.exec(config)?.[1];
  expect(vs, "loader config vs path").toBeTruthy();
  return /monaco-editor@([^/]+)\//.exec(vs!)![1];
}

// True when a is the same version as b or newer.
function atLeast(a: string, b: string): boolean {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return true;
}

// The first Monaco build that stopped vendoring DOMPurify 3.2.7, the version
// that put 18 advisories in `pnpm audit --prod` (#438). Going back below this
// reintroduces all of them in the code an admin's browser runs.
const DOMPURIFY_FLOOR = "0.56.0";

describe("the Monaco build this app runs", () => {
  // Monaco vendors its own DOMPurify, so this version — not the npm
  // dependency tree — decides which sanitizer runs in the browser (#438).
  it("is pinned to one version across the CDN path, the vs path and the types", () => {
    expect(MONACO_CDN).toBe(
      `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/`,
    );
    expect(MONACO_VS_PATH).toBe(`${MONACO_CDN}min/vs`);
    // Exact, not a range: the types must describe the build being fetched.
    expect(pkg.devDependencies["monaco-editor"]).toBe(MONACO_VERSION);
  });

  it("is the path the CSP allows", () => {
    expect(defaultCsp(false)).toContain(MONACO_CDN);
  });

  it("passes MONACO_VS_PATH to loader.config", () => {
    const loader = { config: vi.fn() };
    pinMonacoSource(loader);
    expect(loader.config).toHaveBeenCalledWith({
      paths: { vs: MONACO_VS_PATH },
    });
  });

  // Losing this call is silent in every other check — types, lint, tests and
  // the build all stay green — while the loader falls back to its hardcoded
  // version, which the CSP does not allow, and the editor stops loading. Read
  // the source, the way design-consistency.test.ts pins Monaco's only importer.
  it("is configured by MonacoPanel, before the loader can init", () => {
    const src = readFileSync(
      join(__dirname, "../components/MonacoPanel.tsx"),
      "utf8",
    );
    expect(src).toMatch(/pinMonacoSource\(\s*m\.loader\s*\)/);
  });

  // The CSP dropped its CDN font source because Monaco inlines the codicon
  // font. If a build ships it as a file again, the icons would be blocked —
  // fail here instead, where the version is bumped.
  it("ships its font inline, which is why font-src has no CDN source", () => {
    const css = readFileSync(
      join(__dirname, "../node_modules/monaco-editor/min/vs/editor/editor.main.css"),
      "utf8",
    );
    const external = css.match(/url\((?!["']?data:)[^)]*\)/g) ?? [];
    expect(external, "non-data: url() in Monaco's stylesheet").toEqual([]);
    expect(css).toContain("data:font/");
    expect(defaultCsp(false)).toContain("font-src 'self' data:");
    expect(defaultCsp(false)).not.toMatch(/font-src[^;]*cdn\.jsdelivr\.net/);
  });

  // Pinning is to move ahead of the loader, never behind it. Both floors
  // matter: the loader's default is what we would get by doing nothing, and
  // DOMPURIFY_FLOOR is what this pin was raised for in the first place.
  it("is never older than the loader's default or the DOMPurify floor", () => {
    expect(atLeast(MONACO_VERSION, loaderDefault())).toBe(true);
    expect(atLeast(MONACO_VERSION, DOMPURIFY_FLOOR)).toBe(true);
  });

  it("compares versions numerically, not as strings", () => {
    expect(atLeast("0.56.0", "0.55.1")).toBe(true);
    expect(atLeast("0.55.1", "0.56.0")).toBe(false);
    expect(atLeast("0.56.0", "0.56.0")).toBe(true);
    // "0.9.0" sorts after "0.10.0" as a string; it is older as a version.
    expect(atLeast("0.9.0", "0.10.0")).toBe(false);
  });
});
