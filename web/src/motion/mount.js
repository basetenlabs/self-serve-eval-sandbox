/**
 * Mounts one WebGL scene in a box, the way www.baseten.co does (its `WebGLCanvas` component),
 * without a framework.
 *
 *   import { mountScene } from './motion/mount.js'
 *   import { bricksScene } from './motion/webgl/scenes/bricks.js'
 *   const handle = mountScene(document.querySelector('.scene'), bricksScene, { poster: 'bricks.png' })
 *
 * What it does, as on the site:
 * - the canvas fills the box and fades in over 0.3s once it has rendered (`motion.css`);
 * - the frame loop, tweens driven by it and the scene's videos stop while the box is off screen;
 * - if WebGL cannot start, or its context is lost later, the scene is released and the box shows
 *   `poster` (a still frame of the scene) or simply what is behind it. The page keeps working.
 *
 * What it adds, which the site does not have:
 * - `prefers-reduced-motion`: the scene plays just long enough to reach its resting picture
 *   (`settle` seconds), then stops: nothing loops, nothing follows the pointer. `handle.wake()`
 *   shows a change the visitor asked for (another product, another tab) as a 0.3s cross-fade
 *   between the two resting pictures instead of the travelling animation.
 *
 * The box carries `data-webgl-scene` (the scene name) and `data-webgl-state`:
 * `loading`, `ready`, `still` (reduced motion, at rest) or `fallback`.
 */
import { gsap } from './lib/gsap.js'
import { createWebGLRuntime } from './webgl/core/runtime.js'

// The site sets this once for every tween on the page: a tween without its own ease is linear.
gsap.defaults({ ease: 'none' })

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

/**
 * @param {HTMLElement} container  Positioned box with a size; the canvas fills it.
 * @param {object} scene           A scene definition (`defineScene`), e.g. `bricksScene`.
 * @param {object} [options]
 * @param {string} [options.poster]         Image shown when WebGL is unavailable or lost.
 * @param {number} [options.settle=2.5]     Reduced motion: seconds the scene runs before it rests.
 * @param {boolean} [options.reducedMotion] Force the reduced-motion behaviour on or off (default: the media query).
 * @param {Function} [options.Pane]         Tweakpane's `Pane` class, to tune the scene's parameters live.
 * @param {Record<string, any>} [options.tune]  Sets the scene's own parameters, by the names its
 *   tuning panel shows: `{ 'Cube swaps/Density': 0.05, 'Cube oscillation/Speed': 0.5 }` (the label
 *   alone works when it is unique). A name the scene does not have is warned about in the console.
 * @param {(reason: 'initialization' | 'context-lost', error?: unknown) => void} [options.onFallback]
 */
export function mountScene(container, scene, options = {}) {
	const { poster, settle = 2.5, Pane, tune, onFallback } = options
	const media = window.matchMedia(REDUCED_MOTION)
	const reduced = () => options.reducedMotion ?? media.matches
	let runtime = null
	let failed = false
	let inView = false
	let restTimer = 0
	let resting = false
	let overlay = null

	container.dataset.webglScene = scene.name
	container.dataset.webglState = 'loading'

	function fallback(reason, error) {
		if (failed) return
		failed = true
		// Clear the reference first: disposal itself emits a context-loss event.
		const previous = runtime
		runtime = null
		clearTimeout(restTimer)
		overlay?.remove()
		previous?.dispose()
		container.dataset.webglState = 'fallback'
		if (poster) {
			// JSON.stringify quotes and escapes the URL, so it cannot end the url() and add declarations.
			container.style.backgroundImage = `url(${JSON.stringify(String(poster))})`
			container.style.backgroundPosition = 'center'
			container.style.backgroundSize = 'cover'
			container.style.backgroundRepeat = 'no-repeat'
		}
		onFallback?.(reason, error)
	}

	function onContextLost(event) {
		event.preventDefault()
		fallback('context-lost')
	}

	/** Runs or stops the loop from what is known: on screen, reduced motion, at rest. */
	function sync() {
		if (!runtime) return
		if (inView && !(reduced() && resting)) {
			runtime.resume()
		} else {
			runtime.pause()
		}
		container.dataset.webglState = reduced() && resting ? 'still' : 'ready'
	}

	/** Reduced motion: lets the scene run for `seconds`, then freezes it on its resting picture. */
	function rest(seconds) {
		clearTimeout(restTimer)
		resting = false
		sync()
		restTimer = setTimeout(() => {
			resting = true
			sync()
			if (overlay) {
				// The new resting picture is ready under the old one: cross-fade.
				const previous = overlay
				overlay = null
				previous.style.opacity = '0'
				setTimeout(() => previous.remove(), 300)
			}
		}, seconds * 1000)
	}

	/** The current frame as a PNG data URL (also how to make a `poster`). */
	function capture() {
		if (!runtime) return null
		const { renderer, scene: root, camera } = runtime.context
		renderer.render(root, camera)
		return renderer.domElement.toDataURL('image/png')
	}

	/**
	 * Reduced motion only: call right before changing the scene on the visitor's request
	 * (`select(index)`). The current picture stays up while the scene moves underneath for
	 * `seconds`, then fades to the new one. Without reduced motion it does nothing.
	 */
	function wake(seconds = settle) {
		if (!runtime || !reduced()) return
		if (!overlay) {
			const frame = capture()
			if (frame) {
				overlay = Object.assign(new Image(), { src: frame, alt: '' })
				overlay.style.cssText =
					'position:absolute;inset:0;inline-size:100%;block-size:100%;pointer-events:none;transition:opacity .3s'
				container.append(overlay)
			}
		}
		rest(seconds)
	}

	function onMotionPreference() {
		clearTimeout(restTimer)
		overlay?.remove()
		overlay = null
		resting = false
		if (reduced()) rest(settle)
		else sync()
	}

	try {
		runtime = createWebGLRuntime(container, scene, { debug: Boolean(Pane), Pane, tune })
		container.dataset.webglState = 'ready'
		// Context-loss events do not bubble; capture them from the child canvas.
		container.addEventListener('webglcontextlost', onContextLost, true)
	} catch (error) {
		fallback('initialization', error)
	}

	const observer = new IntersectionObserver(([entry]) => {
		inView = entry.isIntersecting
		sync()
	})
	observer.observe(container)
	media.addEventListener('change', onMotionPreference)
	if (runtime && reduced()) rest(settle)

	return {
		/** The runtime (`context`, `pause`, `resume`), or null after a fallback. */
		get runtime() {
			return runtime
		},
		capture,
		wake,
		dispose() {
			clearTimeout(restTimer)
			observer.disconnect()
			media.removeEventListener('change', onMotionPreference)
			container.removeEventListener('webglcontextlost', onContextLost, true)
			overlay?.remove()
			runtime?.dispose()
			runtime = null
		},
	}
}
