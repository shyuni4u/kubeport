"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";

import { Checkbox } from "@/components/ui/checkbox";

type Props = {
  multiple: boolean;
  onChange: (multiple: boolean) => void;
  /** As MetaRow's: nothing on a YAML draft can be saved (#184). */
  readOnly?: boolean;
};

/**
 * The ui-spec's `instances` (#190). On, a template may be deployed more than
 * once in a namespace: the backend names every object after its release and
 * adds the release to the selectors. Once a version is published the mode is
 * the template's, so the help says so before a save is refused for it.
 */
export function InstancesToggle({ multiple, onChange, readOnly }: Props) {
  const t = useTranslations("templates.editor.instances");
  const helpId = useId();
  return (
    <div className="rounded-md border px-4 py-2 text-xs">
      <label className="flex items-center gap-2 font-medium">
        <Checkbox
          checked={multiple}
          disabled={readOnly}
          aria-describedby={helpId}
          onCheckedChange={(checked) => onChange(checked)}
        />
        {t("label")}
      </label>
      <p id={helpId} className="mt-1 text-muted-foreground">
        {t("help")}
      </p>
    </div>
  );
}
