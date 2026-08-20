import { create } from "zustand";

type KubeTermsState = {
  showKubeTerms: boolean;
  toggle: () => void;
};

export const useKubeTermsStore = create<KubeTermsState>((set) => ({
  showKubeTerms: false,
  toggle: () => set((s) => ({ showKubeTerms: !s.showKubeTerms })),
}));
