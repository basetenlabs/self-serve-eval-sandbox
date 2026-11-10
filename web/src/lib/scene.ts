// The /baseten-design motion system's WebGL scenes (src/motion, the skill's assets/motion copied whole; three.js).
import * as React from "react";
import { mountProductHero } from "@/motion/blocks/product-hero.js";
import { createFaceCanvas } from "@/motion/webgl/utils/faceCanvas.js";

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

