import * as React from "react";
import { Badge } from "@/components/ui/badge";
import type { Swatch as SwatchColors } from "@/lib/models";
import type { Phase } from "@/lib/types";
import { cn } from "@/lib/utils";
import logo from "@/assets/baseten-logo.svg?raw";
import { Marker } from "./icons";

/** The Baseten logo: the design skill's assets/logo/baseten-logo.svg, unmodified, in the current text colour. */
export function BasetenLogo({ className }: { className?: string }) {
  return <span role="img" aria-label="Baseten" className={cn("inline-flex", className)} dangerouslySetInnerHTML={{ __html: logo }} />;
}

/** A line of facts in mono, parts separated by small squares (the figure system's eyebrow). */
export function Eyebrow({ parts, className }: { parts: React.ReactNode[]; className?: string }) {
  const shown = parts.filter((p) => p != null && p !== false && p !== "");
  // Each part carries the separator after it, so a wrapped line never starts with one.
  return (
    <div className={cn("label-mono flex flex-wrap items-center gap-y-1 text-muted-foreground", className)}>
      {shown.map((p, i) => (
        <span key={i}>
          {p}
          {i < shown.length - 1 && <span aria-hidden className="mx-2.5 inline-block size-[5px] bg-current align-middle" />}
        </span>
      ))}
    </div>
  );
}

/** The site's eyebrow (baseten.css .bt-eyebrow): the mono tag that opens a section, with the four-dot marker. */
export function Tag({ children, marker = true, className = "auto", as: As = "p" }: {
  children: React.ReactNode; marker?: boolean; className?: string; as?: "p" | "h2" | "h3" | "div";
}) {
  return <As className={cn("bt-eyebrow", marker && "has-marker", className)}>{marker && <Marker />}{children}</As>;
}

/** A White surface on the textured page (baseten.css .bt-surface). */
export function Surface({ className, children, as: As = "section", ...rest }: {
  className?: string; children: React.ReactNode; as?: "section" | "div" | "header";
} & React.HTMLAttributes<HTMLElement>) {
  return <As className={cn("bt-surface ev-surface", className)} {...rest}>{children}</As>;
}

/** The texture band between two surfaces, with the white steps notched into its left end. */
export function Spacer({ className }: { className?: string }) {
  return (
    <div className={cn("bt-spacer small", className)} aria-hidden>
      <div className="steps layout-grid"><i /><i /><i /><i /></div>
    </div>
  );
}

/** A column (baseten.css .bt-column): Black rule across the top, mono heading under it, optional aside on the right. */
export function Column({ heading, aside, className, children, as: As = "section", ...rest }: {
  heading: React.ReactNode;
  aside?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
  as?: "section" | "div";
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <As className={cn("bt-column", className)} {...rest}>
      <div className="flex min-h-6 items-center justify-between gap-4">
        <h2 className="label-mono m-0 text-foreground">{heading}</h2>
        {aside && <div className="flex items-center gap-2">{aside}</div>}
      </div>
      {children}
    </As>
  );
}

/** Square colour key for a model. */
export function Swatch({ swatch, className, size = 10 }: { swatch?: SwatchColors; className?: string; size?: number }) {
  return <span aria-hidden className={cn("inline-block shrink-0", className)} style={{ width: size, height: size, background: swatch?.fill ?? "var(--color-darkGrey3)" }} />;
}

/** A model's name with its colour key. */
export function ModelName({ label, swatch, className, sub }: { label: string; swatch?: SwatchColors; className?: string; sub?: React.ReactNode }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <Swatch swatch={swatch} />
      <span className="truncate">{label}</span>
      {sub && <span className="label-mono text-muted-foreground">{sub}</span>}
    </span>
  );
}

/** Pink delta chip: the one comparison number per metric, Black Beausite on the Pink base. */
export function DeltaChip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center bg-delta px-2 py-0.5 text-[16px] leading-6 font-normal whitespace-nowrap text-black", className)}>
      {children}
    </span>
  );
}

/** A labelled number: 10px mono label above, Beausite figure below. */
export function Stat({ label, value, note, className, valueClassName }: {
  label: React.ReactNode; value: React.ReactNode; note?: React.ReactNode; className?: string; valueClassName?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="label-xs text-muted-foreground">{label}</div>
      <div className={cn("num mt-2 text-[32px] leading-[1.2] font-normal tracking-[-0.01em]", valueClassName)}>{value}</div>
      {note && <div className="mt-1 text-[12px] text-muted-foreground">{note}</div>}
    </div>
  );
}

const PHASES: Record<string, { label: string; variant: "live" | "default" | "warn" | "danger" | "info" }> = {
  collecting: { label: "Finding PRs", variant: "live" },
  checking: { label: "Checking PRs", variant: "live" },
  running: { label: "Running", variant: "live" },
  done: { label: "Done", variant: "info" },
  stopped: { label: "Stopped", variant: "warn" },
  failed: { label: "Failed", variant: "danger" },
};

export const isActive = (phase: Phase) => phase === "collecting" || phase === "checking" || phase === "running";

/** A run's phase as a status badge with its word; live phases carry a pulsing square. */
export function PhaseBadge({ phase, className }: { phase: Phase; className?: string }) {
  const p = PHASES[phase] ?? { label: phase, variant: "default" as const };
  return (
    <Badge variant={p.variant} className={className}>
      {isActive(phase) ? <LiveDot /> : null}
      {p.label}
    </Badge>
  );
}

export function LiveDot({ className }: { className?: string }) {
  return <span aria-hidden className={cn("ev-dot live", className)} />;
}

/** Empty, loading-failed and not-found states: a Light Grey 1 block with one sentence and at most one action. */
export function Empty({ title, children, className }: { title: string; children?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("bt-empty", className)}>
      <p className="m-0 text-[20px] leading-[1.3] tracking-[-0.01em] text-black">{title}</p>
      {children && <div className="max-w-[560px] text-[14px] text-body">{children}</div>}
    </div>
  );
}
