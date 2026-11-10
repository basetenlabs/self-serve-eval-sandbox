/**
 * The DOM side of the Baseten motion system: everything on www.baseten.co that moves without
 * WebGL, as small functions with the site's own timings. Each takes an element and returns a
 * function that undoes it. `initMotion()` at the bottom wires every one of them from classes and
 * data attributes, so a page built from `baseten.css` only needs:
 *
 *   <script type="module">import { initMotion } from './motion/motion.js'; initMotion()</script>
 *
 * Timings and curves are the site's (see references/motion.md for the full table).
 */
import { gsap } from 'gsap'

// The site sets this once for every tween on the page: a tween without its own ease is linear.
gsap.defaults({ ease: 'none' })

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
export const MOBILE_QUERY = '(max-width: 800.98px)'
export const reducedMotion = () => window.matchMedia(REDUCED_MOTION_QUERY).matches

/** The signature curve: buttons, chevrons, lifting cells, clip-path wipes. 0.4s. */
export const EASE_LIFT = 'cubic-bezier(0.75, 0, 0.1, 0.99)'

/* ---------- Tabs ---------- */

/**
 * Roving focus for a tablist (`role="tablist"` with `role="tab"` children): arrows move in both
 * axes and wrap, Home and End jump to the edges, focus follows the selection.
 */
export function tabListKeyboard(tablist, { onChange }) {
	function onKeyDown(event) {
		const tabs = [...tablist.querySelectorAll('[role="tab"]')]
		const activeIndex = Math.max(
			0,
			tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true'),
		)
		const last = tabs.length - 1
		const next = {
			ArrowDown: activeIndex === last ? 0 : activeIndex + 1,
			ArrowRight: activeIndex === last ? 0 : activeIndex + 1,
			ArrowUp: activeIndex === 0 ? last : activeIndex - 1,
			ArrowLeft: activeIndex === 0 ? last : activeIndex - 1,
			Home: 0,
			End: last,
		}[event.key]
		if (next === undefined) return
		event.preventDefault()
		onChange(next)
		tabs[next]?.focus()
	}
	tablist.addEventListener('keydown', onKeyDown)
	return () => tablist.removeEventListener('keydown', onKeyDown)
}

/**
 * Autoplay countdown shared by every auto-advancing tab set on the site. Pauses are named, so
 * independent reasons (hover, the pause button, "not seen yet") cannot clear each other; progress
 * is kept across a pause and resets only when the active item changes. Drive it with `tick(ms)`
 * from a frame loop (`startTimer` does that).
 */
export function createAutoplayTimer({ count, duration, pauses = [] }) {
	let state = { activeIndex: 0, pauses: [...pauses] }
	let elapsed = 0
	const stateListeners = new Set()
	const progressListeners = new Set()
	const setState = (patch) => {
		state = { ...state, ...patch }
		stateListeners.forEach((listener) => listener())
	}
	const progress = () => (duration > 0 ? Math.min(elapsed / duration, 1) : 0)
	const setElapsed = (value) => {
		elapsed = value
		const current = progress()
		progressListeners.forEach((listener) => listener(current))
	}
	const go = (index) => {
		if (index !== state.activeIndex) setState({ activeIndex: index })
		setElapsed(0)
	}
	const isRunning = () => duration > 0 && count > 0 && state.pauses.length === 0
	const pause = (source) => {
		if (!state.pauses.includes(source)) setState({ pauses: [...state.pauses, source] })
	}
	const resume = (source) => {
		if (state.pauses.includes(source)) {
			setState({ pauses: state.pauses.filter((name) => name !== source) })
		}
	}
	return {
		get: () => state,
		getProgress: progress,
		isRunning,
		isPausedBy: (source) => state.pauses.includes(source),
		subscribe(listener) {
			stateListeners.add(listener)
			return () => stateListeners.delete(listener)
		},
		/** Called with the new progress on every running tick and with 0 when the item changes. */
		onProgress(listener) {
			progressListeners.add(listener)
			return () => progressListeners.delete(listener)
		},
		select(index) {
			if (index < 0 || index >= count || index === state.activeIndex) return
			go(index)
		},
		next() {
			if (count > 0) go((state.activeIndex + 1) % count)
		},
		pause,
		resume,
		toggle(source) {
			if (state.pauses.includes(source)) resume(source)
			else pause(source)
		},
		/** Advances by `delta` ms (at most 100, so a throttled tab cannot skip an item on return). */
		tick(delta) {
			if (!isRunning()) return
			const next = elapsed + Math.min(Math.max(delta, 0), 100)
			if (next >= duration) go((state.activeIndex + 1) % count)
			else setElapsed(next)
		},
	}
}

