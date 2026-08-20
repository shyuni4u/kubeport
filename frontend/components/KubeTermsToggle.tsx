"use client";

import { Switch } from "@/components/ui/switch";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

export function KubeTermsToggle() {
  const show = useKubeTermsStore((s) => s.showKubeTerms);
  const toggle = useKubeTermsStore((s) => s.toggle);
  return (
    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <Switch checked={show} onCheckedChange={toggle} />
      원본 k8s 용어 보기
    </label>
  );
}
