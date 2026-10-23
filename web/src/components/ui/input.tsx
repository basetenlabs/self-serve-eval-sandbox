import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 bg-surface px-3 text-[14px] text-foreground shadow-[inset_0_0_0_1px_var(--rule)] outline-none transition-shadow",
        "placeholder:text-muted-foreground/80 hover:shadow-[inset_0_0_0_1px_var(--line)]",
        "focus-visible:shadow-[inset_0_0_0_1px_var(--foreground)] focus-visible:outline-none",
        "aria-invalid:shadow-[inset_0_0_0_1px_var(--danger)] disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label data-slot="label" className={cn("label-mono text-muted-foreground", className)} {...props} />;
}

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-chip px-1 font-mono text-[10px] leading-none tracking-normal normal-case opacity-70 shadow-[inset_0_0_0_1px_currentColor]", className)}
      {...props}
    />
  );
}

export { Input, Kbd, Label };
