import { gsap } from 'gsap'
import {
	BoxGeometry,
	Color,
	DoubleSide,
	Group,
	Mesh,
	MeshBasicMaterial,
	Plane,
	PlaneGeometry,
	Raycaster,
	ShaderMaterial,
	Vector2,
	Vector3,
	Vector4,
} from 'three'
import { breakpoints } from '../../core/breakpoints.js'
import { defineScene } from '../../core/types.js'
import { BRAND_COLORS } from '../../palette.js'
import {
	createFloorRayUniforms,
	createFullscreenMesh,
	floorRayVertexShader,
} from '../../shaders/common.js'
import { createMouseTrail } from '../../utils/mouseTrail.js'
import { createCanvasClip } from '../../utils/faceCanvas.js'
import { createVideoTexture } from '../../utils/videoTexture.js'
import { createLabelTextures } from './label.js'
import { floorFragmentShader, volumeShaders } from './shaders.js'
import { createHomeHeroSlider } from './slider.js'
export { createHomeHeroSlider } from './slider.js'
/** Default slide colors, in slide order, when the options give none. */
export const HOME_HERO_COLORS = [
	BRAND_COLORS.green,
	BRAND_COLORS.pink,
	BRAND_COLORS.blue,
	BRAND_COLORS.yellow,
	BRAND_COLORS.purple,
]
const CELL_ASPECT = 169 / 56
/**
 * The front (+Z) face of a volume is exactly filled by a video: `aspect`
 * (width / height) sets the volume height, so every video of a volume must share it.
 */
const VOLUMES = [
	{ aspect: 1920 / 2180 },
	{ aspect: 1920 / 730 },
	{ aspect: 1920 / 1240 },
	{ aspect: 1920 / 900 },
]
/**
 * Floor cells (integer cell coordinates) the volumes stand on, in `VOLUMES` order.
 * The first formation shows on load; slide changes draw the others at random, without
 * repeats until every one has been shown.
 * Laid out for the camera below: no volume covers another (hover lift included), the
 * tall Production volume stays in the middle, and every formation keeps the first
 * one's center and size, clear of the hero UI at desktop widths.
 */
const FORMATIONS = [
	// One volume back left, two stacked on the right
	[
		[-1, 1],
		[0, 3],
		[-1, -4],
		[1, 0],
	],
	// Diagonal: back left, back right, one in front on the right
	[
		[-1, 0],
		[-1, -5],
		[1, 1],
		[-1, 3],
	],
	// A row behind Production, which steps forward
	[
		[-1, 2],
		[-1, -5],
		[1, 2],
		[0, -3],
	],
	// One volume back left, two staggered on the right
	[
		[-1, 1],
		[1, 3],
		[1, 0],
		[-1, -5],
	],
]
const HOVER_LIFT = 0.2 // of the cell depth
const HOVER_DURATION = 0.3
/** Slide change: volumes sink one by one, stay hidden until the next videos have a frame, move, change color, rise again. */
const SINK_DURATION = 0.5
const STAGGER = 0.04
const HIDDEN_PAUSE = 0.1
/** Every volume rising (or sinking from the top), stagger included. */
const SWEEP_DURATION = SINK_DURATION + STAGGER * (VOLUMES.length - 1)
const TRANSITION_DURATION = SWEEP_DURATION + HIDDEN_PAUSE + SWEEP_DURATION
/** First load: the volumes rise once their videos and label are ready, but no sooner than this. */
const INTRO_DELAY = 0.1
/** Longest wait for them: past it the volumes rise anyway, so a video that never loads can't keep them hidden. */
const INTRO_TIMEOUT = 3
/** A floor change asked for during another one waits for it, sped up this much. */
const FLOOR_CATCH_UP = 3
const DESKTOP_ZOOM = 2.4
/**
 * Below the `md` breakpoint the visual is square, under the slide navigation (top
 * right) and a logo cell (bottom right). The formations together are ~4.5 world units
 * wide: this zoom and pan keep each of them, hover lift included, at least 8px clear of
 * the edges and of both from a 320px viewport up.
 */
const MOBILE_ZOOM = 1.2
const MOBILE_CAMERA_PAN = [0.25, 0]
const CAMERA_ZOOM_OUT = 0.85
const SEED_LIMIT = 10_000
const MOUSE_TRAIL_RADIUS = 0.25
/**
 * Floor cells where the active color dominates (min x, min z, max x, max z): the
 * formation's bounds inset by a cell, always including the Production volume.
 */
