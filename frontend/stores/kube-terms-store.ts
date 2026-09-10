import { create } from "zustand";

type KubeTermsState = {
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

export const useKubeTermsStore = create<KubeTermsState>((set) => ({
  showKubeTerms: false,
  touched: false,
  toggle: () => set((s) => ({ showKubeTerms: !s.showKubeTerms, touched: true })),
  applyDefault: (show) => set((s) => (s.touched ? s : { showKubeTerms: show })),
}));
