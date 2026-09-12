import { describe, expect, it } from "vitest";
import {
  applyThemeClass,
  parseTheme,
  rootThemeClass,
  THEME_COOKIE,
  themeClass,
  themeCookie,
} from "./theme";

describe("parseTheme", () => {
  it.each(["system", "light", "dark"] as const)("keeps %s", (t) => {
    expect(parseTheme(t)).toBe(t);
  });

  // A cookie is user-controlled input. Anything unexpected falls back to the
  // default rather than landing in the <html> class attribute.
  it.each([undefined, null, "", "DARK", "dark x", "blue"])("falls back to system for %s", (raw) => {
    expect(parseTheme(raw)).toBe("system");
  });
});

describe("root layout class", () => {
  it("renders .dark and .light for an explicit choice", () => {
    expect(rootThemeClass("dark")).toBe("dark");
    expect(rootThemeClass("light")).toBe("light");
  });

  // System has no class: CSS follows prefers-color-scheme on a root without
  // .light, so the server never has to guess the OS setting.
  it("renders no theme class for system, a missing cookie, or garbage", () => {
    expect(themeClass("system")).toBeUndefined();
    expect(rootThemeClass(undefined)).toBeUndefined();
    expect(rootThemeClass("nope")).toBeUndefined();
  });
});

describe("themeCookie", () => {
  it("is host-only on Path=/, Lax, long-lived and readable by the client", () => {
    const c = themeCookie("dark", false);
    expect(c.startsWith(`${THEME_COOKIE}=dark;`)).toBe(true);
    expect(c.toLowerCase()).toContain("path=/");
    // No Domain: a Domain attribute would send it to dex.<app-host> as well.
    expect(c.toLowerCase()).not.toContain("domain=");
    expect(c).toContain("SameSite=Lax");
    expect(c).toMatch(/Max-Age=31536000/);
    expect(c.toLowerCase()).not.toContain("httponly");
    expect(c).not.toContain("Secure");
  });

  it("adds Secure on an https page", () => {
    expect(themeCookie("light", true)).toMatch(/; Secure$/);
  });
});

describe("applyThemeClass", () => {
  it("swaps the theme class and leaves other classes alone", () => {
    const el = document.createElement("html");
    el.className = "font-x h-full light";
    applyThemeClass(el, "dark");
    expect([...el.classList]).toEqual(["font-x", "h-full", "dark"]);
    applyThemeClass(el, "system");
    expect([...el.classList]).toEqual(["font-x", "h-full"]);
  });
});
