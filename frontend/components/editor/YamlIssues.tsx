"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";

import {
  errorCount,
  firstError,
  type TemplateYamlValidation,
  type YamlFile,
  type YamlIssue,
} from "@/lib/yaml-validation";

export const YAML_FILE_LABEL: Record<YamlFile, string> = {
  resources: "resources.yaml",
  uiSpec: "ui-spec.yaml",
};

/** The sentence for one issue, in the viewer's locale. */
export function useYamlIssueText(): (issue: YamlIssue) => string {
  const t = useTranslations("templates.editor.validation");
  return useCallback((issue: YamlIssue) => t(issue.code, issue.params), [t]);
}

/**
 * Why save is off, or undefined when nothing blocks it.
 *
 * A disabled save button with no reason beside it is a mystery (#184 learned
 * that on the UI-mode inspector), so every gate this adds says what to fix and
 * where: the first error, by file and line, and how many there are.
 */
export function useSaveBlockedReason(): (v: TemplateYamlValidation) => string | undefined {
  const t = useTranslations("templates.editor.validation");
  const text = useYamlIssueText();
  return useCallback(
    (v: TemplateYamlValidation) => {
      const first = firstError(v);
      if (!first) return undefined;
      return t("saveBlocked", {
        count: errorCount(v),
        file: YAML_FILE_LABEL[first.file],
        line: first.startLine,
        message: text(first),
      });
    },
    [t, text],
  );
}

const MAX_LISTED = 20;

/**
 * Every issue under the editors, as text.
 *
 * The markers already sit on the lines, but a marker is read by hovering, is
 * scrolled out of view in a 40vh panel, and says nothing to a screen reader.
 */
export function YamlIssueList({ validation }: { validation: TemplateYamlValidation }) {
  const t = useTranslations("templates.editor.validation");
  const text = useYamlIssueText();
  const issues = [...validation.resources, ...validation.uiSpec];
  if (issues.length === 0) return null;
  const errors = issues.filter((i) => i.severity === "error").length;
  return (
    <div role="status" aria-live="polite" className="space-y-1 rounded-md border bg-card px-3 py-2 text-xs">
      <div className="font-semibold">{t("summary", { errors, warnings: issues.length - errors })}</div>
      <ul className="space-y-0.5">
        {issues.slice(0, MAX_LISTED).map((issue, k) => (
          <li key={k} className={issue.severity === "error" ? "text-destructive" : "text-amber-800 dark:text-amber-400"}>
            {/* The word as well as the colour: the two severities are the
                difference between "cannot save" and "saves, may not deploy". */}
            <strong>{issue.severity === "error" ? t("error") : t("warning")}</strong>{" "}
            <span className="font-mono">{t("location", { file: YAML_FILE_LABEL[issue.file], line: issue.startLine })}</span>{" "}
            {text(issue)}
          </li>
        ))}
        {issues.length > MAX_LISTED && <li>{t("more", { count: issues.length - MAX_LISTED })}</li>}
      </ul>
    </div>
  );
}
