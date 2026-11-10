/**
 * Product page hero: the product's cube at the centre of its own isometric world, as on
 * www.baseten.co/products/*. One scene per product:
 *
 * - `dedicated-inference` (green): at a steady pace a wave leaves the cube and sprouts a layer of
 *   outlined cube clusters on the ground; every layer keeps receding along the view direction and
 *   turning grey, then comes back with a new layout.
 * - `model-apis` (pink): the cube sits on striped lanes of dots; a scrolling noise picks which
 *   dots light up, and the pointer ripples through them.
 * - `training` (blue): loss-curve lines and pixel particles start high and fanned out, converge
 *   into the cube's left face, and leave on the other side as a trail.
 * - `sandbox` (yellow): the cube floats over a 9x9 floor of cubes that keep swapping places in
 *   random pairs.
 * - `grid` (purple): the cube as a router. Requests pour in from the left as small dots on a
 *   tangle of routes; the cube sends them out to the right one at a time along cell centres.
 *   Cells light up as requests pass, flash when one arrives, and light under the pointer.
 *
 * Every scene: the cube's mark breathes, its left face plays footage (or a drawn face), the
 * pointer over its front eases white holes open along its trail (0.5s in, 1.5s out), and the camera is the shared isometric
 * one (zoom 3.04; 1.5 on phones, where the visual turns portrait).
 *
 *   <section class="bt-surface layout-grid bt-product-hero">
 *     <div class="visual">
 *       <div class="scene bt-webgl" aria-hidden="true"></div>
 *       <nav class="subnav" aria-label="Products"><div class="bt-tabs">…links…</div></nav>
 *     </div>
 *     <div class="bt-title-rows"><h1>…</h1><div class="description">…</div><div class="bt-ctas">…</div></div>
 *   </section>
 *
 *   mountProductHero(section, { scene: 'training', videoUrl })   // or face: createFaceCanvas(1, …)
 *
 * `color` and `pattern` restyle the cube (any Base colour; any 5x5 mark) for a product that is
 * not one of the five.
 */
import { mountScene } from '../mount.js'
import { getProduct } from '../webgl/palette.js'
import { createDedicatedHeroScene } from '../webgl/scenes/product-hero/dedicated.js'
import { createGridHeroScene } from '../webgl/scenes/product-hero/grid/index.js'
import { createModelApisHeroScene } from '../webgl/scenes/product-hero/model-apis.js'
import { createSandboxHeroScene } from '../webgl/scenes/product-hero/sandbox.js'
import { createTrainingHeroScene } from '../webgl/scenes/product-hero/training/index.js'

export const PRODUCT_HERO_SCENES = {
	'dedicated-inference': { create: createDedicatedHeroScene, product: 'dedicated-inference' },
	'model-apis': { create: createModelApisHeroScene, product: 'model-apis' },
	training: { create: createTrainingHeroScene, product: 'training' },
	sandbox: { create: createSandboxHeroScene, product: 'sandbox' },
	grid: { create: createGridHeroScene, product: 'grid' },
}

/**
 * @param {HTMLElement} root  The `.bt-product-hero` section (or any element holding a `.scene`).
 * @param {object} options
 * @param {'dedicated-inference' | 'model-apis' | 'training' | 'sandbox' | 'grid'} options.scene
 * @param {string} [options.color]    Base colour of the cube (default: the scene's product).
 * @param {string} [options.pattern]  5x5 mark, rows separated by " \\ ", "1" = hole.
 * @param {string} [options.videoUrl] Footage for the cube's left face.
 * @param {HTMLCanvasElement} [options.face]  A drawn face instead (`createFaceCanvas`).
 * @param {number | ((size: { width: number, height: number }) => number)} [options.zoom]
 *   Camera zoom for a pane that is not the page hero (see ProductHeroOptions in scenes/product-hero/shared.js).
 * @param {boolean} [options.trailFade]  False: cells open the frame the pointer arrives, as on the site's product pages.
 * Remaining options go to `mountScene` (poster, settle, reducedMotion, onFallback).
 */
export function mountProductHero(
	root,
	{ scene, color, pattern, videoUrl, face, zoom, trailFade, ...mountOptions },
) {
	const entry = PRODUCT_HERO_SCENES[scene]
	if (!entry) throw new Error(`No product hero scene "${scene}"`)
	const look = getProduct(entry.product)
	const product = { ...look, ...(pattern ? { pattern } : {}), ...(color ? { color } : {}) }
	root.style.setProperty('--product-base', product.color)
	return mountScene(
		root.querySelector('.scene'),
		entry.create({ product, videoUrl: face || videoUrl, zoom, trailFade }),
		mountOptions,
	)
}
