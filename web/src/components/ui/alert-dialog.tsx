import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import * as React from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Confirm before something that can't be undone, such as stopping a run. */
function Confirm({ trigger, title, description, action, onConfirm, danger = true }: {
  trigger: React.ReactElement;
  title: string;
  description: React.ReactNode;
  action: string;
  onConfirm: () => void;
  danger?: boolean;
}) {
  return (
    <AlertDialogPrimitive.Root>
      <AlertDialogPrimitive.Trigger asChild>{trigger}</AlertDialogPrimitive.Trigger>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[var(--scrim)] animate-fade" />
        <AlertDialogPrimitive.Content className="fixed top-1/2 left-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 bg-background p-6 shadow-pop animate-enter">
          <div className="column-rule pt-4">
            <AlertDialogPrimitive.Title className="text-[20px] font-medium tracking-[-0.01em]">{title}</AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className="mt-2 text-[14px] text-muted-foreground">{description}</AlertDialogPrimitive.Description>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialogPrimitive.Cancel className={buttonVariants({ variant: "outline", size: "sm" })}>Cancel</AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action
              className={cn(buttonVariants({ size: "sm" }), danger && "bg-[#AC0EB2] text-white hover:bg-[#AC0EB2]/90 dark:bg-[#FFA9FD] dark:text-black")}
              onClick={onConfirm}
            >
              {action}
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}

export { Confirm };
