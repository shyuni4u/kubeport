import type { ComponentProps } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { fieldControlClass } from "./field-styles";

// Keeps native FormData and keyboard behavior in server-action forms.
export function NativeSelect({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <div className="relative min-w-0">
      <select data-slot="native-select" className={cn(fieldControlClass, "appearance-none pr-9", className)} {...props}>
        {children}
      </select>
      <ChevronDownIcon aria-hidden className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}