/** Ticks an autoplay timer every frame. Returns a stop function. */
export function startTimer(timer) {
	let frame = 0
	let previous
	const loop = (time) => {
		timer.tick(time - (previous ?? time))
		previous = time
		frame = requestAnimationFrame(loop)
	}
	frame = requestAnimationFrame(loop)
	return () => cancelAnimationFrame(frame)
}

/* ---------- Texture ---------- */

/**
 * Lines the dotted texture of "holes" (elements whose background is the page texture, such as
 * `.bt-logos i.hole` and the dotted corner rectangles) up with the texture behind them, so they
 * read as cut through the white block rather than as a patch laid on it.
 */
export function alignTexture(targets, textureElement = document.documentElement) {
	const list = [...targets]
	const align = () => {
		// Backgrounds are painted from box origins snapped to whole CSS pixels: snap both sides
		// the same way, or fractional layout positions leave the dots out of line.
		const origin = textureElement.getBoundingClientRect()
		const originX = Math.round(origin.left + textureElement.clientLeft)
		const originY = Math.round(origin.top + textureElement.clientTop)
		for (const target of list) {
			const box = target.getBoundingClientRect()
			const left = Math.round(box.left + target.clientLeft)
			const top = Math.round(box.top + target.clientTop)
			target.style.backgroundPosition = `${originX - left}px ${originY - top}px`
		}
	}
	align()
	const observer = new ResizeObserver(align)
	for (const element of new Set([document.documentElement, textureElement, ...list])) {
		observer.observe(element)
	}
	return () => {
		observer.disconnect()
		for (const target of list) target.style.backgroundPosition = ''
	}
}

/* ---------- Pixel scramble (logo hover, rotating customer logos) ---------- */

const SWAP_INTERVAL = 0.04 // seconds between two random pixel patterns
const DENSITY = 0.5 // share of flickering pixels lit at once

