import { Select as SelectPrimitive } from "radix-ui";
import { Down } from "@/components/brand/icons";
import { cn } from "@/lib/utils";

const ALL = "__all__"; // Radix Select can't use "" as an item value

/** A compact select: an input-shaped trigger with the small triangle, and a flat White menu whose chosen option
 * carries a Black square. `value` "" means the first, "all" option. */
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
      <SelectPrimitive.Trigger aria-label={label} className={cn("bt-select fit", className)}>
        <span className="value"><SelectPrimitive.Value /></span>
        <Down />
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} className="ev-list min-w-[var(--radix-select-trigger-width)]">
          <SelectPrimitive.Viewport className="bt-menu">
            {[{ value: ALL, label: allLabel }, ...options].map((o) => (
              <SelectPrimitive.Item key={o.value} value={o.value}>
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export { Select };
