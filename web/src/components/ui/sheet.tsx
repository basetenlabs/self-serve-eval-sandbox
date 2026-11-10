import { Dialog as DialogPrimitive } from "radix-ui";
import * as React from "react";
import { Cross } from "@/components/brand/icons";
import { cn } from "@/lib/utils";

const Sheet = DialogPrimitive.Root;
const SheetTitle = DialogPrimitive.Title;
const SheetDescription = DialogPrimitive.Description;
const SheetClose = DialogPrimitive.Close;

/** A White panel from the right edge, on the scrim, for one task's attempts. */
function SheetContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="ev-scrim" />
      <DialogPrimitive.Content className={cn("ev-sheet", className)} {...props}>
        {children}
        <DialogPrimitive.Close className="ev-close absolute top-3 right-3" aria-label="Close"><Cross /></DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle };
