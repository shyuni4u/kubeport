"use client";

import { useTranslations } from "next-intl";
import { HelpHint } from "@/components/HelpHint";
import { Switch } from "@/components/ui/switch";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

export function KubeTermsToggle() {
  const t = useTranslations("releases");
  const show = useKubeTermsStore((s) => s.showKubeTerms);
  const toggle = useKubeTermsStore((s) => s.toggle);
  return (
    <span className="inline-flex items-center gap-2">
      <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <Switch checked={show} onCheckedChange={toggle} />
        {t("kubeTermsToggle")}
      </label>
      {/*
        "원본 k8s 용어 보기" did not say what k8s is, and the switch sits on one
        card but changes the deploy form and the release pages too (#249). The
        hint says both, with an example and that only the wording changes. It
        sits beside the label, not inside it, so its "도움말" name does not join
        the switch's. The label flips the switch wherever it is pressed, so the
        hint gets a 24px target and a wider gap: a near miss on a 16px button
        would change the setting instead of opening help.
      */}
      <HelpHint text={t("kubeTermsHelp")} className="size-6" />
    </span>
  );
}