const pixelMask = (columns, rows, lit) => {
	const rects = lit
		.map((index) => `M${index % columns} ${Math.floor(index / columns)}h1v1h-1Z`)
		.join('')
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${columns} ${rows}" preserveAspectRatio="none"><path d="${rects}"/></svg>`
	return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

const setMask = (image, mask) => {
	image.style.maskImage = mask
	image.style.setProperty('-webkit-mask-image', mask)
}

/**
 * Scrambles an image out (0.24s) or in (0.32s): it shows through a grid of 3px pixels that
 * flicker at random until each locks off (out) or on (in) at a random time. The pixels mask the
 * image itself, so they only ever light up inside its own shape.
 */
export function scrambleImage(image, phase) {
	const duration = phase === 'out' ? 0.24 : 0.32
	const PIXEL = 3
	let grid
	const progress = { time: 0 }
	let lastSwap = -1

	image.style.maskSize = '100% 100%'
	image.style.setProperty('-webkit-mask-size', '100% 100%')
	if (phase === 'in') setMask(image, pixelMask(1, 1, []))

	const tween = gsap.to(progress, {
		time: duration,
		duration,
		ease: 'none',
		onUpdate() {
			// Measured once laid out: a just-shown image may not have its size yet
			if (!grid && image.offsetWidth > 0) {
				const columns = Math.max(1, Math.round(image.offsetWidth / PIXEL))
				const rows = Math.max(1, Math.round(image.offsetHeight / PIXEL))
				grid = {
					columns,
					rows,
					lockTimes: Array.from({ length: columns * rows }, () => Math.random() * duration),
				}
			}
			if (!grid) return
			const swap = Math.floor(progress.time / SWAP_INTERVAL)
			if (swap === lastSwap) return
			lastSwap = swap
			const lit = grid.lockTimes.flatMap((lockTime, index) => {
				const isLit = progress.time >= lockTime ? phase === 'in' : Math.random() < DENSITY
				return isLit ? [index] : []
			})
			setMask(image, pixelMask(grid.columns, grid.rows, lit))
		},
		onComplete() {
			// Out stays hidden until the next logo replaces it; in ends unmasked
			setMask(image, phase === 'in' ? '' : pixelMask(1, 1, []))
		},
	})

	return () => {
		tween.kill()
		setMask(image, '')
	}
}

/**
 * Rotating customer logos (home hero tiles). Every tile that holds several `<img>` shows the
 * first; every 2s one random tile (never the one just changed, nor one under the pointer or
 * focus) scrambles its logo out and its next one in. Two tiles never show the same logo.
 * Runs only while the list is on screen, and not at all under reduced motion.
 *
 *   <div class="bt-logos" data-rotate>
 *     <div class="bt-logo-tile"><img src="a.svg" alt="A"><img src="b.svg" alt="B" hidden></div>
 */
export function rotateLogos(list, { interval = 2000 } = {}) {
	const tiles = [...list.querySelectorAll('.bt-logo-tile')]
		.map((tile) => ({ tile, images: [...tile.querySelectorAll('img')] }))
		.filter(({ images }) => images.length > 0)
	const key = (image) => image.getAttribute('src')
	// Each tile starts on its first logo not already shown by an earlier tile
	const taken = new Set()
	const shown = tiles.map(({ images }) => {
		const index = Math.max(
			0,
			images.findIndex((image) => !taken.has(key(image))),
		)
		taken.add(key(images[index]))
		images.forEach((image, at) => (image.hidden = at !== index))
		return index
	})
	const held = new Set()
	const cleanups = tiles.map(({ tile }, index) => {
		const hold = () => held.add(index)
		const release = () => held.delete(index)
		tile.addEventListener('pointerenter', hold)
		tile.addEventListener('pointerleave', release)
		tile.addEventListener('focusin', hold)
		tile.addEventListener('focusout', release)
		return () => {
			tile.removeEventListener('pointerenter', hold)
			tile.removeEventListener('pointerleave', release)
			tile.removeEventListener('focusin', hold)
			tile.removeEventListener('focusout', release)
		}
	})

	let last
	let swap = 0
	let stopScramble
	let timer = 0
	let inView = false

	function step() {
		const shownKeys = new Set(tiles.map(({ images }, index) => key(images[shown[index]])))
		const candidates = tiles.flatMap(({ images }, index) => {
			if (index === last || held.has(index)) return []
			for (let offset = 1; offset < images.length; offset++) {
				const next = (shown[index] + offset) % images.length
				if (!shownKeys.has(key(images[next]))) return [[index, next]]
			}
			return []
		})
		if (candidates.length === 0) return
		const [index, next] = candidates[Math.floor(Math.random() * candidates.length)]
		const { images } = tiles[index]
		last = index
		stopScramble?.()
		stopScramble = scrambleImage(images[shown[index]], 'out')
		swap = window.setTimeout(() => {
			stopScramble?.()
			images[shown[index]].hidden = true
			shown[index] = next
			images[next].hidden = false
			stopScramble = scrambleImage(images[next], 'in')
		}, 240)
	}

	function sync() {
		window.clearInterval(timer)
		timer = inView && !reducedMotion() ? window.setInterval(step, interval) : 0
	}
	const observer = new IntersectionObserver(([entry]) => {
		inView = entry.isIntersecting
		sync()
	})
	observer.observe(list)
	const media = window.matchMedia(REDUCED_MOTION_QUERY)
	media.addEventListener('change', sync)

	return () => {
		window.clearInterval(timer)
		window.clearTimeout(swap)
		stopScramble?.()
		observer.disconnect()
		media.removeEventListener('change', sync)
		cleanups.forEach((cleanup) => cleanup())
	}
}

/* ---------- Numbers ---------- */

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

/**
 * A whole number that animates once in view: counts min → max (`up`) or max → min (`down`) over
 * `duration` ms on power2.out and stops, or keeps moving between random numbers in the range
 * (`random`, each step `duration` ms on power2.inOut) while it is on screen.
 *
 *   <span class="bt-number" data-count="up" data-min="0" data-max="1200" data-duration="1500"
 *         data-prefix="$" data-suffix="B"></span>
 */
export function animateNumber(element, options = {}) {
	const data = element.dataset
	const type = options.type ?? data.count ?? 'up'
	const min = Number(options.min ?? data.min ?? 0)
	const max = Number(options.max ?? data.max ?? 100)
	const duration = Number(options.duration ?? data.duration ?? 1500)
	const prefix = options.prefix ?? data.prefix ?? ''
	const suffix = options.suffix ?? data.suffix ?? ''
	// Rounded first, so a count crossing zero never shows "-0"
	const toText = (number) => `${prefix}${numberFormat.format(Math.round(number) || 0)}${suffix}`
	const start = type === 'down' ? max : min
	const end = type === 'up' ? max : min
	const sizer = [toText(min), toText(max)].reduce((a, b) => (b.length > a.length ? b : a))
	element.innerHTML = `<span class="value">${toText(end)}</span><span class="sizer" aria-hidden="true">${sizer}</span><span class="text" aria-hidden="true">${toText(start)}</span>`
	const text = element.querySelector('.text')
	const write = (number) => {
		const content = toText(number)
		if (text.textContent !== content) text.textContent = content
	}

	let tween
	let last = min
	const observer = new IntersectionObserver(([entry]) => {
		tween?.kill()
		tween = undefined
		if (!entry.isIntersecting || reducedMotion()) return
		if (type !== 'random') {
			observer.disconnect()
			const progress = { number: start }
			tween = gsap.to(progress, {
				number: end,
				duration: duration / 1000,
				ease: 'power2.out',
				onUpdate: () => write(progress.number),
			})
			return
		}
		// Each repeat starts from the last number shown and runs to a new random one
		const progress = { number: last }
		tween = gsap.to(progress, {
			number: () => gsap.utils.random(min, max, 1),
			duration: duration / 1000,
			ease: 'power2.inOut',
			repeat: -1,
			repeatRefresh: true,
			onUpdate: () => {
				last = progress.number
				write(progress.number)
			},
		})
	})
	observer.observe(element)
	return () => {
		observer.disconnect()
		tween?.kill()
	}
}

/* ---------- Wire everything from the markup ---------- */

/**
 * Finds every motion hook under `root` and starts it. Returns one function that stops them all.
 * Hooks: `[data-rotate]` on a `.bt-logos` list; `.bt-number[data-count]`; `i.hole` texture holes.
 */
export function initMotion(root = document) {
	const stops = []
	for (const list of root.querySelectorAll('.bt-logos[data-rotate]')) stops.push(rotateLogos(list))
	for (const number of root.querySelectorAll('.bt-number[data-count]')) stops.push(animateNumber(number))
	const holes = root.querySelectorAll('.bt-logos > i.hole, [data-texture-hole]')
	if (holes.length) stops.push(alignTexture(holes))
	return () => stops.forEach((stop) => stop())
}
