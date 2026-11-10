// The /baseten-design motion system's DOM layer (src/motion/motion.js, from the skill's assets/motion copied whole):
// numbers that count once in view, values that scramble in or roll when they change. GSAP only, so the standalone
// report can use it without three.js. Every piece honours prefers-reduced-motion.
import * as React from "react";
import { animateNumber, initMotion, odometer, reducedMotion, rollingNumber } from "@/motion/motion.js";

export { reducedMotion };

/** Starts the markup hooks (.bt-number[data-count], ...) under `ref` once mounted; stops them on unmount. */
export function useMotion<T extends HTMLElement>(ref: React.RefObject<T | null>, deps: React.DependencyList = []) {
  React.useEffect(() => (ref.current ? initMotion(ref.current) : undefined), deps); // eslint-disable-line react-hooks/exhaustive-deps
}

/** A value that rolls its digits to the new number when it changes while shown (motion.js rollingNumber). */
export function Rolling({ value, className }: { value: string; className?: string }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const roll = React.useRef<{ set(value: string): void } | null>(null);
  // Spaces become no-break spaces: each character is its own box, where a plain space would collapse.
  const text = value.replace(/ /g, "\u00a0");
  React.useLayoutEffect(() => {
    if (!ref.current) return;
    if (!roll.current) roll.current = rollingNumber(ref.current, text);
    else roll.current.set(text);
  }, [text]);
  return React.createElement("span", { ref, className });
}

/** A whole number that counts up from 0 once it comes into view (motion.js animateNumber, .bt-number). */
export function Count({ value, className }: { value: number; className?: string }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => (ref.current ? animateNumber(ref.current, { type: "up", min: 0, max: value, duration: 1500 }) : undefined), [value]);
  return React.createElement("span", { ref, className: className ? `bt-number ${className}` : "bt-number" });
}

/** A value that scrambles in once it comes into view, then locks on its characters (motion.js odometer). */
export function Scramble({ value, className }: { value: string; className?: string }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => (ref.current ? odometer(ref.current, value) : undefined), [value]);
  return React.createElement("span", { ref, className });
}
