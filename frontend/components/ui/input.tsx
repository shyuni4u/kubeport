import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { fieldControlClass } from "./field-styles"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        // LOCAL EDIT (see components/ui/README.md): separate editable values from surrounding labels.
        fieldControlClass,
        "file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground disabled:pointer-events-none",
        className
      )}
      {...props}
    />
  )
}

export { Input }
