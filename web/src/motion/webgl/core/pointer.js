import { Raycaster, Vector2 } from 'three'
/** Normalized device coordinates (-1..1, y up) of a client position relative to `element`. */
export function toNdc({ clientX, clientY }, element, target = new Vector2()) {
	const bounds = element.getBoundingClientRect()
	return target.set(
		((clientX - bounds.left) / Math.max(bounds.width, 1)) * 2 - 1,
		1 - ((clientY - bounds.top) / Math.max(bounds.height, 1)) * 2,
	)
}
const TOUCH_EVENTS = ['touchstart', 'touchmove', 'touchend', 'touchcancel']
/**
 * Tracks the pointer at window level and maps it onto the canvas bounds.
 *
 * Listening on the window (instead of the canvas) keeps the interaction alive
 * when HTML is layered above the canvas, which is the norm on a real page.
 */
export function createPointer(canvas, { followTouchScroll = false } = {}) {
	const ndc = new Vector2()
	const uv = new Vector2()
	const raycaster = new Raycaster()
	const pointer = { ndc, uv, raycaster, inside: false }
	const client = { clientX: 0, clientY: 0 }
	let present = false
	function handleMove(event) {
		client.clientX = event.clientX
		client.clientY = event.clientY
		present = true
	}
	function handleLeave(event) {
		// The browser cancels the pointer of a touch that scrolls: `handleTouch` ends touches instead.
		if (followTouchScroll && event.pointerType === 'touch') {
			return
		}
		if (event.type !== 'pointerup' || event.pointerType !== 'mouse') {
			present = false
		}
	}
	/** Touch events keep coming while the touch scrolls the page. */
	function handleTouch(event) {
		const touch = event.touches[0]
		present = !!touch
		if (touch) {
			client.clientX = touch.clientX
			client.clientY = touch.clientY
		}
	}
	const root = document.documentElement
	window.addEventListener('pointermove', handleMove, { passive: true })
	window.addEventListener('pointerdown', handleMove, { passive: true })
	window.addEventListener('pointerup', handleLeave, { passive: true })
	window.addEventListener('pointercancel', handleLeave, { passive: true })
	root.addEventListener('pointerleave', handleLeave, { passive: true })
	if (followTouchScroll) {
		TOUCH_EVENTS.forEach((type) => window.addEventListener(type, handleTouch, { passive: true }))
	}
	return {
		pointer: pointer,
		/** Re-maps the last known position: the canvas may have scrolled or resized. */
		update(camera) {
			toNdc(client, canvas, ndc)
			uv.set(ndc.x * 0.5 + 0.5, ndc.y * 0.5 + 0.5)
			pointer.inside = present && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1
			camera.updateMatrixWorld()
			raycaster.setFromCamera(ndc, camera)
		},
		dispose() {
			window.removeEventListener('pointermove', handleMove)
			window.removeEventListener('pointerdown', handleMove)
			window.removeEventListener('pointerup', handleLeave)
			window.removeEventListener('pointercancel', handleLeave)
			root.removeEventListener('pointerleave', handleLeave)
			TOUCH_EVENTS.forEach((type) => window.removeEventListener(type, handleTouch))
		},
	}
}
