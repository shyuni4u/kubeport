"use client";

import { CircleHelp } from "lucide-react";
import { useTranslations } from "next-intl";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// HelpHint is the `(?)` affordance next to any label whose wording might be
// unfamiliar to a non-k8s user. Hover or focus shows `text`; the trigger is a
// real button so keyboard and touch users can reach it.
export function HelpHint({ text, className }: { text: string; className?: string }) {
  const t = useTranslations("common");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={t("help")}
            className={cn(
              "inline-flex size-4 items-center justify-center rounded-full text-muted-foreground align-middle hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
              className,
            )}
          />
        }
      >
        <CircleHelp className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipContent className="max-w-[18rem] whitespace-pre-line">{text}</TooltipContent>
    </Tooltip>
  );
}
