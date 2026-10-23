import { Tabs as TabsPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col", className)} {...props} />;
}

/** Underlined tabs: mono labels on a rule; the active tab carries a Black rule. */
function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("flex items-end gap-6 overflow-x-auto border-b border-rule [scrollbar-width:none]", className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative -mb-px inline-flex h-11 items-center gap-2 whitespace-nowrap border-b-2 border-transparent font-mono text-[12px] uppercase tracking-[0.06em] text-muted-foreground transition-colors",
        "hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground focus-visible:outline-offset-[-2px]",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("outline-none animate-fade", className)} {...props} />;
}

/** Segmented control: chips in a row on a node fill; the active one is Black. */
function SegmentList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn("inline-flex gap-0.5 bg-node p-0.5", className)} {...props} />;
}

function SegmentTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "h-8 px-3 font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground transition-colors hover:text-foreground",
        "data-[state=active]:bg-primary data-[state=active]:text-primary-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { SegmentList, SegmentTrigger, Tabs, TabsContent, TabsList, TabsTrigger };
