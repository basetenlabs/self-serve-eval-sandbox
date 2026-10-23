import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

// Value chips: flat fill, 2px radius, mono. Colour only where it carries meaning.
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-chip px-1.5 py-0.5 font-mono text-[11px] leading-4 uppercase tracking-[0.06em] [&_svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-node text-foreground",
        solid: "bg-primary text-primary-foreground",
        outline: "text-muted-foreground shadow-[inset_0_0_0_1px_var(--rule)]",
        live: "bg-[#D7FACE] text-black dark:bg-[#213026] dark:text-[#19E76E]",
        warn: "bg-warn-surface text-foreground dark:text-[#FFBE4D]",
        danger: "bg-danger-surface text-[#AC0EB2] dark:text-[#FFA9FD]",
        info: "bg-info-surface text-[#0065AD] dark:text-[#3DA6FF]",
        delta: "bg-delta text-black",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
