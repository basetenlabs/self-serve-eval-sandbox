import * as React from "react";
import { Column } from "@/components/brand";
import { usd } from "@/lib/format";
import type { Swatch } from "@/lib/models";
import { takeaway } from "@/lib/stats";
import type { Model, Summary } from "@/lib/types";

const H = 400, L = 56, R = 32, T = 40, B = 48;
// Geist Mono at 11px with the labels' 0.06em tracking: one character's advance, for sizing chips.
const CHAR = 7.3;

function niceStep(span: number) {
  const raw = span / 4, mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((f) => f * mag).find((v) => v >= raw) ?? raw;
}

type Box = { x0: number; x1: number; y0: number; y1: number };
const hits = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/** The width the chart has to fill, so it is drawn at its real size instead of scaled. A callback
 *  ref, so it starts measuring whenever the chart appears (a live run shows the empty state first). */
function useWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = React.useState<HTMLDivElement | null>(null);
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}

/** Tasks solved against cost per solved task, one point per model. Top left is best; the pink chip
 *  measures how far left the open model sits from the closed comparison. */
export function Scatter({ models, S, colors }: { models: Model[]; S: Record<string, Summary>; colors: Record<string, Swatch> }) {
  const [hover, setHover] = React.useState<string | null>(null);
  const [box, width] = useWidth();
  const W = Math.max(width, 480);
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

  const maxX = Math.max(...pts.map((p) => p.s.cost_per_solved!)) * 1.15 || 1;
  const step = niceStep(maxX), xMax = Math.ceil(maxX / step) * step;
  const x = (v: number) => L + (v / xMax) * (W - L - R);
  const yStep = Math.max(1, Math.ceil(Math.max(...pts.map((p) => p.s.tasks_solved)) / 4)), yMax = yStep * 4;
  const y = (v: number) => T + (1 - v / yMax) * (H - T - B);
  const fmtX = (v: number) => (v === 0 ? "$0" : step >= 1 ? `$${v.toFixed(0)}` : step >= 0.01 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`);
  const xTicks: number[] = [];
  for (let v = 0; v <= xMax + 1e-9; v += step) xTicks.push(v);
  const at = (p: (typeof pts)[number]) => ({ cx: x(p.s.cost_per_solved!), cy: y(p.s.tasks_solved) });

  // The headline trade-off, drawn: a connector from the closed model across to the open one (an elbow
  // when they solved different counts), with the cost difference on its level run.
  const t = takeaway(models, S);
  const from = pts.find((p) => p.m.key === t.closed?.key), to = pts.find((p) => p.m.key === t.open?.key);
  let gap: { d: string; head: string; chip: Box; text: string; runs: Box[] } | null = null;
  if (from && to && t.cost && t.cost.ahead !== null) {
    const a = at(from), b = at(to);
    const w = t.cost.text.length * 7.4 + 16, h = 22, dir = Math.sign(b.cx - a.cx), drop = Math.abs(b.cy - a.cy) > 14;
    if (Math.abs(a.cx - b.cx) > w + 56) {
      const x0 = a.cx + dir * 11, end = drop ? b.cx : b.cx - dir * 11;
      const mid = (x0 + end) / 2, v = Math.sign(b.cy - a.cy), yEnd = b.cy - v * 11;
      gap = {
        d: drop ? `M ${x0} ${a.cy} H ${b.cx} V ${yEnd}` : `M ${x0} ${a.cy} H ${end}`,
        head: drop ? `M ${b.cx - 6} ${yEnd - v * 6} L ${b.cx} ${yEnd} L ${b.cx + 6} ${yEnd - v * 6}`
          : `M ${end - dir * 6} ${a.cy - 6} L ${end} ${a.cy} L ${end - dir * 6} ${a.cy + 6}`,
        text: t.cost.text,
        chip: { x0: mid - w / 2, x1: mid + w / 2, y0: a.cy - h / 2, y1: a.cy + h / 2 },
        runs: [{ x0: Math.min(x0, b.cx) - 2, x1: Math.max(x0, b.cx) + 2, y0: a.cy - 3, y1: a.cy + 3 },
          ...(drop ? [{ x0: b.cx - 3, x1: b.cx + 3, y0: Math.min(a.cy, b.cy), y1: Math.max(a.cy, b.cy) }] : [])],
      };
    }
  }

  // Name chips sit above-right of their point; a chip moves only if it would collide.
  const dots: Box[] = pts.map((p) => { const { cx, cy } = at(p); return { x0: cx - 9, x1: cx + 9, y0: cy - 9, y1: cy + 9 }; });
  const placed: Box[] = [...dots, ...(gap ? [gap.chip, ...gap.runs] : [])];
  const chips = pts.map((p, i) => {
    const { cx, cy } = at(p);
    const w = p.m.label.length * CHAR + 16, h = 22;
    const spots = [[cx + 10, cy - 30], [cx - 10 - w, cy - 30], [cx + 12, cy + 8], [cx - 12 - w, cy + 8], [cx - w / 2, cy - 36], [cx - w / 2, cy + 14], [cx + 14, cy - h / 2], [cx - 14 - w, cy - h / 2]];
    for (const [x0, y0] of spots) {
      const b = { x0, x1: x0 + w, y0, y1: y0 + h };
      if (b.x0 < L + 2 || b.x1 > W - 2 || b.y0 < 2 || b.y1 > H - B) continue;
      if (placed.some((o) => o !== dots[i] && hits(b, o))) continue;
      placed.push(b);
      return { x0, y0, w, h };
    }
    return null;
  });

  const active = pts.find((p) => p.m.key === hover);
  return (
    <Column heading="Quality against cost" aside={<span className="label-mono text-muted-foreground">Up and to the left is better</span>}>
      <div ref={box} className="relative w-full">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block max-w-full" role="img" aria-label="Tasks solved against cost per solved task, one point per model">
          <rect x={L} y={T} width={W - L - R} height={H - T - B} className="fill-white dark:fill-white/[0.03]" />
          {[0, 1, 2, 3, 4].map((i) => i * yStep).map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--rule)" strokeDasharray="4 4" />
              <text x={L - 10} y={y(v) + 4} textAnchor="end" className="fill-muted-foreground font-mono text-[11px]">{v}</text>
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
          <text x={0} y={T - 18} className="fill-foreground font-mono text-[11px] uppercase tracking-[0.06em]">Solved</text>
          <text x={W - R} y={H - 6} textAnchor="end" className="fill-foreground font-mono text-[11px] uppercase tracking-[0.06em]">Cost per solved task</text>
          {gap && (
            <g aria-hidden>
              <path d={gap.d} fill="none" stroke="var(--line)" />
              <path d={gap.head} fill="none" stroke="var(--line)" />
              <rect x={gap.chip.x0} y={gap.chip.y0} width={gap.chip.x1 - gap.chip.x0} height={gap.chip.y1 - gap.chip.y0} rx={2} fill="var(--delta)" />
              <text x={(gap.chip.x0 + gap.chip.x1) / 2} y={gap.chip.y0 + 16} textAnchor="middle" className="fill-black font-sans text-[14px]">{gap.text}</text>
            </g>
          )}
          {pts.map((p, i) => {
            const { cx, cy } = at(p);
            const sw = colors[p.m.key], chip = chips[i];
            return (
              <g
                key={p.m.key}
                tabIndex={0}
                role="img"
                aria-label={`${p.m.label}: ${p.s.tasks_solved} solved, ${usd(p.s.cost_per_solved)} per solved task`}
                onPointerEnter={() => setHover(p.m.key)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(p.m.key)}
                onBlur={() => setHover(null)}
                className="cursor-default outline-none"
              >
                <circle cx={cx} cy={cy} r={16} fill="transparent" />
                <circle cx={cx} cy={cy} r={hover === p.m.key ? 9 : 7} fill={sw?.fill} stroke="var(--background)" strokeWidth={2} className="transition-[r]" />
                {chip && (
                  <g>
                    <rect x={chip.x0} y={chip.y0} width={chip.w} height={chip.h} rx={2} fill={sw?.fill} />
                    <text x={chip.x0 + 8} y={chip.y0 + 15} fill={sw?.ink} className="font-mono text-[11px] uppercase tracking-[0.06em]">{p.m.label}</text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
        {active && (
          <div
            className="pointer-events-none absolute z-10 min-w-48 -translate-x-1/2 -translate-y-full bg-primary px-3 py-2 text-[12px] text-primary-foreground shadow-pop"
            style={{ left: at(active).cx, top: at(active).cy - 14 }}
          >
            <div className="label-mono mb-1">{active.m.label}</div>
            {([["Solved", String(active.s.tasks_solved)], ["Cost per solved task", usd(active.s.cost_per_solved)]] as const).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4"><span className="opacity-75">{k}</span><b className="num font-medium">{v}</b></div>
            ))}
          </div>
        )}
      </div>
    </Column>
  );
}
