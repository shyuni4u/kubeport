import { createContext, useContext } from "react";
import { createStore, useStore, type StoreApi } from "zustand";

export type KubeTermsState = {
  showKubeTerms: boolean;
  /** The viewer flipped the toggle during this visit, so defaults no longer apply. */
  touched: boolean;
  toggle: () => void;
  /**
   * Sets the starting value for the viewer's role — raw terms for admins,
   * plain words for users (#39) — unless the viewer has already chosen.
   */
  applyDefault: (show: boolean) => void;
};

/**
 * A terms store that starts on `initial`. The app makes one per render tree in
 * KubeTermsProvider, seeded with the viewer's role on the server, so the
 * server's HTML and the first paint already use the right words. One module
 * store could only start on one value for everyone, so an admin who reloaded
 * saw plain words flip to raw terms at hydration (#247).
 */
export function createKubeTermsStore(initial = false): StoreApi<KubeTermsState> {
  return createStore<KubeTermsState>((set) => ({
    showKubeTerms: initial,
    touched: false,
    toggle: () => set((s) => ({ showKubeTerms: !s.showKubeTerms, touched: true })),
    applyDefault: (show) => set((s) => (s.touched ? s : { showKubeTerms: show })),
  }));
}

export const KubeTermsStoreContext = createContext<StoreApi<KubeTermsState> | null>(null);

// Only read outside a provider: unit tests that render one component set it
// through useKubeTermsStore.setState. The app always renders inside
// KubeTermsProvider (AppShell), so no server request touches this — module
// state on the server would be shared by every visitor.
const fallbackStore = createKubeTermsStore();

export function useKubeTermsStore<T>(selector: (s: KubeTermsState) => T): T {
  const store = useContext(KubeTermsStoreContext) ?? fallbackStore;
  return useStore(store, selector);
}

useKubeTermsStore.getState = fallbackStore.getState;
useKubeTermsStore.setState = fallbackStore.setState;
