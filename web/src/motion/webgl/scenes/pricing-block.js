import { Box3, BoxGeometry, MathUtils, Mesh, Plane, Vector2, Vector3 } from '../../lib/three.js'
import { breakpoints } from '../core/breakpoints.js'
import { defineScene } from '../core/types.js'
import { createProductCubeMaterial, pointerOnGridFace } from '../objects/productCube.js'
import { getProduct } from '../palette.js'
import { createMouseTrail } from '../utils/mouseTrail.js'
import { createFaceClip } from '../utils/faceCanvas.js'
/** Same color/product mapping as the Products slider, in pricing-scene order. */
const CUBES = [
	{ position: [2.0, -0.8, 0], product: 'model-apis' },
	{ position: [0.2, -2.3, -2], product: 'dedicated-inference' },
	{ position: [2.5, -3.1, -4], product: 'sandbox' },
]
/** What each calculator slider drives on every cube, in slider order. */
const SLIDER_EFFECTS = ['scale', 'frequency', 'amplitude']
const CUBE_SIZE = 1.8
/** Degrees: expose the material's -X video face and +Z grid face to the camera. */
const CUBE_ROTATION = [45, 45, 0]
const FRUSTUM_HEIGHT = 5
/** Physics substep, so the spring stays stable at low frame rates. */
const MAX_STEP = 1 / 120
/**
 * Three floating cubes below the pricing title. They drift on a slow Lissajous
 * path and are pushed away by the pointer (also a touch scrolling the page)
 * through a damped spring, bouncing off the canvas top where the title ends.
 * The calculator sliders set their size, floating frequency and floating amplitude.
 * Materials, video and grid patterns are shared with the Products slider.
 */
