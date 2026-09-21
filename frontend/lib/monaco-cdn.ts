/**
 * Which Monaco build this app runs, in one place (#438).
 *
 * The editor is not bundled. `@monaco-editor/loader` fetches it from a CDN at
 * runtime, so the npm `monaco-editor` devDependency ships nothing — but it is
 * load-bearing three times over: it supplies the editor's types, it is the
 * only path `pnpm audit --prod` has to the DOMPurify Monaco vendors
 * (`. > @monaco-editor/react > monaco-editor > dompurify`, which is what the
 * audit gate in ci.yml reads), and monaco-cdn.test.ts reads its
 * `min/vs/editor/editor.main.css` to prove the codicon font is still inlined.
 * Deleting it or moving it to `dependencies` fails those tests on purpose.
 *
 * Monaco vendors its own copy of DOMPurify
 * (`esm/vs/base/browser/dompurify/dompurify.js`), so the sanitizer
 * that actually runs in an admin's browser is whichever one is baked into the
 * build at the version below, and no lockfile or `pnpm.overrides` entry can
 * change it. 0.55.1 carried DOMPurify 3.2.7; 0.56.0 carries 3.4.8.
 *
 * `@monaco-editor/loader` hardcodes a version of its own, so MonacoPanel
 * configures the loader with MONACO_VS_PATH rather than inheriting it. That
 * makes this constant the decision, and monaco-cdn.test.ts holds the three
 * places that must agree: this file, the CSP, and the devDependency the types
 * come from.
 *
 * Import-free on purpose: security-headers.ts pulls this in and may not carry
 * weight into proxy.ts.
 */

export const MONACO_VERSION = "0.56.0";

export const MONACO_CDN = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/`;

/** What @monaco-editor/loader is pointed at — the `vs` directory, no trailing slash. */
export const MONACO_VS_PATH = `${MONACO_CDN}min/vs`;

/**
 * Points @monaco-editor/loader at MONACO_VS_PATH. Without it the loader keeps
 * its own hardcoded version, which the CSP does not allow — so the editor
 * would fail to load rather than quietly run an older build.
 */
export function pinMonacoSource(loader: {
  config: (settings: { paths: { vs: string } }) => unknown;
}): void {
  loader.config({ paths: { vs: MONACO_VS_PATH } });
}
