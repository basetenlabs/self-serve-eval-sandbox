import { Tabs as TabsPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";
import { scrollCue } from "@/motion/motion.js";

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col", className)} {...props} />;
}

/** The site's tab rows side by side: the skill's .bt-tabbar in a .bt-tabbar-scroll, so a row too wide for its box
 *  scrolls and shows a White fade with a chevron at the end that hides tabs (motion.js scrollCue). */
function TabsList({ className, children, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  const wrap = React.useRef<HTMLDivElement>(null);
  const tabs = React.Children.count(children);
  React.useEffect(() => (wrap.current ? scrollCue(wrap.current) : undefined), [tabs]);
  return (
    <div ref={wrap} className="bt-tabbar-scroll">
      <TabsPrimitive.List data-slot="tabs-list" className={cn("bt-tabbar", className)} {...props}>{children}</TabsPrimitive.List>
    </div>
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger data-slot="tabs-trigger" className={className} {...props} />;
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("outline-none bt-reveal", className)} {...props} />;
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
