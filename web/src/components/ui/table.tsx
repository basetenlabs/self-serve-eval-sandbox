import * as React from "react";
import { cn } from "@/lib/utils";

// The site's data table (baseten.css .bt-table): a mono header row on Light Grey 1, rows on Light Grey 3 rules,
// numbers tabular. No zebra, no outer border, no vertical rules.

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table className={cn("bt-table dense", className)} {...props} />
    </div>
  );
}

function THead({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead className={className} {...props} />;
}

function TBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody className={className} {...props} />;
}

function TR({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr className={className} {...props} />;
}

function TH({ className, ...props }: React.ComponentProps<"th">) {
  return <th className={cn("whitespace-nowrap font-normal", className)} {...props} />;
}

function TD({ className, ...props }: React.ComponentProps<"td">) {
  return <td className={cn("align-middle", className)} {...props} />;
}

export { Table, TBody, TD, TH, THead, TR };
