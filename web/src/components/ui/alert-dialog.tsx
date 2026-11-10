import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import * as React from "react";
import { buttonClass } from "@/components/ui/button";

/** Confirm before something that can't be undone, such as stopping a run: a White block on the scrim, a tertiary
 * button to back out, then the Black primary that names the action. */
function Confirm({ trigger, title, description, action, cancel = "Cancel", onConfirm }: {
  trigger: React.ReactElement;
  title: string;
  description: React.ReactNode;
  action: string;
  cancel?: string;
  onConfirm: () => void;
  danger?: boolean;
}) {
  return (
    <AlertDialogPrimitive.Root>
      <AlertDialogPrimitive.Trigger asChild>{trigger}</AlertDialogPrimitive.Trigger>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="bt-scrim" />
        <AlertDialogPrimitive.Content className="bt-dialog ev-dialog">
          <div>
            <AlertDialogPrimitive.Title asChild><h2>{title}</h2></AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description asChild><p>{description}</p></AlertDialogPrimitive.Description>
          </div>
          <div className="actions">
            <AlertDialogPrimitive.Cancel className={buttonClass({ variant: "outline" })}><span><span className="label">{cancel}</span></span></AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action className={buttonClass()} onClick={onConfirm}><span><span className="label">{action}</span></span></AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}

export { Confirm };
