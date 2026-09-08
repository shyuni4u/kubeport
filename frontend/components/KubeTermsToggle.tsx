"use client";

import { useTranslations } from "next-intl";
import { Switch } from "@/components/ui/switch";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

export function KubeTermsToggle() {
  const t = useTranslations("releases");
  const show = useKubeTermsStore((s) => s.showKubeTerms);
  const toggle = useKubeTermsStore((s) => s.toggle);
  return (
    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <Switch checked={show} onCheckedChange={toggle} />
      {t("kubeTermsToggle")}
    </label>
  );
}
