import { gsap } from '../../lib/gsap.js'
import {
	BackSide,
	BoxGeometry,
	Color,
	Group,
	Mesh,
	Raycaster,
	ShaderMaterial,
	Vector2,
} from '../../lib/three.js'
import { toNdc } from '../core/pointer.js'
import { createStore } from '../core/store.js'
import { defineScene } from '../core/types.js'
import { createProductCubeMaterial, pointerOnGridFace } from '../objects/productCube.js'
import { PRODUCTS } from '../palette.js'
import {
	createFloorRayUniforms,
	createFullscreenMesh,
	floorRayHit,
	floorRayVertexShader,
} from '../shaders/common.js'
import { createMouseTrail } from '../utils/mouseTrail.js'
import { createFaceClip } from '../utils/faceCanvas.js'
/** The row is repeated three times so it can scroll endlessly; the middle copy is the "home" one. */
const REPEAT_COUNT = 3
const MIDDLE_GROUP = 1
const CUBE_SPACING = 1.5
const TRANSITION_DURATION = 0.6
const TRANSITION_EASE = 'sine.inOut'
const INACTIVE_ROTATION = -Math.PI / 2
const HOLE_DELAY = 0.2
const CAMERA_ZOOM_IN = 0.93
/** The translucent box behind the active cube stretches back along Z. */
const BACK_CUBE = { opacity: 0.2, activeDepth: 7, inactiveDepth: 1, delay: 0.12 }
/** Trail intensity fades in as the pointer enters the grid face, out when the item changes. */
const TRAIL_INTENSITY_TWEEN = { duration: 0.5, ease: 'sine.out' }
/** Slower fade out when the pointer leaves the grid face. */
const TRAIL_LEAVE_DURATION = 1.5
const backgroundFragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uGridOffsetX;

  ${floorRayHit}

  const float GRID_SPACING = 0.5;
  const float GRID_OPACITY = 0.55;

  void main() {
    float visible;
    vec3 floorPosition = floorRayHit(-0.5, visible);
    vec2 gridPosition = vec2(floorPosition.x - uGridOffsetX, floorPosition.z) / GRID_SPACING;
    vec2 gridDistance = abs(fract(gridPosition - 0.5) - 0.5) / (max(fwidth(gridPosition), 0.0001) * 0.8);
    float line = 1.0 - min(min(gridDistance.x, gridDistance.y), 1.0);

    gl_FragColor = vec4(mix(uColor, vec3(1.0), line * visible * GRID_OPACITY), 1.0);
    #include <colorspace_fragment>
  }
