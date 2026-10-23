import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

const ALL = "__all__"; // Radix Select can't use "" as an item value

/** A compact select. `value` "" means the first, "all" option. */
function Select({ value, onValueChange, options, allLabel, label, className }: {
  value: string;
  onValueChange: (v: string) => void;
  options: { value: string; label: string }[];
  allLabel: string;
  label: string;
  className?: string;
}) {
  return (
    <SelectPrimitive.Root value={value || ALL} onValueChange={(v) => onValueChange(v === ALL ? "" : v)}>
      <SelectPrimitive.Trigger
        aria-label={label}
        className={cn(
          "inline-flex h-9 min-w-36 items-center justify-between gap-2 bg-surface px-3 text-[13px] shadow-[inset_0_0_0_1px_var(--rule)] outline-none hover:shadow-[inset_0_0_0_1px_var(--line)] data-[state=open]:shadow-[inset_0_0_0_1px_var(--foreground)]",
          className,
        )}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon><ChevronDownIcon className="size-4 text-muted-foreground" /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} className="z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden bg-background shadow-pop animate-fade">
          <SelectPrimitive.Viewport className="p-1">
            {[{ value: ALL, label: allLabel }, ...options].map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                className="relative flex h-8 cursor-default items-center pr-8 pl-2.5 text-[13px] outline-none select-none data-[highlighted]:bg-node"
              >
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2"><CheckIcon className="size-3.5" /></SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export { Select };
