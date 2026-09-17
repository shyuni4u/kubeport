"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";

import { Label } from "@/components/ui/label";
import { fieldDescriptionClass } from "@/components/ui/field-styles";
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
    <div className="rounded-[12px] border bg-card p-4">
      <Label className="items-start gap-3">
        <Checkbox
          checked={multiple}
          disabled={readOnly}
          aria-describedby={helpId}
          onCheckedChange={(checked) => onChange(checked)}
        />
        {t("label")}
      </Label>
      <p id={helpId} className={`${fieldDescriptionClass} mt-2`}>
        {t("help")}
      </p>
    </div>
  );
}