`
const backCubeShaders = {
	vertexShader:
		'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
	fragmentShader: /* glsl */ `
    uniform vec3 uColor;
    uniform float uOpacity;

    void main() {
      gl_FragColor = vec4(uColor, uOpacity);
      #include <colorspace_fragment>
    }
  `,
}
/**
 * Products carousel: one cube per product on an endless row. Selecting a
 * product scrolls it to the center, rotates it to face the camera, opens its
 * holes and tints the background. State is exposed through `store`.
 */
export function createProductsScene({ products = PRODUCTS, initialActiveIndex = 0 } = {}) {
	const itemCount = products.length
	const wrapIndex = (index) =>
		itemCount && Number.isFinite(index)
			? ((Math.round(index) % itemCount) + itemCount) % itemCount
			: 0
	const store = createStore({ activeIndex: wrapIndex(initialActiveIndex) })
	let goTo
	function select(index) {
		const nextIndex = wrapIndex(index)
		// React echoes cube clicks back through the controlled activeIndex prop.
		// A repeated selection must not restart a transition already in flight.
		if (nextIndex === store.get().activeIndex) return
		if (goTo) {
			goTo(nextIndex)
		} else {
			store.set({ activeIndex: nextIndex })
		}
	}
	const scene = defineScene({
		name: 'Products',
		camera: {
			type: 'orthographic',
			frustumHeight: 6,
			zoom: 2.5,
			position: [-2, 2, 2],
			target: [0, 0, 0],
		},
		create({ scene, camera, renderer, pointer }) {
			if (!itemCount) return
			const initialIndex = store.get().activeIndex
			const baseZoom = camera.zoom
			const trail = createMouseTrail(renderer)
			const videos = new Map()
			const items = products.map((product, itemIndex) => {
				// The code face is footage (`videoUrl`) or a canvas the page draws (`face`,
				// see utils/faceCanvas.js); without either it stays dark.
				const source = product.face || product.videoUrl || ''
				let video = videos.get(source)
				if (!video) {
					video = createFaceClip(source)
					videos.set(source, video)
				}
				const isActive = itemIndex === initialIndex
				const { material, uniforms } = createProductCubeMaterial({
					product,
					videoTexture: video.texture,
					trailTexture: trail.texture,
				})
				uniforms.uProgress.value = Number(isActive)
				uniforms.uHoleProgress.value = Number(isActive)
				const backMaterial = new ShaderMaterial({
					...backCubeShaders,
					uniforms: { uColor: uniforms.uColor, uOpacity: { value: BACK_CUBE.opacity } },
					side: BackSide,
					transparent: true,
					depthWrite: false,
				})
				return { material, uniforms, backMaterial, cubes: [] }
			})
			const geometry = new BoxGeometry()
			const carousel = new Group()
			const slots = []
			const backSlots = []
			const slotOf = (itemIndex, group = MIDDLE_GROUP) => group * itemCount + itemIndex
			/** Actual repeated instance becoming active, also while a transition is in flight. */
			let activeSlot = slotOf(initialIndex)
			/** The centered cube: the only one that reacts to the pointer trail. */
			let interactiveCube
			/** Scales the trail on the centered cube, so the faces ease in instead of jumping. */
			const trailIntensity = { value: 0 }
			let trailOn = false
			/** False from an item change until the outgoing cube's trail has faded out. */
			let trailReady = true
			/** On when the pointer enters the grid face, off when it leaves (slowly) or the item changes. */
			function fadeTrail(on, duration = TRAIL_INTENSITY_TWEEN.duration) {
				if (trailOn !== on) {
					trailOn = on
					gsap.to(trailIntensity, {
						value: Number(on),
						...TRAIL_INTENSITY_TWEEN,
						duration,
						overwrite: true,
					})
				}
			}
			for (let group = 0; group < REPEAT_COUNT; group += 1) {
				items.forEach((item, itemIndex) => {
					const isActive = itemIndex === initialIndex
					const cube = new Mesh(geometry, item.material)
					const backCube = new Mesh(geometry, item.backMaterial)
					cube.position.x = slotOf(itemIndex, group) * CUBE_SPACING
					cube.rotation.y = isActive ? 0 : INACTIVE_ROTATION
					cube.userData.itemIndex = itemIndex
					const isCentered = slotOf(itemIndex, group) === activeSlot
					backCube.visible = isCentered
					backCube.scale.z = isCentered ? BACK_CUBE.activeDepth : BACK_CUBE.inactiveDepth
					// The three copies of a product share one material: switch the trail
					// on for the centered copy only. `uniformsNeedUpdate` forces the upload,
					// since same-material draws are batched without refreshing uniforms.
					cube.onBeforeRender = () => {
						item.uniforms.uTrailInfluence.value =
							cube === interactiveCube ? item.uniforms.uProgress.value * trailIntensity.value : 0
						item.material.uniformsNeedUpdate = true
					}
					cube.add(backCube)
					carousel.add(cube)
					slots.push(cube)
					backSlots.push(backCube)
					item.cubes.push(cube)
				})
			}
			interactiveCube = slots[slotOf(initialIndex)]
			carousel.position.x = -slotOf(initialIndex) * CUBE_SPACING
			const backgroundUniforms = {
				...createFloorRayUniforms(camera),
				uColor: { value: new Color(products[initialIndex].background) },
				uGridOffsetX: { value: carousel.position.x },
			}
			const background = createFullscreenMesh(
				new ShaderMaterial({
					uniforms: backgroundUniforms,
					vertexShader: floorRayVertexShader,
					fragmentShader: backgroundFragmentShader,
					depthTest: false,
					depthWrite: false,
				}),
			)
			background.renderOrder = -1000
			scene.add(background, carousel)
			let transition
			/** Move instance-specific back meshes to equivalent copies when the row wraps. */
			function recenterCarousel(positionX) {
				const slotOffset = Math.round((carousel.position.x - positionX) / CUBE_SPACING)
				if (slotOffset) {
					const visible = backSlots.flatMap((backCube, slot) =>
						backCube.visible ? [{ slot: slot + slotOffset, depth: backCube.scale.z }] : [],
					)
					backSlots.forEach((backCube) => {
						backCube.visible = false
						backCube.scale.z = BACK_CUBE.inactiveDepth
					})
					visible.forEach(({ slot, depth }) => {
						const backCube = backSlots[slot]
						if (backCube) {
							backCube.visible = true
							backCube.scale.z = depth
						}
					})
					activeSlot += slotOffset
				}
				carousel.position.x = positionX
			}
			/** Re-centers the carousel on the middle copy so it never runs out of cubes. */
			function wrapCarousel() {
				const centeredSlot = -carousel.position.x / CUBE_SPACING
				recenterCarousel(
					-(slotOf(0) + (((centeredSlot % itemCount) + itemCount) % itemCount)) * CUBE_SPACING,
				)
			}
			/** The copy of `itemIndex` closest to the current center, so the scroll takes the short way. */
			function nearestSlot(itemIndex) {
				const centeredSlot = -carousel.position.x / CUBE_SPACING
				const candidates = Array.from({ length: REPEAT_COUNT }, (_, group) =>
					slotOf(itemIndex, group),
				)
				return candidates.reduce((best, slot) =>
					Math.abs(slot - centeredSlot) < Math.abs(best - centeredSlot) ? slot : best,
				)
			}
			goTo = (nextIndex) => {
				transition?.kill()
				// The outgoing cube's trail fades out, then the incoming cube takes the trail
				// over at once, without waiting for the end of the transition.
				trailOn = false
				trailReady = false
				gsap.to(trailIntensity, {
					value: 0,
					ease: TRAIL_INTENSITY_TWEEN.ease,
					duration: TRAIL_INTENSITY_TWEEN.duration * trailIntensity.value,
					overwrite: true,
					onComplete() {
						trail.clear()
						interactiveCube = slots[activeSlot]
						trailReady = true
					},
				})
				wrapCarousel()
				const previousSlot = activeSlot
				activeSlot = nearestSlot(nextIndex)
				// On rapid selections, retire older outgoing instances; only the
				// incoming cube and the one it replaces can have an extended back mesh.
				backSlots.forEach((backCube, slot) => {
					if (slot !== previousSlot && slot !== activeSlot) {
						backCube.visible = false
						backCube.scale.z = BACK_CUBE.inactiveDepth
					}
				})
				const incomingBackCube = backSlots[activeSlot]
				const outgoingBackCube = backSlots[previousSlot]
				incomingBackCube.visible = true
				store.set({ activeIndex: nextIndex })
				const targetBackground = new Color(products[nextIndex].background)
				const timeline = gsap.timeline({
					defaults: { duration: TRANSITION_DURATION, ease: TRANSITION_EASE, overwrite: 'auto' },
					onComplete() {
						recenterCarousel(-slotOf(nextIndex) * CUBE_SPACING)
						camera.zoom = baseZoom
						camera.updateProjectionMatrix()
						// Recentering swaps the centered copy: the trail follows it, as it is.
						if (trailReady) {
							interactiveCube = slots[activeSlot]
						}
						transition = undefined
					},
				})
				const updateProjection = () => camera.updateProjectionMatrix()
				timeline.to(carousel.position, { x: -activeSlot * CUBE_SPACING }, 0)
				timeline.to(
					backgroundUniforms.uColor.value,
					{ r: targetBackground.r, g: targetBackground.g, b: targetBackground.b },
					0,
				)
				// Quick zoom-in and back, like a camera "breath" during the scroll.
				timeline.to(
					camera,
					{
						zoom: baseZoom * CAMERA_ZOOM_IN,
						duration: TRANSITION_DURATION / 2,
						onUpdate: updateProjection,
					},
					0,
				)
				timeline.to(
					camera,
					{ zoom: baseZoom, duration: TRANSITION_DURATION / 2, onUpdate: updateProjection },
					TRANSITION_DURATION / 2,
				)
				timeline.to(
					outgoingBackCube.scale,
					{
						z: BACK_CUBE.inactiveDepth,
						onComplete() {
							outgoingBackCube.visible = false
						},
					},
					0,
				)
				timeline.to(
					incomingBackCube.scale,
					{
						z: BACK_CUBE.activeDepth,
						duration: TRANSITION_DURATION - BACK_CUBE.delay,
					},
					BACK_CUBE.delay,
				)
				items.forEach((item, itemIndex) => {
					const isActive = itemIndex === nextIndex
					timeline.to(item.uniforms.uProgress, { value: Number(isActive) }, 0)
					timeline.to(
						item.uniforms.uHoleProgress,
						{ value: Number(isActive), duration: TRANSITION_DURATION - HOLE_DELAY },
						HOLE_DELAY,
					)
					item.cubes.forEach((cube) =>
						timeline.to(cube.rotation, { y: isActive ? 0 : INACTIVE_ROTATION }, 0),
					)
				})
				transition = timeline
			}
			const canvas = renderer.domElement
			const clickRaycaster = new Raycaster()
			const clickNdc = new Vector2()
			let isHovering = false
			// Raycast from the click itself: on touch the pointer is already gone when `click` fires.
			function handleClick(event) {
				clickRaycaster.setFromCamera(toNdc(event, canvas, clickNdc), camera)
				const cube = clickRaycaster.intersectObjects(slots, false)[0]?.object
				if (cube) {
					select(cube.userData.itemIndex)
				}
			}
			canvas.addEventListener('click', handleClick)
			return {
				update({ delta, elapsed }) {
					items.forEach(({ uniforms }) => (uniforms.uTime.value = elapsed))
					videos.forEach((video) => video.update?.(elapsed))
					backgroundUniforms.uGridOffsetX.value = carousel.position.x
					const hovering =
						pointer.inside && pointer.raycaster.intersectObjects(slots, false).length > 0
					if (hovering !== isHovering) {
						isHovering = hovering
						canvas.style.cursor = hovering ? 'pointer' : ''
					}
					const faceUv = interactiveCube ? pointerOnGridFace(pointer, interactiveCube) : null
					if (faceUv && trailReady) {
						fadeTrail(true)
					} else if (!faceUv) {
						fadeTrail(false, TRAIL_LEAVE_DURATION)
					}
					trail.update(faceUv, delta)
				},
				dispose() {
					goTo = undefined
					transition?.kill()
					gsap.killTweensOf(trailIntensity)
					canvas.removeEventListener('click', handleClick)
					canvas.style.cursor = ''
					trail.dispose()
					// The runtime also traverses material textures on disposal. Detach
					// videos first so each shared texture is disposed only once here.
					items.forEach(({ uniforms }) => (uniforms.uVideoTexture.value = null))
					videos.forEach((video) => video.dispose())
					videos.clear()
				},
			}
		},
	})
	return { scene, store, select }
}
