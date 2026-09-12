"use client";

import { useLayoutEffect, useState } from "react";
import { createKubeTermsStore, KubeTermsStoreContext } from "@/stores/kube-terms-store";

/**
 * Starts the "show raw k8s terms" switch where the viewer's role would want it
 * (#39): on for admins, who write templates in those words, off for users, who
 * never see them anywhere else. Once the viewer flips it, their choice wins
 * for the rest of the visit.
 *
 * The server knows the role, so the store is created with it: the server's
 * HTML and the first paint after a reload already use the admin's words,
 * where a client-side default flipped them at hydration (#247). It sits in the
 * root shell, which stays mounted across page moves, so a choice made on one
 * page holds on the next.
 */
export function KubeTermsProvider({
  isAdmin,
  children,
}: {
  isAdmin: boolean;
  children: React.ReactNode;
}) {
  const [store] = useState(() => createKubeTermsStore(isAdmin));
  // The shell re-renders on a refresh; if the role it sees has changed (a
  // session expired, say), move the default with it unless the viewer chose.
  useLayoutEffect(() => {
    store.getState().applyDefault(isAdmin);
  }, [store, isAdmin]);
  return <KubeTermsStoreContext.Provider value={store}>{children}</KubeTermsStoreContext.Provider>;
}
