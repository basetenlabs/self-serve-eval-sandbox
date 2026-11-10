import * as React from "react";
import { cn } from "@/lib/utils";

// The site's form parts (baseten.css .bt-input, .bt-field): 36px, a Light Grey 2 hairline, 10px mono labels above.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return <input type={type} data-slot="input" className={cn("bt-input ev-input", className)} {...props} />;
}

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label data-slot="label" className={cn("label-xs text-muted-foreground", className)} {...props} />;
}

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return <kbd className={cn("ev-kbd", className)} {...props} />;
}

export { Input, Kbd, Label };
