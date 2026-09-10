"use client";

import { useLayoutEffect } from "react";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

/**
 * Starts the "show raw k8s terms" toggle where the viewer's role would want
 * it (#39): on for admins, who write templates in those words, off for users,
 * who never see them anywhere else. Once the viewer flips the toggle, their
 * choice wins for the rest of the visit — this only sets the starting point.
 *
 * Renders nothing. The server knows the role; the store lives on the client.
 * A layout effect applies the default before the browser paints, so moving to
 * a page inside the app never shows the other side first. A full reload still
 * paints the server's render (the store's default) until hydration.
 */
export function KubeTermsDefault({ isAdmin }: { isAdmin: boolean }) {
  const applyDefault = useKubeTermsStore((s) => s.applyDefault);
  useLayoutEffect(() => {
    applyDefault(isAdmin);
  }, [applyDefault, isAdmin]);
  return null;
}
