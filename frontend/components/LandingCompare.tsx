"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { parse } from "yaml";

import { DynamicForm, type UISpec } from "@/components/DynamicForm";
import { HelpHint } from "@/components/HelpHint";
import { Badge } from "@/components/ui/badge";
import { applyValuesToYaml, changedLineRange } from "@/lib/apply-values-to-yaml";
import { defaultsFromUISpec } from "@/lib/ui-spec-to-zod";
import { cn } from "@/lib/utils";

// LandingCompare is the pitch in one screen: the YAML an admin writes on the
// left, the 4-field form a user fills on the right. Editing the form rewrites
// the YAML client-side (no backend, no deploy) and highlights the lines that
// changed. Both inputs are the demo seed's web-app fixture, so what the
// visitor sees here is exactly what "사용자로 체험" deploys.
type Props = {
  resourcesYaml: string;
  uiSpecYaml: string;
};

export function LandingCompare({ resourcesYaml, uiSpecYaml }: Props) {
  const t = useTranslations("landing.compare");
  const spec = useMemo(() => parse(uiSpecYaml) as UISpec, [uiSpecYaml]);
  // Baseline goes through the same serializer as every later render so the
  // diff below only ever reflects value changes, never formatting.
  const baseline = useMemo(
    () => applyValuesToYaml(resourcesYaml, defaultsFromUISpec(spec)),
    [resourcesYaml, spec],
  );
  const [current, setCurrent] = useState(baseline);
  const [changed, setChanged] = useState<[number, number] | null>(null);
  const prevRef = useRef(baseline);

  const onChange = useCallback(
    (values: Record<string, unknown>) => {
      const next = applyValuesToYaml(resourcesYaml, values);
      const range = changedLineRange(prevRef.current, next);
      prevRef.current = next;
      setCurrent(next);
      if (range) setChanged(range);
    },
    [resourcesYaml],
  );

  const lines = useMemo(() => current.replace(/\n$/, "").split("\n"), [current]);

  return (
    <section aria-labelledby="landing-compare-heading" className="flex w-full flex-col gap-6">
      <div className="flex flex-col gap-1 text-center">
        <h2 id="landing-compare-heading" className="text-xl font-semibold">{t("heading")}</h2>
        <p className="text-sm text-muted-foreground">{t("subheading")}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Pane
          title={t("adminTitle")}
          help={t("adminHelp")}
          badge={t("yamlLines", { count: lines.length })}
          badgeHelp={t("yamlHelp")}
        >
          <YamlLines lines={lines} changed={changed} changedLabel={t("changedLine")} />
        </Pane>

        <Pane
          title={t("userTitle")}
          help={t("userHelp")}
          badge={t("inputs", { count: spec.fields.length })}
          badgeHelp={t("inputsHelp")}
        >
          <div className="p-4 text-left">
            <DynamicForm
              spec={spec}
              onSubmit={() => { /* landing preview — nothing to deploy */ }}
              onChange={onChange}
              submitLabel={t("previewSubmit")}
              disabled
            />
          </div>
        </Pane>
      </div>
    </section>
  );
}

function Pane({
  title,
  help,
  badge,
  badgeHelp,
  children,
}: {
  title: string;
  help: string;
  badge: string;
  badgeHelp: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <h3 className="flex items-center gap-1 text-sm font-medium">
          {title}
          <HelpHint text={help} />
        </h3>
        <span className="flex items-center gap-1">
          <Badge variant="secondary">{badge}</Badge>
          <HelpHint text={badgeHelp} />
        </span>
      </div>
      {children}
    </div>
  );
}

function YamlLines({
  lines,
  changed,
  changedLabel,
}: {
  lines: string[];
  changed: [number, number] | null;
  changedLabel: string;
}) {
  const firstChangedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // jsdom has no scrollIntoView; real browsers keep the edited line visible
    // inside the scrolling pane without moving the page.
    // `nearest` so only the pane scrolls; `center` would also re-center the
    // window on every keystroke.
    firstChangedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [changed]);

  return (
    <pre
      data-testid="landing-yaml"
      className="max-h-[32rem] overflow-auto py-2 text-left font-mono text-xs leading-5"
    >
      {lines.map((line, i) => {
        const isChanged = changed !== null && i >= changed[0] && i <= changed[1];
        return (
          <div
            key={i}
            ref={isChanged && changed !== null && i === changed[0] ? firstChangedRef : undefined}
            data-changed={isChanged ? "true" : undefined}
            title={isChanged ? changedLabel : undefined}
            className={cn(
              "flex gap-3 px-3",
              isChanged && "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-100",
            )}
          >
            <span className="w-7 shrink-0 select-none text-right text-muted-foreground/60">{i + 1}</span>
            <span className="whitespace-pre">{line}</span>
          </div>
        );
      })}
    </pre>
  );
}
