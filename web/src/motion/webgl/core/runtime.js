import { Scene, WebGLRenderer } from 'three'
import { createCamera, updateCameraAspect } from './camera.js'
import { disposeObject3D, materialTextures } from './dispose.js'
import { createNullGui } from './gui.js'
import { createPointer } from './pointer.js'
/**
 * Mounts a scene inside `container`: creates canvas, renderer, camera, pointer
 * and debug panel, runs the frame loop and keeps everything sized to the
 * container. This is the only piece a framework wrapper needs to call.
 *
 * `pause()` / `resume()` stop and restart the loop and the scene's videos,
 * e.g. while the canvas is off-screen.
 */
export function createWebGLRuntime(container, definition, options = {}) {
	// Register each resource as it is acquired, including partially initialized scenes.
	const disposers = []
	const defer = (dispose) => disposers.push(dispose)
	function cleanup() {
		for (const dispose of disposers.splice(0).reverse()) {
			try {
				dispose()
			} catch (error) {
				console.warn('WebGL resource cleanup failed', error)
			}
		}
	}
	try {
		const canvas = document.createElement('canvas')
		canvas.style.cssText = 'display:block;width:100%;height:100%'
		container.append(canvas)
		defer(() => canvas.remove())
		// Probe on the actual canvas so unsupported graphics do not trigger Three's
		// repeated console errors. Reuse this context rather than allocating a second one.
		const gl = canvas.getContext('webgl2', {
			alpha: true,
			antialias: true,
			powerPreference: 'high-performance',
		})
		if (!gl) throw new Error('Error creating WebGL context.')
		const renderer = new WebGLRenderer({
			canvas,
			context: gl,
			alpha: true,
			antialias: true,
			powerPreference: 'high-performance',
		})
		defer(() => renderer.forceContextLoss())
		defer(() => renderer.dispose())
		defer(() => renderer.setAnimationLoop(null))
		const scene = new Scene()
		defer(() => disposeObject3D(scene))
		const camera = createCamera(definition.camera)
		const pointerTracker = createPointer(canvas, {
			followTouchScroll: definition.followTouchScroll,
		})
		defer(() => pointerTracker.dispose())
		let gui
		let guiElement
		defer(() => guiElement?.remove())
		defer(() => gui?.dispose())
		const size = { width: 0, height: 0, aspect: 1, pixelRatio: 0 }
		/** Returns true when the drawing buffer had to change. */
		function measure() {
			const width = Math.max(container.clientWidth, 1)
			const height = Math.max(container.clientHeight, 1)
			const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
			if (width === size.width && height === size.height && pixelRatio === size.pixelRatio) {
				return false
			}
			Object.assign(size, { width, height, aspect: width / height, pixelRatio })
			renderer.setPixelRatio(pixelRatio)
			renderer.setSize(width, height, false)
			updateCameraAspect(camera, definition.camera, size.aspect)
			return true
		}
		measure()
		const context = {
			scene,
			camera,
			renderer,
			size,
			pointer: pointerTracker.pointer,
			// Created on first access, so scenes without parameters get no empty panel.
			get gui() {
				if (!gui) {
					// Without the Tweakpane class the scene binds to a panel that does nothing.
					if (!options.Pane) {
						gui = createNullGui()
						return gui
					}
					guiElement = Object.assign(document.createElement('div'), {
						className: 'webgl-gui',
						hidden: !(options.debug ?? true),
					})
					container.append(guiElement)
					// Collapsed by default: a page can host several scenes, each with its own panel.
					gui = new options.Pane({ title: definition.name, container: guiElement, expanded: false })
				}
				return gui
			},
		}
		const controller = definition.create(context) ?? {}
		defer(() => controller.dispose?.())
		renderer.render(scene, camera)
		const resizeObserver = new ResizeObserver(() => {
			if (measure()) {
				controller.resize?.(size)
				// Resizing clears the drawing buffer: render now so a blank frame is never painted.
				renderer.render(scene, camera)
			}
		})
		defer(() => resizeObserver.disconnect())
		resizeObserver.observe(container)
		let previousTime
		let elapsed = 0
		let paused = false
		/** Videos that were playing when the runtime was paused, to restart on resume. */
		let pausedVideos = []
		function frame(time) {
			const delta = Math.min((time - (previousTime ?? time)) / 1000, 0.1)
			previousTime = time
			elapsed += delta
			pointerTracker.update(camera)
			controller.update?.({ delta, elapsed })
			renderer.render(scene, camera)
		}
		/** Videos used by the scene's textures (e.g. the product cube code video). */
		function sceneVideos() {
			const videos = new Set()
			scene.traverse((object) => {
				const { material } = object
				const materials = Array.isArray(material) ? material : material ? [material] : []
				for (const { image } of materials.flatMap(materialTextures)) {
					if (image instanceof HTMLVideoElement) {
						videos.add(image)
					}
				}
			})
			return [...videos]
		}
		renderer.setAnimationLoop(frame)
		return {
			context,
			/** Stops the frame loop (everything driven by `update` freezes) and the scene's videos. */
			pause() {
				if (paused) {
					return
				}
				paused = true
				renderer.setAnimationLoop(null)
				pausedVideos = sceneVideos().filter((video) => !video.paused)
				pausedVideos.forEach((video) => video.pause())
			},
			/** Restarts what `pause` stopped; animations continue from where they froze. */
			resume() {
				if (!paused) {
					return
				}
				paused = false
				// The first frame after a pause gets a zero delta instead of the time spent paused.
				previousTime = undefined
				renderer.setAnimationLoop(frame)
				pausedVideos.forEach((video) => void video.play().catch(() => {}))
				pausedVideos = []
			},
			dispose: cleanup,
		}
	} catch (error) {
		cleanup()
		throw error
	}
}
