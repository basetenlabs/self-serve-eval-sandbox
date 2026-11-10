import { Checkbox as CheckboxPrimitive } from "radix-ui";
import * as React from "react";
import { Tick } from "@/components/brand/icons";
import { cn } from "@/lib/utils";

/** A square check: Light Grey 3 edge, Black with a White tick when on. */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root data-slot="checkbox" className={cn("ev-check", className)} {...props}>
      <CheckboxPrimitive.Indicator><Tick /></CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
