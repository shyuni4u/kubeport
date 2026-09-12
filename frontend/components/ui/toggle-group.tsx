"use client"

import * as React from "react"
import { Radio as RadioPrimitive } from "@base-ui/react/radio"
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group"
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"
import { type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { toggleVariants } from "@/components/ui/toggle"

const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleVariants> & {
    spacing?: number
    orientation?: "horizontal" | "vertical"
  }
>({
  size: "default",
  variant: "default",
  spacing: 0,
  orientation: "horizontal",
})

function ToggleGroup({
  className,
  variant,
  size,
  spacing = 0,
  orientation = "horizontal",
  children,
  ...props
}: ToggleGroupPrimitive.Props &
  VariantProps<typeof toggleVariants> & {
    spacing?: number
    orientation?: "horizontal" | "vertical"
  }) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      data-orientation={orientation}
      style={{ "--gap": spacing } as React.CSSProperties}
      className={cn(
        "group/toggle-group flex w-fit flex-row items-center gap-[--spacing(var(--gap))] rounded-lg data-[size=sm]:rounded-[min(var(--radius-md),10px)] data-vertical:flex-col data-vertical:items-stretch",
        className
      )}
      {...props}
    >
      <ToggleGroupContext.Provider
        value={{ variant, size, spacing, orientation }}
      >
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  )
}

// LOCAL EDIT (see components/ui/README.md): the item classes are a constant so
// ToggleRadioGroupItem below renders with exactly the same ones.
const toggleGroupItemClassName =
  "shrink-0 group-data-[spacing=0]/toggle-group:rounded-none group-data-[spacing=0]/toggle-group:px-2 focus:z-10 focus-visible:z-10 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-end]:pr-1.5 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-start]:pl-1.5 group-data-horizontal/toggle-group:data-[spacing=0]:first:rounded-l-lg group-data-vertical/toggle-group:data-[spacing=0]:first:rounded-t-lg group-data-horizontal/toggle-group:data-[spacing=0]:last:rounded-r-lg group-data-vertical/toggle-group:data-[spacing=0]:last:rounded-b-lg group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:border-l-0 group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:border-t-0 group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-l group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-t"

function ToggleGroupItem({
  className,
  children,
  variant = "default",
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext)

  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      data-variant={context.variant || variant}
      data-size={context.size || size}
      data-spacing={context.spacing}
      className={cn(
        toggleGroupItemClassName,
        toggleVariants({
          variant: context.variant || variant,
          size: context.size || size,
        }),
        className
      )}
      {...props}
    >
      {children}
    </TogglePrimitive>
  )
}

/*
 * LOCAL EDIT (see components/ui/README.md) — not a shadcn component.
 *
 * A single choice that cannot be un-chosen, drawn exactly like ToggleGroup
 * (#325). A toggle button announces "pressed" and promises that pressing it
 * again un-presses it; a required enum refuses that, so it has to be a radio
 * group to be described truthfully. Base UI's RadioGroup supplies the pattern:
 * role="radiogroup" / role="radio" with aria-checked, one tab stop (roving
 * tabindex, landing on the checked radio), arrow keys that move and check, and
 * Space to check. Enter checks as well, as it did on the toggle buttons this
 * replaces; Base UI leaves Enter out on purpose, so the item adds it.
 *
 * Default variant, default size and no spacing only — the one look its only
 * caller uses. The group mirrors ToggleGroup's data attributes because the
 * item classes key on them.
 */
function ToggleRadioGroup({
  className,
  children,
  ...props
}: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="toggle-radio-group"
      data-spacing={0}
      data-orientation="horizontal"
      style={{ "--gap": 0 } as React.CSSProperties}
      className={cn(
        "group/toggle-group flex w-fit flex-row items-center gap-[--spacing(var(--gap))] rounded-lg data-[size=sm]:rounded-[min(var(--radius-md),10px)] data-vertical:flex-col data-vertical:items-stretch",
        className
      )}
      {...props}
    >
      {children}
    </RadioGroupPrimitive>
  )
}

function ToggleRadioGroupItem({
  className,
  children,
  onKeyDown,
  ...props
}: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="toggle-radio-group-item"
      data-variant="default"
      data-size="default"
      data-spacing={0}
      className={cn(
        toggleGroupItemClassName,
        toggleVariants({ variant: "default", size: "default" }),
        // The pressed look, keyed on the radio's own state. A <span>, unlike
        // the <button> it stands in for, lets a double click select its text.
        "select-none aria-checked:border-primary aria-checked:bg-selected aria-checked:text-selected-foreground",
        className
      )}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.key === "Enter" && !event.defaultPrevented) {
          event.currentTarget.click()
        }
      }}
      {...props}
    >
      {children}
    </RadioPrimitive.Root>
  )
}

export { ToggleGroup, ToggleGroupItem, ToggleRadioGroup, ToggleRadioGroupItem }