export function createPricingBlockScene({ sliderLevels, videoUrl } = {}) {
	return defineScene({
		name: 'Pricing block',
		camera: { type: 'orthographic', frustumHeight: FRUSTUM_HEIGHT, position: [10, 10, 10] },
		followTouchScroll: true,
		create({ scene, camera, renderer, pointer, gui, size }) {
			const floating = { amplitude: 0.25, frequency: 0.65 }
			const repulsion = { strength: 18, radius: 4.5, spring: 15, damping: 3.3, activationSpeed: 5 }
			/**
			 * `headroom`: space between the canvas top and the highest cube at rest. `gutter`: space
			 * around the cubes on narrow layouts, where they all fit the canvas. World units.
			 */
			const framing = { zoom: 0.84, headroom: 0.45, gutter: 0.2 }
			/** The cubes bounce off a ceiling `gap` below the canvas top, keeping `bounce` of their speed. */
			const ceiling = { gap: 0.1, bounce: 0.4 }
			/** How fast each slider's `level` follows the calculator (1/s). */
			const sliderFollow = 6
			/** Multiplier of each slider effect, from the slider at 0 to the slider at 1. */
			const sliderEffects = {
				scale: { min: 0.8, max: 1.2 },
				frequency: { min: 0.25, max: 2.5 },
				amplitude: { min: 0.25, max: 4 },
			}
			/** Whether a calculator slider drives each effect, and its eased position (0..1). */
			const sliders = SLIDER_EFFECTS.map((effect) => ({ effect, linked: false, level: 0 }))
			/** Multiplier of `effect` on every cube: 1 until a slider drives it. */
			function sliderEffect(effect) {
				const slider = sliders.find((candidate) => candidate.effect === effect)
				const { min, max } = sliderEffects[effect]
				return slider.linked ? MathUtils.lerp(min, max, slider.level) : 1
			}
			const geometry = new BoxGeometry()
			// One video for all cubes, with an independent grid trail on each cube.
			// `videoUrl`: footage, or a canvas from `createFaceCanvas` (utils/faceCanvas.js).
			const video = createFaceClip(videoUrl)
			const cubes = CUBES.map((config, index) => {
				const trail = createMouseTrail(renderer)
				const { material, uniforms } = createProductCubeMaterial({
					product: getProduct(config.product),
					videoTexture: video.texture,
					trailTexture: trail.texture,
				})
				const mesh = new Mesh(geometry, material)
				mesh.scale.setScalar(CUBE_SIZE)
				mesh.position.fromArray(config.position)
				mesh.rotation.set(...CUBE_ROTATION.map(MathUtils.degToRad))
				scene.add(mesh)
				return {
					mesh,
					uniforms,
					trail,
					base: new Vector3(...config.position),
					phase: 0.7 + index * 2.17,
					speed: 0.82 + index * 0.19,
					displacement: new Vector2(),
					velocity: new Vector2(),
					/** Floating phase, accumulated so a frequency change never makes it jump. */
					time: 0,
				}
			})
			// On-screen bounds at rest, at scale 1: the camera looks down -Z.
			const restBounds = new Box3()
			cubes.forEach(({ mesh }) => restBounds.expandByObject(mesh))
			const restSize = restBounds.getSize(new Vector3())
			const restCenter = restBounds.getCenter(new Vector3())
			/** Half the on-screen height of a cube, per unit of size. */
			const cubeHalfHeight =
				new Box3().setFromObject(cubes[0].mesh).getSize(new Vector3()).y / (2 * CUBE_SIZE)
			const pointerPlane = new Plane(new Vector3(0, 0, 1), 0)
			const pointerWorld = new Vector3()
			let hasPointerWorld = false
			let activation = 0
			const motionFolder = gui.addFolder({ title: 'Floating motion' })
			motionFolder.addBinding(floating, 'amplitude', { min: 0, max: 1, step: 0.01 })
			motionFolder.addBinding(floating, 'frequency', { min: 0, max: 2, step: 0.01 })
			const repulsionFolder = gui.addFolder({ title: 'Mouse repulsion' })
			repulsionFolder.addBinding(repulsion, 'strength', { min: 0, max: 30, step: 0.1 })
			repulsionFolder.addBinding(repulsion, 'radius', { min: 0.25, max: 5, step: 0.05 })
			repulsionFolder.addBinding(repulsion, 'spring', { min: 0, max: 30, step: 0.1 })
			repulsionFolder.addBinding(repulsion, 'damping', { min: 0, max: 15, step: 0.1 })
			repulsionFolder.addBinding(repulsion, 'activationSpeed', {
				label: 'activation speed',
				min: 0.1,
				max: 15,
				step: 0.1,
			})
			const cameraFolder = gui.addFolder({ title: 'Camera' })
			cameraFolder
				.addBinding(framing, 'zoom', { min: 0.3, max: 2, step: 0.01 })
				.on('change', () => resize(size))
			cameraFolder
				.addBinding(framing, 'headroom', { min: 0, max: 2, step: 0.01 })
				.on('change', () => resize(size))
			cameraFolder
				.addBinding(framing, 'gutter', { min: 0, max: 1, step: 0.01 })
				.on('change', () => resize(size))
			const ceilingFolder = gui.addFolder({ title: 'Ceiling' })
			ceilingFolder.addBinding(ceiling, 'gap', { min: 0, max: 1, step: 0.01 })
			ceilingFolder.addBinding(ceiling, 'bounce', { min: 0, max: 1, step: 0.01 })
			const slidersFolder = gui.addFolder({ title: 'Calculator sliders' })
			sliders.forEach((slider) =>
				slidersFolder.addBinding(slider, 'level', { label: slider.effect, readonly: true }),
			)
			for (const [effect, range] of Object.entries(sliderEffects)) {
				slidersFolder.addBinding(range, 'min', {
					label: `${effect} at 0`,
					min: 0,
					max: 5,
					step: 0.05,
				})
				slidersFolder.addBinding(range, 'max', {
					label: `${effect} at 1`,
					min: 0,
					max: 5,
					step: 0.05,
				})
			}
			function resize({ aspect }) {
				// Match the host's CSS breakpoint.
				const narrow = window.innerWidth < breakpoints.md
				camera.zoom = narrow
					? Math.min(
							(FRUSTUM_HEIGHT * aspect) / (restSize.x + 2 * framing.gutter),
							FRUSTUM_HEIGHT / (framing.headroom + restSize.y + framing.gutter),
						)
					: Math.min(1.5, aspect * 0.66) * framing.zoom
				const viewHeight = FRUSTUM_HEIGHT / camera.zoom
				// Center the cubes on narrow layouts, the pink cube in the right half on desktop.
				camera.position.x = narrow ? restCenter.x : 2.5 - aspect * viewHeight * 0.25
				camera.position.y = restBounds.max.y + framing.headroom - viewHeight / 2
				camera.updateProjectionMatrix()
			}
			resize(size)
			return {
				resize,
				update({ delta, elapsed }) {
					video.update?.(elapsed)
					if (pointer.inside && pointer.raycaster.ray.intersectPlane(pointerPlane, pointerWorld)) {
						hasPointerWorld = true
					}
					// The repulsion fades in/out when the pointer enters/leaves the block.
					activation = MathUtils.damp(
						activation,
						pointer.inside ? 1 : 0,
						repulsion.activationSpeed,
						delta,
					)
					const steps = Math.max(1, Math.ceil(delta / MAX_STEP))
					const step = delta / steps
					const levels = sliderLevels?.() ?? []
					sliders.forEach((slider, index) => {
						const target = levels[index]
						if (target !== undefined) {
							// The first value is taken as is, so the cubes don't animate on load.
							slider.level = slider.linked
								? MathUtils.damp(slider.level, target, sliderFollow, delta)
								: target
							slider.linked = true
						}
					})
					const frequency = floating.frequency * sliderEffect('frequency')
					const amplitude = floating.amplitude * sliderEffect('amplitude')
					const cubeSize = CUBE_SIZE * sliderEffect('scale')
					/** Highest center position: the canvas top is at `headroom` above the cubes at rest. */
					const maxY = restBounds.max.y + framing.headroom - ceiling.gap - cubeHalfHeight * cubeSize
					for (const cube of cubes) {
						cube.time += delta * frequency * cube.speed
						const { time } = cube
						const anchorX =
							cube.base.x +
							amplitude *
								(Math.sin(time + cube.phase) * 0.65 +
									Math.cos(time * 0.47 + cube.phase * 1.31) * 0.35)
						const anchorY =
							cube.base.y +
							amplitude *
								(Math.cos(time * 0.79 + cube.phase * 0.83) * 0.6 +
									Math.sin(time * 1.13 + cube.phase * 1.67) * 0.4)
						for (let index = 0; index < steps; index += 1) {
							let forceX = 0
							let forceY = 0
							if (hasPointerWorld && activation > 0.0001) {
								const offsetX = anchorX + cube.displacement.x - pointerWorld.x
								const offsetY = anchorY + cube.displacement.y - pointerWorld.y
								const distance = Math.hypot(offsetX, offsetY)
								if (distance < repulsion.radius) {
									const falloff = 1 - distance / repulsion.radius
									const force = repulsion.strength * falloff * falloff * activation
									// Exactly under the pointer: push along a stable per-cube direction.
									forceX =
										distance > 0.0001 ? (offsetX / distance) * force : Math.cos(cube.phase) * force
									forceY =
										distance > 0.0001 ? (offsetY / distance) * force : Math.sin(cube.phase) * force
								}
							}
							cube.velocity.x +=
								(forceX -
									cube.displacement.x * repulsion.spring -
									cube.velocity.x * repulsion.damping) *
								step
							cube.velocity.y +=
								(forceY -
									cube.displacement.y * repulsion.spring -
									cube.velocity.y * repulsion.damping) *
								step
							cube.displacement.addScaledVector(cube.velocity, step)
							const overshoot = anchorY + cube.displacement.y - maxY
							if (overshoot > 0) {
								cube.displacement.y -= overshoot
								if (cube.velocity.y > 0) {
									cube.velocity.y *= -ceiling.bounce
								}
							}
						}
						cube.mesh.position.set(
							anchorX + cube.displacement.x,
							anchorY + cube.displacement.y,
							cube.base.z,
						)
						cube.mesh.scale.setScalar(cubeSize)
						cube.mesh.updateMatrixWorld()
						cube.uniforms.uTime.value = elapsed
						cube.trail.update(pointerOnGridFace(pointer, cube.mesh), delta)
					}
				},
				dispose() {
					cubes.forEach(({ trail }) => trail.dispose())
					video.dispose()
				},
			}
		},
	})
}
/** Pricing block without calculator sliders linked. */
export const pricingBlockScene = createPricingBlockScene()
