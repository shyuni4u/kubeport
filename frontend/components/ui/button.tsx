import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  // #112: the disabled state swaps colours instead of fading them. `opacity-50`
  // dims fill and label together, so a primary button's label measured 1.50:1
  // against its own button — and the button stayed a filled primary shape, so
  // "disabled" read as "slightly pale". `bg-muted text-muted-foreground` is
  // 4.90:1 (held there by globals.test.ts) and is not a colour any enabled
  // variant uses.
  //
  // #111: the focus ring lost its `/50`. --ring is 4.8:1 solid and was
  // compositing to 2.13:1 on white.
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none dark:disabled:bg-muted aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        // `bg-hover`, not `bg-muted`: --muted is a surface and sits 1.12:1 from
        // the page, so an outline or ghost button gave no feedback at all on
        // hover (#130). --hover is defined per theme, which is what a state
        // token is for.
        //
        // `dark:hover:bg-hover` still has to be spelled out, though, and is not
        // redundant. This variant keeps a dark-mode base fill, and
        // `dark:bg-input/30` carries the same specificity as a bare `hover:`
        // while being emitted later — so without the dark hover the button
        // stops responding to the pointer in dark mode entirely. Ghost needs no
        // such pair: it has no base fill for the dark rule to hold.
        outline:
          "border-border bg-background hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-hover",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-hover aria-expanded:bg-hover aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground",
        // Opaque for the same reason as the badge: a translucent fill inherits
        // its contrast from whatever is behind the button, so the label's
        // 5.35:1 was only true on the surfaces it happened to be tried on.
        destructive:
          "bg-destructive-surface text-destructive hover:bg-destructive-surface-hover focus-visible:border-destructive focus-visible:ring-destructive",
        // The one variant with no fill of its own, so it opts out of the
        // disabled fill rather than turning into a grey chip. twMerge keeps the
        // variant's value over the base's.
        link: "text-link underline-offset-4 hover:underline disabled:border-transparent disabled:bg-transparent",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
