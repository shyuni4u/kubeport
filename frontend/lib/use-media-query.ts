"use client";

import { useSyncExternalStore } from "react";

/**
 * Subscribe to a CSS media query.
 *
 * Used where a `hidden lg:block` / `lg:hidden` pair would be wrong because both
 * branches would mount: the template editor's preview holds a Monaco instance,
 * and rendering the layout twice would hold two (#45).
 *
 * `serverFallback` is what the hook answers before hydration, and it defaults
 * to `true` — a min-width query treated as matching, so server-rendered markup
 * is the widest layout. That is the branch that reads acceptably at any width;
 * the narrow one would flash a phone layout on every desktop first paint and,
 * with tabs, mount the preview twice. Pass `false` for a query where the
 * opposite is true.
 */
export function useMediaQuery(query: string, serverFallback = true): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    // Called on every render, and window.matchMedia allocates a
    // MediaQueryList each time. Deliberately not cached by query: the value
    // read off it is a boolean, so caching buys an allocation and costs the
    // ability to swap window.matchMedia between tests.
    () =>
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia(query).matches
        : serverFallback,
    () => serverFallback,
  );
}
