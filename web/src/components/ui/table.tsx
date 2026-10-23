import * as React from "react";
import { cn } from "@/lib/utils";

// Tables sit on a White surface; rows are separated by hairlines, headers are mono labels.

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-[14px]", className)} {...props} />
    </div>
  );
}

function THead({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead className={cn("[&_tr]:border-b [&_tr]:border-rule", className)} {...props} />;
}

function TBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TR({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr className={cn("border-b border-frame transition-colors", className)} {...props} />;
}

function TH({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      className={cn("h-10 px-3 text-left align-middle font-mono text-[11px] font-normal uppercase tracking-[0.06em] whitespace-nowrap text-muted-foreground", className)}
      {...props}
    />
  );
}

function TD({ className, ...props }: React.ComponentProps<"td">) {
  return <td className={cn("px-3 py-3 align-middle", className)} {...props} />;
}

export { Table, TBody, TD, TH, THead, TR };
