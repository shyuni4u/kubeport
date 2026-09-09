"use client";

import { useSyncExternalStore } from "react";

/**
 * Subscribe to a CSS media query.
 *
 * Used where a `hidden lg:block` / `lg:hidden` pair would be wrong because both
 * branches would mount: the template editor's preview holds a Monaco instance,
 * and rendering the layout twice would hold two (#45).
 *
 * The server snapshot is `false`. Server-rendered markup therefore always
 * matches the widest layout, which is the branch that renders correctly at
 * every width even before hydration decides otherwise.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () =>
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia(query).matches
        : false,
    () => false,
  );
}