function formationCore(cells) {
	const xs = cells.map(([x]) => x)
	const zs = cells.map(([, z]) => z)
	const [tallX, tallZ] = cells[0]
	return new Vector4(
		Math.min(Math.min(...xs) + 1, tallX),
		Math.min(Math.min(...zs) + 1, tallZ),
		Math.max(Math.max(...xs) - 1, tallX),
		Math.max(Math.max(...zs) - 1, tallZ),
	)
}
/**
 * Home hero: isometric volumes on an infinite colored grid floor, cycling
 * through the product slides. Autoplay waits while a volume is hovered or the
 * slider is paused. Returns the scene, its UI-facing `store` and `select` for
 * the slide navigation.
 */
export function createHomeHeroScene({
	colors: slideColors,
	slider: sharedSlider,
	cellScale = 0.35,
	cameraPan = [0.25, 0.2],
	autoplaySeconds = 8,
	slideVideos,
	slideFaces,
	labels,
} = {}) {
	const colors = slideColors?.length ? slideColors : HOME_HERO_COLORS
	const slider = sharedSlider ?? createHomeHeroSlider(colors.length)
	const { store, select } = slider
	// The floor picks "any other color" from the palette, so it needs at least two.
	const palette = colors.length > 1 ? colors : [colors[0], colors[0]]
	const clips = new Map()
	/** Clips on screen, or the next slide's while it sinks. Anything else pauses once it has a frame. */
	let pinned = new Set()
	function clipFor(src) {
		let clip = clips.get(src)
		if (clip) return clip
		// A face is a video URL, or a canvas drawn by the page (`createFaceCanvas`).
		clip = typeof src === 'string' ? createVideoTexture(src) : createCanvasClip(src)
		clips.set(src, clip)
		void clip.loaded.then(() => {
			// Leave the frame in place for a paint. Pausing in the same turn can drop it.
			requestAnimationFrame(() => {
				if (!pinned.has(clip)) clip.pause()
			})
		})
		return clip
	}
	// A volume without footage or a drawn face keeps a plain dark front.
	const blankFaces = VOLUMES.map(() =>
		Object.assign(document.createElement('canvas'), { width: 2, height: 2 }),
	)
	function clipsForSlide(slide) {
		return VOLUMES.map((_, volume) =>
			clipFor(
				slideFaces?.[slide]?.[volume] || slideVideos?.[slide]?.[volume] || blankFaces[volume],
			),
		)
	}
	/** Plays `next` and pauses every other clip that already has a frame. */
	function pinClips(next) {
		const nextSet = new Set(next)
		for (const clip of pinned) {
			if (!nextSet.has(clip)) clip.pause()
		}
		pinned = nextSet
		for (const clip of pinned) clip.play()
	}
	/**
	 * Resolves when every clip has a frame, or after `INTRO_TIMEOUT` so a source that
	 * never loads can't hold the volumes under the floor.
	 */
	function waitForFrames(list) {
		let settled = false
		let timeout
		return new Promise((resolve) => {
			const finish = () => {
				if (settled) return
				settled = true
				timeout?.kill()
				resolve()
			}
			timeout = gsap.delayedCall(INTRO_TIMEOUT, finish)
			void Promise.all(list.map((clip) => clip.loaded)).then(finish)
		})
	}
	const scene = defineScene({
		name: 'Home Hero',
		camera: {
			type: 'orthographic',
			frustumHeight: 6,
			zoom: DESKTOP_ZOOM,
			position: [-2, 2, 2],
			target: [0, 0, 0],
		},
		create({ scene, camera, renderer, pointer, gui }) {
			const cameraOrigin = camera.position.clone()
			const cameraRight = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
			const cameraUp = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
			const mobileCamera = { zoom: MOBILE_ZOOM }
			let baseZoom = DESKTOP_ZOOM
			// Slide changes zoom out by this factor and back, so a resize meanwhile still ends on `baseZoom`
			const zoomOut = { value: 1 }
			function applyZoom() {
				camera.zoom = baseZoom * zoomOut.value
				camera.updateProjectionMatrix()
			}
			// Match the host's CSS breakpoint, where the visual turns square
			function fitCamera() {
				const mobile = window.innerWidth < breakpoints.md
				const [panRight, panUp] = mobile ? MOBILE_CAMERA_PAN : cameraPan
				camera.position
					.copy(cameraOrigin)
					.addScaledVector(cameraRight, panRight)
					.addScaledVector(cameraUp, panUp)
				camera.updateMatrixWorld()
				baseZoom = mobile ? mobileCamera.zoom : DESKTOP_ZOOM
				applyZoom()
			}
			fitCamera()
			const cellSize = new Vector2(cellScale * CELL_ASPECT, cellScale)
			const hoverLift = cellSize.y * HOVER_LIFT
			const trail = createMouseTrail(renderer, { radius: MOUSE_TRAIL_RADIUS })
			const { activeIndex } = store.get()
			let formation = 0
			// Formations not shown yet in this round: a formation comes back only after all
			// the others, and a new round leaves out the current one, so none shows twice in a row.
			let unusedFormations = []
			function pickFormation() {
				if (unusedFormations.length === 0) {
					unusedFormations = FORMATIONS.map((_, index) => index).filter(
						(index) => index !== formation,
					)
				}
				const [picked] = unusedFormations.splice(
					Math.floor(Math.random() * unusedFormations.length),
					1,
				)
				return picked ?? formation
			}
			// Floor: fullscreen shader + an invisible plane writing depth, so volumes sink "into" it.
			const floorUniforms = {
				...createFloorRayUniforms(camera),
				uFloorColor: { value: new Color('#F1F5F0') },
				uGridColor: { value: new Color('#A2AE9D') },
				uTrailNeutralColor: { value: new Color('#D5DDD2') },
				uPalette: { value: palette.map((color) => new Color(color)) },
				uPreviousCore: { value: formationCore(FORMATIONS[formation]) },
				uNextCore: { value: formationCore(FORMATIONS[formation]) },
				uCellSize: { value: cellSize },
				uPreviousIndex: { value: activeIndex },
				uNextIndex: { value: activeIndex },
				uPreviousSeed: { value: 0 },
				uNextSeed: { value: 0 },
				uTransition: { value: 0 },
				uTrailStrength: { value: 1 },
				uTrailTexture: trail.texture,
				uTrailOrigin: { value: new Vector2() },
				uTrailAxisU: { value: new Vector2(1, 0) },
				uTrailAxisV: { value: new Vector2(0, 1) },
			}
			const floor = createFullscreenMesh(
				new ShaderMaterial({
					uniforms: floorUniforms,
					vertexShader: floorRayVertexShader,
					fragmentShader: floorFragmentShader,
					defines: { SLIDE_COUNT: palette.length },
					depthTest: false,
					depthWrite: false,
				}),
			)
			floor.renderOrder = -1000
			const floorOccluder = new Mesh(
				new PlaneGeometry(1000, 1000),
				new MeshBasicMaterial({ colorWrite: false, side: DoubleSide }),
			)
			floorOccluder.rotation.x = -Math.PI / 2
			floorOccluder.renderOrder = -999
			scene.add(floor, floorOccluder)
			// The slide's product on the Production volume (the first, tallest): its name on
			// the top face, its icon at the top of the left (-X) face. Boxes include `hoverLift`.
			const productionHeight = cellSize.x / VOLUMES[0].aspect + hoverLift
			const label = createLabelTextures(
				{ width: cellSize.x, height: cellSize.y },
				{ width: cellSize.y, height: productionHeight },
			)
			label.icon.anisotropy = label.title.anisotropy = renderer.capabilities.getMaxAnisotropy()
			label.preload(labels ?? [])
			const labelShown = label.show(labels?.[activeIndex])
			// Volumes. Each box is taller than its visible height by `hoverLift` and
			// sunk by the same amount, so lifting it on hover never shows a gap. The
			// video covers the visible height of the front face.
			const volumeUniforms = { uColor: { value: new Color(colors[activeIndex]) } }
			const initialClips = clipsForSlide(activeIndex)
			pinClips(initialClips)
			// The other slides buffer while this one plays, so a switch already has frames.
			queueMicrotask(() => {
				for (let slide = 0; slide < colors.length; slide++) clipsForSlide(slide)
			})
			const volumes = VOLUMES.map(({ aspect }, index) => {
				const height = cellSize.x / aspect
				const restY = (height - hoverLift) / 2
				// Root height that puts the whole volume just below the floor
				const hiddenY = -height - 0.001
				const material = new ShaderMaterial({
					...volumeShaders,
					uniforms: {
						...volumeUniforms,
						uVideo: { value: initialClips[index].texture },
						uVideoBottom: { value: hoverLift / (height + hoverLift) },
						uIcon: { value: label.icon },
						uHasIcon: { value: index === 0 && Boolean(labels) },
						uTitle: { value: label.title },
						uHasTitle: { value: index === 0 && Boolean(labels) },
					},
				})
				const root = new Group()
				const mesh = new Mesh(new BoxGeometry(cellSize.x, height + hoverLift, cellSize.y), material)
				mesh.position.y = restY
				root.add(mesh)
				scene.add(root)
				return { height, restY, hiddenY, root, mesh, material, hovered: false }
			})
			// The floor takes part in the hover raycast: it stops rays before the part of a
			// volume sunk below it, so only what shows above the floor can be hovered.
			const hoverTargets = [floorOccluder, ...volumes.map(({ mesh }) => mesh)]
			/** Moves the volumes onto a formation's cells. */
			function placeVolumes(index) {
				FORMATIONS[index].forEach(([x, z], volumeIndex) => {
					const { root } = volumes[volumeIndex]
					root.position.x = (x + 0.5) * cellSize.x
					root.position.z = (z + 0.5) * cellSize.y
				})
			}
			/** Volumes from left to right on screen, where the camera's right is +X +Z. */
			function screenOrder(index) {
				const cells = FORMATIONS[index]
				const screenX = ([x, z]) => (x + 0.5) * cellSize.x + (z + 0.5) * cellSize.y
				return volumes
					.map((volume, volumeIndex) => ({ volume, x: screenX(cells[volumeIndex]) }))
					.sort((a, b) => a.x - b.x)
					.map(({ volume }) => volume)
			}
			/** Raises a formation's volumes from below the floor, left to right on screen, from `at` on. */
			function riseVolumes(timeline, index, at) {
				screenOrder(index).forEach((volume, order) => {
					timeline.to(
						volume.root.position,
						{ y: 0, duration: SINK_DURATION, ease: 'power2.out' },
						at + order * STAGGER,
					)
				})
			}
			placeVolumes(formation)
			// Trail area: the screen footprint on the floor (a parallelogram for an
			// orthographic camera), enlarged to still cover the view when zoomed out.
			const floorPlane = new Plane(new Vector3(0, 1, 0), 0)
			const { uTrailOrigin: origin, uTrailAxisU: axisU, uTrailAxisV: axisV } = floorUniforms
			const cornerRaycaster = new Raycaster()
			function floorPointAt(ndcX, ndcY) {
				cornerRaycaster.setFromCamera(new Vector2(ndcX, ndcY), camera)
				return cornerRaycaster.ray.intersectPlane(floorPlane, new Vector3())
			}
			function updateTrailArea() {
				camera.updateMatrixWorld()
				const corners = [floorPointAt(-1, -1), floorPointAt(1, -1), floorPointAt(-1, 1)]
				if (corners.some((corner) => !corner)) {
					return
				}
				// Scale around the parallelogram center (midpoint of its diagonal).
				const [bottomLeft, bottomRight, topLeft] = corners
				const center = bottomRight.clone().add(topLeft).multiplyScalar(0.5)
				corners.forEach((corner) =>
					corner
						.sub(center)
						.multiplyScalar(1 / CAMERA_ZOOM_OUT)
						.add(center),
				)
				origin.value.set(bottomLeft.x, bottomLeft.z)
				axisU.value.set(bottomRight.x - bottomLeft.x, bottomRight.z - bottomLeft.z)
				axisV.value.set(topLeft.x - bottomLeft.x, topLeft.z - bottomLeft.z)
				trail.clear()
			}
			/** Trail UV under the pointer: solves hit = origin + u * axisU + v * axisV. */
			const hitPoint = new Vector3()
			const trailUv = new Vector2()
			function pointerTrailUv() {
				const hit = pointer.inside && pointer.raycaster.ray.intersectPlane(floorPlane, hitPoint)
				if (!hit) {
					return null
				}
				const dx = hit.x - origin.value.x
				const dz = hit.z - origin.value.y
				const determinant = axisU.value.x * axisV.value.y - axisU.value.y * axisV.value.x
				trailUv.set(
					(dx * axisV.value.y - dz * axisV.value.x) / determinant,
					(axisU.value.x * dz - axisU.value.y * dx) / determinant,
				)
				return Math.min(trailUv.x, trailUv.y) >= 0 && Math.max(trailUv.x, trailUv.y) <= 1
					? trailUv
					: null
			}
			updateTrailArea()
			function setHovered(volume, hovered) {
				if (volume.hovered !== hovered) {
					volume.hovered = hovered
					gsap.to(volume.mesh.position, {
						y: volume.restY + (hovered ? hoverLift : 0),
						duration: HOVER_DURATION,
						ease: 'power2.out',
						overwrite: 'auto',
					})
				}
			}
			let floorTween
			let queuedFloor
			let seed = 0
			/**
			 * Floor side of a slide change. The shader only blends two states, so a change
			 * asked for during another one waits for it (sped up) instead of jumping.
			 */
			function changeFloor(index, core) {
				if (floorTween) {
					queuedFloor = { index, core }
					floorTween.timeScale(FLOOR_CATCH_UP)
					return
				}
				const nextSeed = (seed + 1) % SEED_LIMIT
				floorUniforms.uNextIndex.value = index
				floorUniforms.uNextSeed.value = nextSeed
				floorUniforms.uNextCore.value.copy(core)
				floorUniforms.uTransition.value = 0
				floorTween = gsap.to(floorUniforms.uTransition, {
					value: 1,
					duration: TRANSITION_DURATION,
					ease: 'none',
					onComplete() {
						seed = nextSeed
						floorUniforms.uPreviousIndex.value = index
						floorUniforms.uPreviousSeed.value = nextSeed
						floorUniforms.uPreviousCore.value.copy(core)
						floorUniforms.uTransition.value = 0
						floorTween = undefined
						const queued = queuedFloor
						queuedFloor = undefined
						if (queued) {
							changeFloor(queued.index, queued.core)
						}
					},
				})
			}
			let timeline
			let transitionId = 0
			let disposed = false
			// First load: the volumes wait below the floor, so they never show empty faces, then
			// rise as in a slide change. Autoplay and hover wait for them.
			volumes.forEach((volume) => (volume.root.position.y = volume.hiddenY))
			store.set({ transitioning: true })
			let introPending = true
			const introTimeout = gsap.delayedCall(INTRO_TIMEOUT, startIntro)
			void Promise.all([
				labelShown,
				...initialClips.map((clip) => clip.loaded),
				new Promise((resolve) => gsap.delayedCall(INTRO_DELAY, resolve)),
			]).then(startIntro)
			function cancelIntro() {
				introPending = false
				introTimeout.kill()
			}
			function startIntro() {
				if (!introPending) return
				cancelIntro()
				const introTimeline = gsap.timeline({
					onComplete() {
						timeline = undefined
						store.set({ transitioning: false, progress: 0 })
					},
				})
				riseVolumes(introTimeline, formation, 0)
				timeline = introTimeline
			}
			slider.setTransition((index) => {
				// A change asked for during another one, or before the first rise, takes over
				// from wherever the volumes are.
				const id = ++transitionId
				cancelIntro()
				timeline?.kill()
				const nextFormation = pickFormation()
				const nextClips = clipsForSlide(index)
				// Decode the next picture while the current volumes are still sinking.
				for (const clip of nextClips) {
					pinned.add(clip)
					clip.play()
				}
				changeFloor(index, formationCore(FORMATIONS[nextFormation]))
				store.set({ activeIndex: index, transitioning: true, cardVisible: false, progress: 0 })
				for (const volume of volumes) {
					gsap.killTweensOf(volume.mesh.position)
					volume.hovered = false
				}
				const nextTimeline = gsap.timeline({
					onComplete() {
						timeline = undefined
						store.set({ transitioning: false, cardVisible: true, progress: 0 })
					},
				})
				// Left to right on screen: settle any hover and sink below the floor, then
				// rise back in the next formation, left to right again. Volumes already
				// (partly) sunk by an interrupted change only cover what is left.
				let hiddenAt = 0
				screenOrder(formation)
					.filter((volume) => volume.root.position.y > -volume.height)
					.forEach((volume, order) => {
						const sinkDuration = SINK_DURATION * (1 + volume.root.position.y / volume.height)
						hiddenAt = Math.max(hiddenAt, order * STAGGER + sinkDuration)
						nextTimeline.to(
							volume.root.position,
							{ y: volume.hiddenY, duration: sinkDuration, ease: 'power2.in' },
							order * STAGGER,
						)
					})
				volumes.forEach((volume) =>
					nextTimeline.to(
						volume.mesh.position,
						{ y: volume.restY, duration: HOVER_DURATION, ease: 'power2.out' },
						0,
					),
				)
				const riseAt = hiddenAt + HIDDEN_PAUSE
				const duration = riseAt + SWEEP_DURATION
				riseVolumes(nextTimeline, nextFormation, riseAt)
				// The rise and the product copy wait here until the next videos have a frame,
				// so the new product is already on the volumes when they animate back in.
				nextTimeline.addPause(hiddenAt, () => {
					formation = nextFormation
					placeVolumes(formation)
					volumeUniforms.uColor.value.set(colors[index])
					void label.show(labels?.[index])
					store.set({ displayedIndex: index })
					formationParams.formation = formation
					formationBinding.refresh()
					void waitForFrames(nextClips).then(() => {
						if (disposed || id !== transitionId) return
						volumes.forEach((volume, volumeIndex) => {
							const clip = nextClips[volumeIndex]
							volume.material.uniforms.uVideo.value = clip.texture
							clip.texture.needsUpdate = true
						})
						pinClips(nextClips)
						requestAnimationFrame(() => {
							if (disposed || id !== transitionId) return
							nextTimeline.play()
						})
					})
				})
				nextTimeline
					.call(() => store.set({ cardVisible: true }), undefined, riseAt)
					.to(
						zoomOut,
						{
							value: CAMERA_ZOOM_OUT,
							duration: duration / 2,
							ease: 'sine.inOut',
							onUpdate: applyZoom,
						},
						0,
					)
					.to(
						zoomOut,
						{
							value: 1,
							duration: duration / 2,
							ease: 'sine.inOut',
							onUpdate: applyZoom,
						},
						duration / 2,
					)
				timeline = nextTimeline
			})
			// Shows a formation at once, to review it without waiting for a slide change
			const formationParams = { formation }
			const formationBinding = gui
				.addBinding(formationParams, 'formation', {
					label: 'Formation',
					options: Object.fromEntries(FORMATIONS.map((_, index) => [`${index + 1}`, index])),
				})
				.on('change', ({ value }) => {
					if (store.get().transitioning) {
						formationParams.formation = formation
						formationBinding.refresh()
						return
					}
					formation = value
					// A new round, which leaves out the formation just shown
					unusedFormations = []
					placeVolumes(formation)
					floorUniforms.uPreviousCore.value.copy(formationCore(FORMATIONS[formation]))
					floorUniforms.uNextCore.value.copy(floorUniforms.uPreviousCore.value)
				})
			gui
				.addFolder({ title: 'Camera' })
				.addBinding(mobileCamera, 'zoom', { label: 'Mobile zoom', min: 0.5, max: 3, step: 0.01 })
				.on('change', () => {
					fitCamera()
					updateTrailArea()
				})
			gui.addFolder({ title: 'Grid trail' }).addBinding(floorUniforms.uTrailStrength, 'value', {
				label: 'Strength',
				min: 0,
				max: 2,
				step: 0.01,
			})
			return {
				update({ delta, elapsed }) {
					trail.update(pointerTrailUv(), delta)
					// Drawn faces that animate redraw while their block is on screen.
					for (const clip of pinned) clip.update?.(elapsed)
					const state = store.get()
					const hit =
						pointer.inside && !state.transitioning
							? pointer.raycaster.intersectObjects(hoverTargets, false)[0]?.object
							: undefined
					const hovered = hit === floorOccluder ? undefined : hit
					volumes.forEach((volume) => setHovered(volume, volume.mesh === hovered))
					if (!state.transitioning && !state.paused && !hovered) {
						const progress = state.progress + delta / autoplaySeconds
						if (progress >= 1) {
							select(state.activeIndex + 1)
						} else {
							store.set({ progress })
						}
					}
				},
				resize() {
					fitCamera()
					updateTrailArea()
				},
				dispose() {
					disposed = true
					transitionId += 1
					slider.setTransition(undefined)
					cancelIntro()
					timeline?.kill()
					floorTween?.kill()
					volumes.forEach((volume) => {
						gsap.killTweensOf([volume.mesh.position, volume.root.position])
					})
					for (const clip of clips.values()) clip.dispose()
					clips.clear()
					pinned = new Set()
					label.dispose()
					trail.dispose()
					// Leave a consistent state in case the scene is mounted again.
					store.set({
						displayedIndex: store.get().activeIndex,
						transitioning: false,
						cardVisible: true,
						progress: 0,
					})
				},
			}
		},
	})
	return { scene, store, select }
}
