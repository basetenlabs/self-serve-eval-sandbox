import * as React from "react";
import { Column } from "@/components/brand";
import { pct, usd } from "@/lib/format";
import type { Swatch } from "@/lib/models";
import type { Model, Summary } from "@/lib/types";

const W = 760, H = 380, L = 64, R = 24, T = 40, B = 48;

function niceStep(span: number) {
  const raw = span / 4, mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((f) => f * mag).find((v) => v >= raw) ?? raw;
}

type Box = { x0: number; x1: number; y0: number; y1: number };
const hits = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/** Solve rate against cost per solved task, one point per model. Top left is best. */
export function Scatter({ models, S, colors }: { models: Model[]; S: Record<string, Summary>; colors: Record<string, Swatch> }) {
  const [hover, setHover] = React.useState<string | null>(null);
  const pts = models
    .map((m) => ({ m, s: S[m.key] }))
    .filter((p) => p.s?.pass_at_1 != null && p.s.cost_per_solved != null);

  if (!pts.length) {
    return (
      <Column heading="Quality against cost">
        <div className="placeholder-cell grid h-48 place-items-center label-mono text-muted-foreground">No solved attempts yet</div>
      </Column>
    );
  }

  const maxX = Math.max(...pts.map((p) => p.s.cost_per_solved!)) * 1.2 || 1;
  const step = niceStep(maxX), xMax = Math.ceil(maxX / step) * step;
  const x = (v: number) => L + (v / xMax) * (W - L - R);
  const y = (v: number) => T + (1 - v) * (H - T - B);
  const fmtX = (v: number) => (v === 0 ? "$0" : step >= 1 ? `$${v.toFixed(0)}` : step >= 0.01 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`);
  const xTicks: number[] = [];
  for (let v = 0; v <= xMax + 1e-9; v += step) xTicks.push(v);

  // Value chips sit above-right of their point; a chip moves only if it would collide.
  const dots: Box[] = pts.map((p) => ({ x0: x(p.s.cost_per_solved!) - 8, x1: x(p.s.cost_per_solved!) + 8, y0: y(p.s.pass_at_1!) - 8, y1: y(p.s.pass_at_1!) + 8 }));
  const placed: Box[] = [...dots];
  const chips = pts.map((p, i) => {
    const cx = x(p.s.cost_per_solved!), cy = y(p.s.pass_at_1!);
    const w = p.m.label.length * 7 + 14, h = 20;
    const spots = [[cx + 8, cy - 28], [cx - 8 - w, cy - 28], [cx + 10, cy + 8], [cx - 10 - w, cy + 8], [cx - w / 2, cy - 32], [cx - w / 2, cy + 12]];
    for (const [x0, y0] of spots) {
      const box = { x0, x1: x0 + w, y0, y1: y0 + h };
      if (box.x0 < L + 2 || box.x1 > W - 2 || box.y0 < 2 || box.y1 > H - B) continue;
      if (placed.some((b) => b !== dots[i] && hits(box, b))) continue;
      placed.push(box);
      return { x0, y0, w, h };
    }
    return null;
  });

  const active = pts.find((p) => p.m.key === hover);
  return (
    <Column heading="Quality against cost" aside={<span className="label-mono text-muted-foreground">Up and to the left is better</span>}>
      <div className="relative max-w-[920px]">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Solve rate against cost per solved task, one point per model">
          <rect x={L} y={T} width={W - L - R} height={H - T - B} className="fill-white dark:fill-white/[0.03]" />
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--rule)" strokeDasharray="4 4" />
              <text x={L - 10} y={y(v) + 4} textAnchor="end" className="fill-muted-foreground font-mono text-[11px]">{v * 100}%</text>
            </g>
          ))}
          {xTicks.map((v) => (
            <g key={v}>
              {v > 0 && <line x1={x(v)} x2={x(v)} y1={T} y2={H - B} stroke="var(--rule)" strokeDasharray="4 4" />}
              <text x={x(v)} y={H - B + 20} textAnchor="middle" className="fill-muted-foreground font-mono text-[11px]">{fmtX(v)}</text>
            </g>
          ))}
          <line x1={L} x2={L} y1={T} y2={H - B} stroke="var(--line)" />
          <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="var(--line)" />
          <text x={4} y={T - 16} className="fill-foreground font-mono text-[11px] uppercase tracking-[0.06em]">Solve rate</text>
          <text x={W - R} y={H - 6} textAnchor="end" className="fill-foreground font-mono text-[11px] uppercase tracking-[0.06em]">Cost per solved task</text>
          {pts.map((p, i) => {
            const cx = x(p.s.cost_per_solved!), cy = y(p.s.pass_at_1!);
            const sw = colors[p.m.key], chip = chips[i];
            return (
              <g
                key={p.m.key}
                tabIndex={0}
                role="img"
                aria-label={`${p.m.label}: ${pct(p.s.pass_at_1)} solve rate, ${usd(p.s.cost_per_solved)} per solved task`}
                onPointerEnter={() => setHover(p.m.key)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(p.m.key)}
                onBlur={() => setHover(null)}
                className="cursor-default outline-none"
              >
                <circle cx={cx} cy={cy} r={16} fill="transparent" />
                <circle cx={cx} cy={cy} r={hover === p.m.key ? 8 : 6} fill={sw?.fill} stroke="var(--background)" strokeWidth={2} className="transition-[r]" />
                {chip && (
                  <g>
                    <rect x={chip.x0} y={chip.y0} width={chip.w} height={chip.h} rx={2} fill={sw?.fill} />
                    <text x={chip.x0 + 7} y={chip.y0 + 14} fill={sw?.ink} className="font-mono text-[11px] uppercase">{p.m.label}</text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
        {active && (
          <div
            className="pointer-events-none absolute z-10 min-w-48 -translate-x-1/2 -translate-y-full bg-primary px-3 py-2 text-[12px] text-primary-foreground shadow-pop"
            style={{ left: `${(x(active.s.cost_per_solved!) / W) * 100}%`, top: `calc(${(y(active.s.pass_at_1!) / H) * 100}% - 14px)` }}
          >
            <div className="label-mono mb-1">{active.m.label}</div>
            {([["Solve rate", pct(active.s.pass_at_1)], ["Cost per solved task", usd(active.s.cost_per_solved)], ["Solved", `${active.s.solved} / ${active.s.valid}`]] as const).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4"><span className="opacity-75">{k}</span><b className="num font-medium">{v}</b></div>
            ))}
          </div>
        )}
      </div>
    </Column>
  );
}
