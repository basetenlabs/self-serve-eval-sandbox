import { BoxGeometry, Mesh } from 'three'
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
/** `defineScene` for a product hero: the shared camera, zoomed out below the `md` breakpoint. */
export function defineProductHeroScene({ name, create }) {
	return defineScene({
		name,
		camera: PRODUCT_HERO_CAMERA,
		create(context) {
			const { camera, gui } = context
			const zoom = { mobile: MOBILE_ZOOM }
			const fitCamera = () => {
				camera.zoom = isPortraitHero() ? zoom.mobile : DESKTOP_ZOOM
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
				resize(size) {
					fitCamera()
					controller.resize?.(size)
				},
			}
		},
	})
}
/** The hero product cube at the origin, with its own pointer trail and code video. */
export function createHeroProductCube({ scene, renderer }, options) {
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
	return {
		mesh,
		/** `pointerUv`: where to paint the trail on the grid face (see `pointerOnGridFace`), or null. */
		update({ delta, elapsed }, pointerUv) {
			uniforms.uTime.value = elapsed
			video.update?.(elapsed)
			trail.update(pointerUv, delta)
		},
		dispose() {
			trail.dispose()
			video.dispose()
		},
	}
}
