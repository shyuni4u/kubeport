"use client"

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const toggleVariants = cva(
  // #110 measured a pressed toggle at 1.00:1 against the page: `bg-muted` was
  // the only cue, and on the deploy form's memory ToggleGroup the pressed and
  // unpressed items were the same colour with the same label colour — the
  // selection existed for `aria-pressed` and nowhere else.
  //
  // The pressed state now carries three: the tinted `--selected` fill, a border
  // in --primary, and the label colour. A viewer who cannot separate the tint
  // still has the border.
  //
  // A *border*, not a ring — `focus-visible` already owns the ring here, and
  // both variants are one pseudo-class deep, so a pressed ring and a focus ring
  // would be decided by whichever Tailwind emits later. With `outline-none` on
  // the base, losing that coin toss means a keyboard user focusing an already
  // selected toggle sees no focus indicator at all. `border border-transparent`
  // is in the base so pressing one does not move it by a pixel.
  "group/toggle inline-flex items-center justify-center gap-1 rounded-lg border border-transparent text-sm font-medium whitespace-nowrap transition-all outline-none hover:bg-hover hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring disabled:pointer-events-none disabled:border-border disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-pressed:border-primary aria-pressed:bg-selected aria-pressed:text-selected-foreground data-[state=on]:border-primary data-[state=on]:bg-selected data-[state=on]:text-selected-foreground dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border border-input bg-transparent hover:bg-hover",
      },
      size: {
        default:
          "h-8 min-w-8 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        sm: "h-7 min-w-7 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 min-w-9 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
