import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-hover",
        // Opaque, like its `success` and `warning` siblings. `bg-destructive/10`
        // has no contrast of its own — it borrows whatever it lands on — so the
        // same chip read 5.35:1 on a card and 3.32:1 on a hovered release row,
        // which is where StatusChip actually shows it. The focus ring loses its
        // alpha for the reason every other ring did (#111).
        destructive:
          "bg-destructive-surface text-destructive focus-visible:ring-destructive [a]:hover:bg-destructive-surface-hover",
        outline:
          "border-border text-foreground [a]:hover:bg-hover [a]:hover:text-foreground",
        ghost: "hover:bg-hover hover:text-foreground",
        link: "text-link underline-offset-4 hover:underline",
        success:
          "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200 [a]:hover:bg-green-200",
        warning:
          "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200 [a]:hover:bg-amber-200",
        // The fill stays `bg-muted` — a muted chip is a surface, and that is
        // what this variant is for. Only its hover moves to the state token:
        // `bg-muted/80` is *lighter* than the chip it sits in, so hovering a
        // muted badge used to fade it rather than pick it out.
        muted: "bg-muted text-muted-foreground [a]:hover:bg-hover",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
