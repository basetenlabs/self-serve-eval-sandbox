import * as React from "react";
import { Chevron } from "@/components/brand/icons";
import { cn } from "@/lib/utils";

// Baseten's button (baseten.css .bt-button): square, 36px, Beausite 14px. Primary is Black, secondary Light Grey 1,
// tertiary White with a hairline; each lifts into a little block on hover. A ghost is a plain text action and a
// destructive trigger is a tertiary whose label says what it does.
type Variant = "default" | "secondary" | "outline" | "danger" | "ghost" | "link";
type Size = "default" | "sm" | "lg" | "icon" | "icon-sm";
const LOOK: Record<Variant, string> = {
  default: "bt-button",
  secondary: "bt-button secondary",
  outline: "bt-button tertiary",
  danger: "bt-button tertiary",
  ghost: "ev-text-button",
  link: "ev-text-button",
};

export function buttonClass({ variant = "default", size, chevron, full, className }: { variant?: Variant; size?: Size; chevron?: boolean; full?: boolean; className?: string } = {}) {
  return cn(LOOK[variant], variant !== "ghost" && variant !== "link" && chevron && "has-chevron", (full || size === "lg") && "full", className);
}

type Props = React.ComponentProps<"button"> & { variant?: Variant; size?: Size; asChild?: boolean; chevron?: boolean; full?: boolean };

function face(children: React.ReactNode, variant: Variant, chevron?: boolean) {
  if (variant === "ghost" || variant === "link") return children;
  return (
    <span>
      <span className="label">{children}</span>
      {chevron && <span className="chevron"><Chevron /></span>}
    </span>
  );
}

function Button({ className, variant = "default", size, asChild = false, chevron, full, children, type, ...props }: Props) {
  const cls = buttonClass({ variant, size, chevron, full, className });
  if (asChild && React.isValidElement<{ className?: string; children?: React.ReactNode }>(children)) {
    return React.cloneElement(children, { ...props, className: cn(cls, children.props.className) } as object, face(children.props.children, variant, chevron));
  }
  return <button type={type ?? "button"} data-slot="button" className={cls} {...props}>{face(children, variant, chevron)}</button>;
}

export { Button };
