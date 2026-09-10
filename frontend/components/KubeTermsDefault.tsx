"use client";

import { useEffect } from "react";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

/**
 * Starts the "show raw k8s terms" toggle where the viewer's role would want
 * it (#39): on for admins, who write templates in those words, off for users,
 * who never see them anywhere else. Once the viewer flips the toggle, their
 * choice wins for the rest of the visit — this only sets the starting point.
 *
 * Renders nothing. The server knows the role; the store lives on the client,
 * so the first paint uses the store's default and an admin sees the raw terms
 * one effect later.
 */
export function KubeTermsDefault({ isAdmin }: { isAdmin: boolean }) {
  const applyDefault = useKubeTermsStore((s) => s.applyDefault);
  useEffect(() => {
    applyDefault(isAdmin);
  }, [applyDefault, isAdmin]);
  return null;
}
