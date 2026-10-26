/** Same-origin Monaco distribution copied from the locked npm package by scripts/prepare-monaco.mjs. The vendored DOMPurify version still follows Monaco, not pnpm overrides. */

export const MONACO_VERSION = "0.57.0";

export const MONACO_ASSET_ROOT = `/vendor/monaco/${MONACO_VERSION}/`;

/** What @monaco-editor/loader is pointed at — the `vs` directory, no trailing slash. */
export const MONACO_VS_PATH = `${MONACO_ASSET_ROOT}min/vs`;

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
