// The /baseten-design motion system (src/motion, the skill's assets/motion copied whole): live WebGL scenes, numbers
// that count once in view and values that roll when they change. Every piece honours prefers-reduced-motion.
import * as React from "react";
import { initMotion, reducedMotion, rollingNumber } from "@/motion/motion.js";
import { mountProductHero } from "@/motion/blocks/product-hero.js";
import { createFaceCanvas } from "@/motion/webgl/utils/faceCanvas.js";

export { reducedMotion };

/** Starts the markup hooks (.bt-number[data-count], ...) under `ref` once mounted; stops them on unmount. */
export function useMotion<T extends HTMLElement>(ref: React.RefObject<T | null>, deps: React.DependencyList = []) {
  React.useEffect(() => (ref.current ? initMotion(ref.current) : undefined), deps); // eslint-disable-line react-hooks/exhaustive-deps
}

/** A product page hero scene (motion/blocks/product-hero.js) in `root`'s `.scene` box, with a terminal on the cube face. */
export function useProductHero<T extends HTMLElement>(ref: React.RefObject<T | null>, scene: string, lines: string[]) {
  React.useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let handle: { dispose(): void } | undefined;
    try {
      const face = createFaceCanvas(1, (f: { terminal(lines: string[], time: number): void }, time: number) => f.terminal(lines, time), { animate: true });
      handle = mountProductHero(root, { scene, face });
    } catch {
      // No scene: the still picture under the box stays.
    }
    return () => handle?.dispose();
  }, [ref, scene]); // eslint-disable-line react-hooks/exhaustive-deps
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
