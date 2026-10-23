import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

// Baseten buttons: square, mono, uppercase. Primary is solid Black (White in dark mode).
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-mono uppercase tracking-[0.04em] transition-[background-color,color,box-shadow,transform] duration-150 select-none disabled:pointer-events-none disabled:opacity-40 active:translate-y-px [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-[#323432] dark:hover:bg-[#E3EAE1]",
        outline: "bg-surface text-foreground shadow-[inset_0_0_0_1px_var(--rule)] hover:shadow-[inset_0_0_0_1px_var(--foreground)]",
        secondary: "bg-node text-foreground hover:bg-node-2",
        ghost: "text-foreground hover:bg-node",
        danger: "bg-surface text-danger shadow-[inset_0_0_0_1px_var(--rule)] hover:bg-danger-surface hover:shadow-[inset_0_0_0_1px_var(--danger)]",
        link: "h-auto px-0 normal-case tracking-normal font-sans underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 text-[13px]",
        sm: "h-8 px-3 text-[12px]",
        lg: "h-12 px-5 text-[14px]",
        icon: "size-10",
        "icon-sm": "size-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({ className, variant, size, asChild = false, ...props }:
  React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
