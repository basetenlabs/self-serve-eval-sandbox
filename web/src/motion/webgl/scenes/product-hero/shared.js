import { gsap } from '../../../lib/gsap.js'
import { BoxGeometry, Mesh } from '../../../lib/three.js'
import { breakpoints } from '../../core/breakpoints.js'
import { defineScene } from '../../core/types.js'
import { createProductCubeMaterial } from '../../objects/productCube.js'
import { createMouseTrail } from '../../utils/mouseTrail.js'
import { createFaceClip } from '../../utils/faceCanvas.js'
const DESKTOP_ZOOM = 3.04
/** The mobile visual is portrait (339 × 424): at the desktop zoom the cube would fill its width */
const MOBILE_ZOOM = 1.5
/** Isometric camera shared by all product hero scenes. The cube is 1 unit wide at the origin. */
const PRODUCT_HERO_CAMERA = {
	type: 'orthographic',
	frustumHeight: 6,
	zoom: DESKTOP_ZOOM,
	position: [-30, 30, 30],
	target: [0, 0, 0],
}
/** Below the `md` breakpoint the host's visual turns portrait: the camera zooms out, and scenes can lay out differently. */
export const isPortraitHero = () => window.innerWidth < breakpoints.md
/**
 * Options every product hero scene takes.
 * @typedef {object} ProductHeroOptions
 * @property {{ color: string, background?: string, pattern: string }} [product]  The cube's look (default: the scene's own product).
 * @property {string | HTMLCanvasElement} [videoUrl]  The cube's left face: footage URL, or a canvas from `createFaceCanvas`.
 * @property {number | ((size: { width: number, height: number }) => number)} [zoom]
 *   Camera zoom. Default as on the site: 3.04, or 1.5 when the window is under 801px wide (the
 *   visual turns portrait there). A pane inside an app sets its own: a number, or a function of
 *   the canvas size, called on every resize. The cube is 1 unit wide in a view 6 units tall at zoom 1.
 * @property {boolean} [trailFade]  Default true: the cube's cells ease in under the pointer
 *   (0.5s sine.out) and ease back out (1.5s), as the cube in the home page's products row does.
 *   False is the site's product-page behaviour: cells open at full depth the frame the pointer arrives.
 */

/** `defineScene` for a product hero: the shared camera, zoomed out below the `md` breakpoint. */
export function defineProductHeroScene({ name, create, zoom: zoomOption }) {
	return defineScene({
		name,
		camera: PRODUCT_HERO_CAMERA,
		create(context) {
			const { camera, gui } = context
			const zoom = { mobile: MOBILE_ZOOM }
			let size = context.size
			const fitCamera = () => {
				if (typeof zoomOption === 'function') camera.zoom = zoomOption(size)
				else camera.zoom = zoomOption ?? (isPortraitHero() ? zoom.mobile : DESKTOP_ZOOM)
				camera.updateProjectionMatrix()
			}
			const controller = create(context) ?? {}
			fitCamera()
			gui
				.addFolder({ title: 'Camera' })
				.addBinding(zoom, 'mobile', { label: 'Mobile zoom', min: 1, max: 4, step: 0.01 })
				.on('change', fitCamera)
			return {
				...controller,
				resize(next) {
					size = next
					fitCamera()
					controller.resize?.(next)
				},
			}
		},
	})
}
/** Cell depth under the pointer eases in when the pointer reaches the grid face (as in scenes/products.js). */
const TRAIL_INTENSITY_TWEEN = { duration: 0.5, ease: 'sine.out' }
/** Slower ease out when the pointer leaves the grid face. */
const TRAIL_LEAVE_DURATION = 1.5
/** The hero product cube at the origin, with its own pointer trail and code video. */
export function createHeroProductCube({ scene, renderer }, { trailFade = true, ...options }) {
	const trail = createMouseTrail(renderer)
	// `videoUrl`: footage, or a canvas from `createFaceCanvas` (utils/faceCanvas.js).
	const video = createFaceClip(options.videoUrl)
	const { material, uniforms } = createProductCubeMaterial({
		...options,
		videoTexture: video.texture,
		trailTexture: trail.texture,
	})
	const mesh = new Mesh(new BoxGeometry(), material)
	scene.add(mesh)
	/** Scales the trail on the cube, so its cells ease in instead of jumping. */
	const trailIntensity = { value: trailFade ? 0 : 1 }
	let trailOn = false
	return {
		mesh,
		/** `pointerUv`: where to paint the trail on the grid face (see `pointerOnGridFace`), or null. */
		update({ delta, elapsed }, pointerUv) {
			uniforms.uTime.value = elapsed
			video.update?.(elapsed)
			if (trailFade) {
				if (trailOn !== !!pointerUv) {
					trailOn = !!pointerUv
					gsap.to(trailIntensity, {
						value: Number(trailOn),
						...TRAIL_INTENSITY_TWEEN,
						duration: trailOn ? TRAIL_INTENSITY_TWEEN.duration : TRAIL_LEAVE_DURATION,
						overwrite: true,
					})
				}
				uniforms.uTrailInfluence.value = trailIntensity.value
			}
			trail.update(pointerUv, delta)
		},
		dispose() {
			gsap.killTweensOf(trailIntensity)
			trail.dispose()
			video.dispose()
		},
	}
}
