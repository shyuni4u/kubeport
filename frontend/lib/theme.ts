/**
 * Colour theme preference (#155).
 *
 * The choice lives in a cookie rather than localStorage because the server has
 * to know it: the root layout renders `<html class="dark">` or `class="light"`
 * from it, so the first paint is already in the chosen theme and the markup the
 * client hydrates is the markup the server sent. #247 is what the other way
 * costs — a value only the browser knows paints one thing first and flips at
 * hydration.
 *
 * "system" renders no theme class at all. globals.css applies the dark tokens
 * under `.dark` *and* under `prefers-color-scheme: dark` on a root without
 * `.light`, so following the OS needs neither a script nor a server guess.
 *
 * Import-free on purpose: the root layout (server) and ThemeSwitch (client)
 * both import it.
 */

export const THEME_COOKIE = "kbp_theme";
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = "system";

/** A year. The preference is a UI setting, not a session; it should outlive one. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function parseTheme(raw: string | null | undefined): Theme {
  return (THEMES as readonly string[]).includes(raw ?? "") ? (raw as Theme) : DEFAULT_THEME;
}

/** The class `<html>` carries for a theme. System carries none, and CSS follows the OS. */
export function themeClass(theme: Theme): "dark" | "light" | undefined {
  return theme === "system" ? undefined : theme;
}

/** Cookie value (possibly absent or garbage) → the class the root layout renders. */
export function rootThemeClass(raw: string | null | undefined): "dark" | "light" | undefined {
  return themeClass(parseTheme(raw));
}

/**
 * The `document.cookie` string ThemeSwitch writes.
 *
 * - No `Domain`: host-only, so it is not sent to sibling hosts such as Dex on
 *   `dex.<app-host>`. (A preference is not a secret, but nothing else needs it.)
 * - `Path=/`: every page's layout reads it.
 * - `SameSite=Lax`, not HttpOnly: the client writes it, and it carries nothing
 *   an attacker could use. No `__Host-` prefix — that is for the auth cookies
 *   in cookie-names.ts, and it would refuse plain-http dev.
 * - `Secure` only when the page itself is https, for the same reason.
 */
export function themeCookie(theme: Theme, secure: boolean): string {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Puts the theme class on `<html>` without a reload — the same class the server will render next time. */
export function applyThemeClass(root: Element, theme: Theme): void {
  root.classList.remove("dark", "light");
  const cls = themeClass(theme);
  if (cls) root.classList.add(cls);
}
