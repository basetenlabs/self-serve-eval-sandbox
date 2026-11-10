import * as React from "react";
import { cn } from "@/lib/utils";

// Status badges (baseten.css .bt-badge): a Light ramp ground with the ramp's Black text, always with a word.
// Green is something Baseten runs that is live or healthy, gold waiting or a warning, pink failed or needing
// attention, blue informational, grey inactive. Solid is the Black tag.
type Variant = "default" | "solid" | "outline" | "live" | "warn" | "danger" | "info" | "delta" | "pink";
const LOOK: Record<Variant, string> = {
  default: "bt-badge",
  solid: "bt-badge ev-badge-black",
  outline: "bt-badge white",
  live: "bt-badge green",
  warn: "bt-badge gold",
  danger: "bt-badge pink",
  info: "bt-badge blue",
  delta: "bt-badge pink regular",
  pink: "bt-badge pink",
};

function Badge({ className, variant = "default", ...props }: React.ComponentProps<"span"> & { variant?: Variant | null }) {
  return <span data-slot="badge" className={cn(LOOK[variant ?? "default"], className)} {...props} />;
}

export { Badge };
