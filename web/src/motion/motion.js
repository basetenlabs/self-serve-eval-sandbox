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
import { gsap } from './lib/gsap.js'
import { h, svg } from './dom.js'

// The site sets this once for every tween on the page: a tween without its own ease is linear.
gsap.defaults({ ease: 'none' })

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
export const MOBILE_QUERY = '(max-width: 800.98px)'
export const reducedMotion = () => window.matchMedia(REDUCED_MOTION_QUERY).matches

/** The signature curve: buttons, chevrons, lifting cells, clip-path wipes. 0.4s. */
export const EASE_LIFT = 'cubic-bezier(0.75, 0, 0.1, 0.99)'

/**
 * One controller of a kind per element. `initMotion` skips an element that already has one, and a
 * direct call (`steps(list, …)`) replaces whatever was there, so wiring twice never runs two timers.
 */
const controllers = new WeakMap()
const claimed = (element, kind) => controllers.get(element)?.has(kind) ?? false
function claim(element, kind, stop) {
	let kinds = controllers.get(element)
	if (!kinds) controllers.set(element, (kinds = new Map()))
	kinds.set(kind, stop)
}
/** Forgets the element's controller of that kind (only `owner`, when given); `stop: true` also stops it. */
function release(element, kind, { stop = false, owner } = {}) {
	const kinds = controllers.get(element)
	const current = kinds?.get(kind)
	if (!current || (owner && current !== owner)) return
	kinds.delete(kind)
	if (stop) current()
}

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
 *
 * `corner: true` is for a hole drawn by the target's `:after` at its outer lower right corner
 * (the stepped hero logo tiles): the offset is worked out for that corner and set as
 * `--hole-position` on the target, which the stylesheet reads.
 */
export function alignTexture(targets, textureElement = document.documentElement, { corner = false } = {}) {
	const list = [...targets]
	const align = () => {
		// Backgrounds are painted from box origins snapped to whole CSS pixels: snap both sides
		// the same way, or fractional layout positions leave the dots out of line.
		const origin = textureElement.getBoundingClientRect()
		const originX = Math.round(origin.left + textureElement.clientLeft)
		const originY = Math.round(origin.top + textureElement.clientTop)
		for (const target of list) {
			const box = target.getBoundingClientRect()
			const left = Math.round(corner ? box.right : box.left + target.clientLeft)
			const top = Math.round(corner ? box.bottom : box.top + target.clientTop)
			const position = `${originX - left}px ${originY - top}px`
			if (corner) target.style.setProperty('--hole-position', position)
			else target.style.backgroundPosition = position
		}
	}
	align()
	const observer = new ResizeObserver(align)
	for (const element of new Set([document.documentElement, textureElement, ...list])) {
		observer.observe(element)
	}
	return () => {
		observer.disconnect()
		for (const target of list) {
			if (corner) target.style.removeProperty('--hole-position')
			else target.style.backgroundPosition = ''
		}
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

/**
 * A number that animates once in view: counts min → max (`up`) or max → min (`down`) over
 * `duration` ms on power2.out and stops, or keeps moving between random numbers in the range
 * (`random`, each step `duration` ms on power2.inOut) while it is on screen.
 *
 *   <span class="bt-number" data-count="up" data-min="0" data-max="1200" data-duration="1500"
 *         data-prefix="$" data-suffix="B"></span>
 *   <span class="bt-number" data-count="up" data-max="0.063" data-decimals="3" data-prefix="$"></span>
 *
 * For a number that also changes after it has counted (a live metric), use `liveNumber`.
 *
 * @param {HTMLElement} element
 * @param {object} [options]  Each falls back to the element's data attribute of the same name.
 * @param {'up' | 'down' | 'random'} [options.type]  `data-count`. Default `up`.
 * @param {number} [options.min]       Default 0.
 * @param {number} [options.max]       Default 100.
 * @param {number} [options.decimals]  Digits after the point. Default 0.
 * @param {number} [options.duration]  Milliseconds. Default 1500.
 * @param {string} [options.prefix]
 * @param {string} [options.suffix]
 * @returns {() => void} Stops it.
 */
export function animateNumber(element, options = {}) {
	const data = element.dataset
	const type = options.type ?? data.count ?? 'up'
	const min = Number(options.min ?? data.min ?? 0)
	const max = Number(options.max ?? data.max ?? 100)
	const decimals = Number(options.decimals ?? data.decimals ?? 0)
	const duration = Number(options.duration ?? data.duration ?? 1500)
	const prefix = options.prefix ?? data.prefix ?? ''
	const suffix = options.suffix ?? data.suffix ?? ''
	const toText = numberText({ decimals, prefix, suffix })
	const start = type === 'down' ? max : min
	const end = type === 'up' ? max : min
	const sizer = [toText(min), toText(max)].reduce((a, b) => (b.length > a.length ? b : a))
	const text = h('span', { class: 'text', 'aria-hidden': 'true' }, toText(start))
	element.replaceChildren(
		h('span', { class: 'value' }, toText(end)),
		h('span', { class: 'sizer', 'aria-hidden': 'true' }, sizer),
		text,
	)
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
			number: () => gsap.utils.random(min, max, 10 ** -decimals),
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

/** `(number) => text` with thousands separators, fixed decimals and the prefix and suffix. */
function numberText({ decimals = 0, prefix = '', suffix = '' }) {
	const format = new Intl.NumberFormat('en-US', {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	})
	const scale = 10 ** decimals
	// Rounded first, so a count crossing zero never shows "-0"
	return (number) => `${prefix}${format.format(Math.round(number * scale) / scale || 0)}${suffix}`
}

/* ---------- Tabs and steps ---------- */

let tabsCount = 0

/**
 * Tabs whose panels swap in place. Tabs are `[role="tab"]` inside `tablist`; `panels` are in the
 * same order and hidden with the `hidden` attribute (give them `.bt-reveal` to fade in, 0.3s), or,
 * for a `.bt-fade-stack`, stacked and cross-faded by the `active` class.
 * Each panel gets `role="tabpanel"` and is tied to its tab (`aria-controls`, `aria-labelledby`);
 * a tab or panel without an id is given one. Roles and ids already in the markup are kept.
 */
export function tabs(tablist, panels, { onChange, initialIndex = 0 } = {}) {
	const items = [...tablist.querySelectorAll('[role="tab"]')]
	const list = [...panels]
	tabsCount += 1
	items.forEach((tab, at) => {
		const panel = list[at]
		if (!panel) return
		tab.id ||= `bt-tabs-${tabsCount}-tab-${at}`
		panel.id ||= `bt-tabs-${tabsCount}-panel-${at}`
		if (!panel.hasAttribute('role')) panel.setAttribute('role', 'tabpanel')
		if (!tab.hasAttribute('aria-controls')) tab.setAttribute('aria-controls', panel.id)
		if (!panel.hasAttribute('aria-labelledby')) panel.setAttribute('aria-labelledby', tab.id)
	})
	let active = -1
	function select(index) {
		if (index === active) return
		active = index
		items.forEach((tab, at) => {
			tab.setAttribute('aria-selected', String(at === index))
			tab.classList.toggle('active', at === index)
			tab.tabIndex = at === index ? 0 : -1
		})
		list.forEach((panel, at) => {
			if (panel.parentElement?.classList.contains('bt-fade-stack')) {
				panel.classList.toggle('active', at === index)
				panel.inert = at !== index
			} else panel.hidden = at !== index
		})
		onChange?.(index)
	}
	const onClick = (event) => {
		const index = items.indexOf(event.target.closest('[role="tab"]'))
		if (index >= 0) select(index)
	}
	tablist.addEventListener('click', onClick)
	const removeKeyboard = tabListKeyboard(tablist, { onChange: select })
	select(initialIndex)
	return {
		select,
		dispose() {
			tablist.removeEventListener('click', onClick)
			removeKeyboard()
		},
	}
}

/** The 5 x 10px triangle a button with a chevron carries (`.bt-button.has-chevron .chevron`). */
export const CHEVRON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="5" height="10" viewBox="0 0 5 10" fill="none"><path d="M5 5L0 0V10L5 5Z" fill="currentColor"/></svg>'

/**
 * Shows that a scrolling tab bar has more tabs. `wrap` is a `.bt-tabbar-scroll` around a
 * `.bt-tabbar`: at each end that hides tabs it gets a 36px White fade with a chevron (`.more`,
 * `.more.back`), which scrolls the bar to that end; the fade goes when nothing is hidden there.
 * The cue is for the pointer only (hidden from assistive technology, not in the tab order):
 * arrow keys already reach every tab. Returns a function that removes it.
 */
export function scrollCue(wrap) {
	release(wrap, '.bt-tabbar-scroll', { stop: true })
	const bar = wrap.querySelector('.bt-tabbar')
	if (!bar) return () => {}
	const make = (way) => {
		const button = h(
			'button',
			{ type: 'button', class: way < 0 ? 'more back' : 'more', tabindex: -1, 'aria-hidden': 'true', hidden: true },
			svg(CHEVRON_SVG),
		)
		button.addEventListener('click', () =>
			bar.scrollTo({ left: way > 0 ? bar.scrollWidth : 0, behavior: reducedMotion() ? 'auto' : 'smooth' }),
		)
		return button
	}
	const back = make(-1)
	const more = make(1)
	wrap.append(back, more)
	const update = () => {
		back.hidden = bar.scrollLeft <= 1
		more.hidden = bar.scrollLeft + bar.clientWidth >= bar.scrollWidth - 1
	}
	bar.addEventListener('scroll', update, { passive: true })
	const sizes = new ResizeObserver(update)
	sizes.observe(bar)
	for (const tab of bar.children) sizes.observe(tab)
	update()
	const stop = () => {
		release(wrap, '.bt-tabbar-scroll', { owner: stop })
		bar.removeEventListener('scroll', update)
		sizes.disconnect()
		back.remove()
		more.remove()
	}
	claim(wrap, '.bt-tabbar-scroll', stop)
	return stop
}

const PLAY_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="M3 1.5L10.5 6L3 10.5V1.5Z" fill="currentColor"/></svg>'
const PAUSE_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 1.5H5V10.5H2.5V1.5Z" fill="currentColor"/><path d="M7 1.5H9.5V10.5H7V1.5Z" fill="currentColor"/></svg>'

/**
 * Auto-advancing step list (`.bt-steps`), as in the site's feature sections. Desktop: every
 * `seconds` (5) the next row opens; the 2px line under the active row shows the time left; the
 * countdown holds while the pointer or keyboard focus is on the active row or on `frame` (the
 * artwork beside the list), while the list is off screen, and after the pause button is pressed.
 * Under reduced motion it starts paused and the button lets the reader opt in. Phones: no timer;
 * the row nearest the middle of the screen is the active one.
 *
 * `stack`: a `.bt-fade-stack` whose children follow the steps (artwork, cards).
 */
export function steps(list, { seconds = 5, frame, stack, onChange } = {}) {
	release(list, '.bt-steps', { stop: true })
	const rows = [...list.children]
	const slides = stack ? [...stack.children] : []
	const desktop = window.matchMedia('(min-width: 801px)')
	const timer = createAutoplayTimer({
		count: rows.length,
		duration: seconds * 1000,
		pauses: ['viewport'],
	})
	let mobileIndex = 0
	let hovered = -1
	let focused = -1
	let frameHeld = false
	let stopTimer

	const control = Object.assign(document.createElement('button'), {
		type: 'button',
		className: 'bt-icon-button control',
	})
	control.addEventListener('click', () => {
		pausedForPreference = false // the pause is the reader's own from here
		timer.toggle('manual')
	})

	const activeIndex = () => (desktop.matches ? timer.get().activeIndex : mobileIndex)
	function render() {
		const active = activeIndex()
		rows.forEach((row, index) => {
			row.classList.toggle('active', index === active)
			row.querySelector('.title')?.setAttribute('aria-expanded', String(index === active))
			const details = row.querySelector('.details')
			if (details) details.inert = index !== active
			const bar = row.querySelector('.timer')
			if (bar)
				bar.style.transform =
					index === active && desktop.matches ? `scaleX(${timer.getProgress().toFixed(4)})` : ''
		})
		slides.forEach((slide, index) => slide.classList.toggle('active', index === active))
		// The button and its icon are touched only when they change: a render between a press and its release
		// (focus arriving holds the timer) that moved or redrew what was pressed would lose the click.
		if (!(seconds > 0 && desktop.matches)) control.remove()
		else if (rows[active] && control.parentNode !== rows[active]) rows[active].append(control)
		const paused = timer.isPausedBy('manual')
		if (control.dataset.paused !== String(paused)) {
			control.dataset.paused = String(paused)
			control.replaceChildren(svg(paused ? PLAY_ICON : PAUSE_ICON))
			control.setAttribute('aria-label', paused ? 'Resume autoplay' : 'Pause autoplay')
		}
		// Hold while attention is on what is showing
		if (hovered === active || focused === active || frameHeld) timer.pause('hover')
		else timer.resume('hover')
		onChange?.(active)
	}
	const unsubscribe = timer.subscribe(render)
	const offProgress = timer.onProgress((progress) => {
		const bar = rows[timer.get().activeIndex]?.querySelector('.timer')
		if (bar && desktop.matches) bar.style.transform = `scaleX(${progress.toFixed(4)})`
	})

	const rowOf = (target) =>
		rows.indexOf(target instanceof Element ? target.closest('.bt-steps > li') : null)
	const onClick = (event) => {
		if (!event.target.closest('.title')) return
		const index = rowOf(event.target)
		if (index < 0) return
		if (desktop.matches) timer.select(index)
		else {
			mobileIndex = index
			render()
			rows[index].scrollIntoView({ behavior: 'smooth', block: 'center' })
		}
	}
	const onOver = (event) => {
		if (event.pointerType === 'touch') return
		hovered = rowOf(event.target)
		render()
	}
	const onLeave = () => {
		hovered = -1
		render()
	}
	const onFocus = (event) => {
		focused = event.target.matches?.(':focus-visible') ? rowOf(event.target) : -1
		render()
	}
	const onBlur = () => {
		focused = -1
		render()
	}
	list.addEventListener('click', onClick)
	list.addEventListener('pointerover', onOver)
	list.addEventListener('pointerleave', onLeave)
	list.addEventListener('focusin', onFocus)
	list.addEventListener('focusout', onBlur)
	const holdFrame = (held) => (event) => {
		if (event.pointerType === 'touch') return
		frameHeld = held
		render()
	}
	const frameEnter = holdFrame(true)
	const frameLeave = holdFrame(false)
	frame?.addEventListener('pointerenter', frameEnter)
	frame?.addEventListener('pointerleave', frameLeave)

	const viewport = new IntersectionObserver(([entry]) => {
		if (entry.isIntersecting) timer.resume('viewport')
		else timer.pause('viewport')
	})
	viewport.observe(list)
	// Phones: the row nearest the middle band of the screen is active
	const inBand = new Set()
	const band = new IntersectionObserver(
		(entries) => {
			if (desktop.matches) return
			for (const entry of entries) {
				if (entry.isIntersecting) inBand.add(entry.target)
				else inBand.delete(entry.target)
			}
			const first = rows
				.filter((row) => inBand.has(row))
				.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]
			if (first) {
				mobileIndex = rows.indexOf(first)
				render()
			}
		},
		{ rootMargin: '-40% 0px -40% 0px', threshold: 0 },
	)
	rows.forEach((row) => band.observe(row))

	const sync = () => {
		stopTimer?.()
		stopTimer = desktop.matches && seconds > 0 ? startTimer(timer) : undefined
		render()
	}
	desktop.addEventListener('change', sync)
	// Reduced motion pauses autoplay as the reader's own pause would (the button opts back in). The preference
	// can change while the page is open: turned on it pauses; turned off it resumes only the pause it caused.
	const motionPreference = window.matchMedia(REDUCED_MOTION_QUERY)
	let pausedForPreference = false
	const onMotionPreference = () => {
		if (motionPreference.matches) {
			pausedForPreference = !timer.isPausedBy('manual')
			timer.pause('manual')
		} else if (pausedForPreference) {
			pausedForPreference = false
			timer.resume('manual')
		}
	}
	motionPreference.addEventListener('change', onMotionPreference)
	onMotionPreference()
	sync()

	const controller = {
		timer,
		dispose() {
			release(list, '.bt-steps', { owner: controller.dispose })
			stopTimer?.()
			unsubscribe()
			offProgress()
			viewport.disconnect()
			band.disconnect()
			desktop.removeEventListener('change', sync)
			motionPreference.removeEventListener('change', onMotionPreference)
			list.removeEventListener('click', onClick)
			list.removeEventListener('pointerover', onOver)
			list.removeEventListener('pointerleave', onLeave)
			list.removeEventListener('focusin', onFocus)
			list.removeEventListener('focusout', onBlur)
			frame?.removeEventListener('pointerenter', frameEnter)
			frame?.removeEventListener('pointerleave', frameLeave)
			control.remove()
		},
	}
	claim(list, '.bt-steps', controller.dispose)
	return controller
}

/* ---------- Accordion ---------- */

const ACCORDION_CONTROLS = 'a, button, input, select, textarea, label, summary'

/**
 * `.bt-accordion`: the whole row toggles; the button stays the keyboard control. The answer opens
 * from height 0 and opacity 0 to its own height in 0.4s power2.out, and closes the same way.
 * `single` closes the open row when another opens.
 */
export function accordion(root, { single = false } = {}) {
	const items = [...root.querySelectorAll(':scope > .item')]
	function set(item, open) {
		const button = item.querySelector('button[aria-expanded]')
		const answer = item.querySelector('.answer')
		if (item.classList.contains('open') === open) return
		item.classList.toggle('open', open)
		button.setAttribute('aria-expanded', String(open))
		answer.inert = !open
		const height = answer.firstElementChild.offsetHeight
		if (reducedMotion()) {
			gsap.set(answer, { height: open ? 'auto' : 0, opacity: open ? 1 : 0 })
			return
		}
		if (open) {
			gsap.fromTo(
				answer,
				{ height: 0, opacity: 0 },
				{
					height,
					opacity: 1,
					duration: 0.4,
					ease: 'power2.out',
					overwrite: 'auto',
					onComplete: () => gsap.set(answer, { height: 'auto' }),
				},
			)
		} else {
			gsap.fromTo(
				answer,
				{ height, opacity: 1 },
				{ height: 0, opacity: 0, duration: 0.4, ease: 'power2.out', overwrite: 'auto' },
			)
		}
	}
	function onClick(event) {
		const item = event.target.closest('.bt-accordion > .item')
		if (!item || item.parentElement !== root) return
		const button = item.querySelector('button[aria-expanded]')
		if (!button.contains(event.target)) {
			// Links and controls in the answer keep their own click; selecting its text does not close it
			const control = event.target.closest(ACCORDION_CONTROLS)
			if (control && item.contains(control)) return
			const selection = window.getSelection()
			if (selection && !selection.isCollapsed) return
		}
		const open = !item.classList.contains('open')
		if (open && single) items.forEach((other) => other !== item && set(other, false))
		set(item, open)
	}
	items.forEach((item) => {
		const open = item.classList.contains('open')
		item.querySelector('button[aria-expanded]').setAttribute('aria-expanded', String(open))
		item.querySelector('.answer').inert = !open
	})
	root.addEventListener('click', onClick)
	return () => root.removeEventListener('click', onClick)
}

/* ---------- Header ---------- */

/** Upward scroll distance before the bar slides back in, so jitter does not reveal it. */
const REVEAL_TOLERANCE = 6

/**
 * The header on scroll. Until its place in the page leaves the screen it sits there; past it, on
 * screens from 1025px, it is fixed and travels up with the page (`--nav-offset`), and an upward
 * scroll of 6px slides it back in (`data-state="revealing"`, 0.5s). Narrower screens keep it fixed
 * at the top. Also keeps `--nav-height` at the bar's measured height.
 */
export function stickyHeader(header) {
	const large = window.matchMedia('(min-width: 1025px)')
	let current = 'static'
	let offset = 0
	let lastY = window.scrollY
	let upDistance = 0
	let frame = 0
	// Where the bar sits in the page: measured while it is still in its place
	let flowTop = header.getBoundingClientRect().top + window.scrollY

	const apply = (next, nextOffset = 0) => {
		offset = nextOffset
		header.style.setProperty('--nav-offset', `${offset}px`)
		if (next === current) return
		current = next
		if (next === 'static') delete header.dataset.state
		else header.dataset.state = next
	}
	const update = () => {
		frame = 0
		const top = flowTop - window.scrollY
		const height = header.offsetHeight
		const y = window.scrollY
		const delta = y - lastY
		lastY = y
		if (top >= 0) return apply('static')
		if (!large.matches) return apply('fixed')
		if (current === 'static') {
			// Still partly in its place: let it scroll away naturally
			if (top > -height) return
			apply('fixed', -height)
		}
		if (delta > 0) {
			upDistance = 0
			// Stop a reveal where it is and carry on scrolling the bar away from there
			const from =
				current === 'revealing'
					? new DOMMatrixReadOnly(getComputedStyle(header).transform).m42
					: offset
			apply('fixed', Math.max(from - delta, -height))
		} else if (delta < 0 && current !== 'revealing' && offset < 0) {
			upDistance -= delta
			if (upDistance >= REVEAL_TOLERANCE) apply('revealing')
		}
	}
	const schedule = () => {
		if (!frame) frame = requestAnimationFrame(update)
	}
	const syncHeight = () => {
		document.documentElement.style.setProperty(
			'--nav-height',
			`${header.getBoundingClientRect().height}px`,
		)
	}
	const sizes = new ResizeObserver(syncHeight)
	sizes.observe(header)
	syncHeight()
	update()
	window.addEventListener('scroll', schedule, { passive: true })
	large.addEventListener('change', schedule)
	return () => {
		cancelAnimationFrame(frame)
		sizes.disconnect()
		window.removeEventListener('scroll', schedule)
		large.removeEventListener('change', schedule)
		delete header.dataset.state
		header.style.removeProperty('--nav-offset')
	}
}

// Hover intent: a pointer passing over a trigger does not open its menu
const OPEN_DELAY = 120
const SWITCH_DELAY = 200
const CLOSE_DELAY = 200
/** A click right after hover opened the menu should not close it again. */
const CLICK_AFTER_HOVER = 400

/**
 * Header menus. A trigger is a `button[aria-controls]` in `.bt-nav .links` whose panel
 * (`.bt-nav-panel`) sits in the same `<li data-menu>`; `.bt-nav-overlay` dims the page.
 * Resting the mouse on a trigger opens its menu (120ms), or switches to it from another (200ms,
 * swapped without a fade); leaving for anything else in the header closes it (200ms). Click and
 * Enter toggle; Escape closes and returns focus; the page does not scroll while a menu is open.
 * Also wires the menu button and `.bt-mobile-menu` (rows with `aria-controls` open their `.sub`).
 */
export function navMenus(header) {
	const triggers = [...header.querySelectorAll('.bt-nav .links button[aria-controls]')]
	const overlay = header.querySelector('.bt-nav-overlay')
	const panelOf = (trigger) => document.getElementById(trigger.getAttribute('aria-controls'))
	let openTrigger = null
	let openedAt = 0
	let openTimer = 0
	let closeTimer = 0
	const clearTimers = () => {
		clearTimeout(openTimer)
		clearTimeout(closeTimer)
	}
	function render(switched = false) {
		header.classList.toggle('switched', switched)
		for (const trigger of triggers) {
			const open = trigger === openTrigger
			trigger.setAttribute('aria-expanded', String(open))
			const panel = panelOf(trigger)
			panel?.classList.toggle('open', open)
			if (panel) panel.inert = !open
		}
		overlay?.classList.toggle('open', !!openTrigger)
		document.documentElement.style.overflow = openTrigger || mobileOpen ? 'hidden' : ''
	}
	function open(trigger, time) {
		clearTimers()
		if (trigger === openTrigger) return
		const switched = !!openTrigger
		openTrigger = trigger
		openedAt = time
		render(switched)
	}
	function close() {
		clearTimers()
		if (!openTrigger) return
		openTrigger = null
		render()
	}
	const isMouse = (event) => event.pointerType === 'mouse'
	const cleanups = []
	const on = (target, type, handler, options) => {
		if (!target) return
		target.addEventListener(type, handler, options)
		cleanups.push(() => target.removeEventListener(type, handler, options))
	}
	for (const trigger of triggers) {
		on(trigger, 'pointerenter', (event) => {
			if (!isMouse(event)) return
			clearTimers()
			if (trigger === openTrigger) return
			const delay = openTrigger ? SWITCH_DELAY : OPEN_DELAY
			openTimer = setTimeout(() => open(trigger, event.timeStamp + delay), delay)
		})
		on(trigger, 'click', (event) => {
			if (trigger !== openTrigger) return open(trigger, event.timeStamp)
			if (event.timeStamp - openedAt > CLICK_AFTER_HOVER) close()
		})
		// Staying inside the open panel keeps it open
		on(panelOf(trigger), 'pointerenter', (event) => isMouse(event) && clearTimers())
	}
	const scheduleClose = (event) => {
		if (!isMouse(event)) return
		clearTimers()
		closeTimer = setTimeout(close, CLOSE_DELAY)
	}
	on(header, 'pointerover', (event) => {
		if (!event.target.closest('[data-menu]')) scheduleClose(event)
	})
	on(header, 'pointerleave', scheduleClose)
	on(overlay, 'click', close)
	on(document, 'keydown', (event) => {
		if (event.key !== 'Escape') return
		if (openTrigger) {
			const trigger = openTrigger
			close()
			trigger.focus()
		} else if (mobileOpen) toggleMobile(false)
	})

	// Mobile sheet
	const menuButton = header.querySelector('.bt-nav .menu')
	const sheet = header.querySelector('.bt-mobile-menu')
	let mobileOpen = false
	function toggleMobile(next = !mobileOpen) {
		mobileOpen = next
		menuButton?.setAttribute('aria-expanded', String(next))
		// The name follows the state, as on the site, when the page uses those names
		if (/^(Open|Close) menu$/.test(menuButton?.getAttribute('aria-label') ?? ''))
			menuButton.setAttribute('aria-label', next ? 'Close menu' : 'Open menu')
		if (sheet) {
			sheet.style.setProperty('--menu-top', `${header.getBoundingClientRect().bottom}px`)
			sheet.classList.toggle('open', next)
			sheet.inert = !next
		}
		render()
	}
	on(menuButton, 'click', () => toggleMobile())
	if (sheet) {
		sheet.inert = true
		on(sheet, 'click', (event) => {
			const row = event.target.closest('.row[aria-controls]')
			if (!row) return
			const expanded = row.getAttribute('aria-expanded') !== 'true'
			row.setAttribute('aria-expanded', String(expanded))
			const sub = document.getElementById(row.getAttribute('aria-controls'))
			sub?.classList.toggle('expanded', expanded)
			if (sub) sub.inert = !expanded
		})
	}
	const large = window.matchMedia('(min-width: 1025px)')
	const onLayout = () => (large.matches ? mobileOpen && toggleMobile(false) : close())
	large.addEventListener('change', onLayout)
	render()

	return () => {
		clearTimers()
		large.removeEventListener('change', onLayout)
		cleanups.forEach((cleanup) => cleanup())
		document.documentElement.style.overflow = ''
	}
}

/* ---------- Page ---------- */

/**
 * Smooth scrolling as on the site: Lenis with lerp 0.18 (off on screens up to 800px, where the
 * native scroll is kept), driven from one frame loop. Off under reduced motion. Anchor links
 * scroll in 0.5s. Returns the Lenis instance (null when not started) and a stop function.
 *
 *   import Lenis from 'lenis'
 *   const { lenis } = smoothScroll(Lenis)
 */
export function smoothScroll(Lenis, options = {}) {
	if (reducedMotion()) return { lenis: null, stop() {} }
	const lenis = new Lenis({ lerp: window.innerWidth <= 800 ? 1 : 0.18, autoRaf: false, ...options })
	let frame = requestAnimationFrame(function loop(time) {
		lenis.raf(time)
		frame = requestAnimationFrame(loop)
	})
	const onClick = (event) => {
		const link = event.target.closest?.('a[href^="#"]')
		const hash = link?.getAttribute('href')
		if (!hash || hash.length < 2 || event.defaultPrevented) return
		const target = document.getElementById(decodeURIComponent(hash.slice(1)))
		if (!target) return
		event.preventDefault()
		history.replaceState(null, '', hash)
		lenis.scrollTo(target, { duration: 0.5 })
	}
	document.addEventListener('click', onClick)
	return {
		lenis,
		stop() {
			cancelAnimationFrame(frame)
			document.removeEventListener('click', onClick)
			lenis.destroy()
		},
	}
}

/**
 * Page changes on a multi-page site: a White sheet fades in over the page (0.4s power2.out) before
 * the browser follows a same-site link, and fades out on arrival (0.4s, after 0.2s).
 * Modified clicks, new-tab links, anchors and downloads are left to the browser.
 */
export function pageTransitions() {
	if (reducedMotion()) return () => {}
	const sheet = Object.assign(document.createElement('div'), { className: 'bt-page-transition' })
	document.body.append(sheet)
	const arrive = () =>
		gsap.fromTo(
			sheet,
			{ opacity: 1 },
			{ opacity: 0, duration: 0.4, ease: 'power2.out', delay: 0.2 },
		)
	if (sessionStorage.getItem('bt-page-transition')) {
		sessionStorage.removeItem('bt-page-transition')
		arrive()
	}
	const onClick = (event) => {
		if (
			event.defaultPrevented ||
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey ||
			event.button !== 0
		)
			return
		const link = event.target.closest?.('a[href]')
		// HTML links only: an SVG <a> has an object for href, which would resolve to a wrong address
		if (!(link instanceof HTMLAnchorElement) || link.target === '_blank' || link.hasAttribute('download')) return
		const url = new URL(link.href, location.href)
		if (
			url.origin !== location.origin ||
			(url.pathname === location.pathname && url.search === location.search)
		)
			return
		event.preventDefault()
		sessionStorage.setItem('bt-page-transition', '1')
		gsap
			.fromTo(sheet, { opacity: 0 }, { opacity: 1, duration: 0.4, ease: 'power2.out' })
			.then(() => {
				location.href = url.href
			})
	}
	document.addEventListener('click', onClick)
	// A page restored from the back-forward cache must not stay covered
	const onShow = (event) => event.persisted && gsap.set(sheet, { opacity: 0 })
	window.addEventListener('pageshow', onShow)
	return () => {
		document.removeEventListener('click', onClick)
		window.removeEventListener('pageshow', onShow)
		sheet.remove()
	}
}

/* ---------- Text ---------- */

/** Share of the reveal each letter takes to fade in. */
const LETTER_FADE = 0.05
/** Below this much scroll there is not enough to drive the reveal, so it plays on its own. */
const MIN_SCROLL = 120
/** The reveal never runs faster than this (ms, nothing to fully revealed). */
const MIN_DURATION = 1200

/**
 * Headline that fills in letter by letter as it travels up the screen (`.bt-reveal-text`): it
 * starts when the text's top reaches 85% of the viewport height and ends when its bottom reaches
 * 35%. It only moves forward, never faster than 1.2s for the whole text, and plays by itself when
 * the page has too little scroll left to drive it. Screen readers get the plain text.
 */
export function revealText(element, { from = 0.3, start = 0.85, end = 0.35 } = {}) {
	const text = element.textContent.trim()
	const words = text.split(/\s+/)
	const letterCount = words.reduce((count, word) => count + word.length, 0)
	let letterIndex = 0
	const original = [...element.childNodes]
	element.classList.add('bt-reveal-text')
	element.style.setProperty('--from', from)
	element.style.setProperty('--fade', LETTER_FADE)
	const visual = h('span', { 'aria-hidden': 'true' })
	words.forEach((word, index) => {
		if (index) visual.append(' ')
		visual.append(
			h(
				'span',
				{ class: 'word' },
				[...word].map((letter) =>
					h(
						'span',
						{
							class: 'letter',
							style: `--threshold:${(letterIndex++ / letterCount) * (1 - LETTER_FADE)}`,
						},
						letter,
					),
				),
			),
		)
	})
	element.replaceChildren(h('span', { class: 'bt-sr-only' }, text), visual)

	let frame = 0
	let animationFrame = 0
	let lastTime = 0
	let target = 0
	let percent = 0
	const clamp = (value) => Math.min(Math.max(value, 0), 1)
	const animate = (now) => {
		const delta = lastTime ? now - lastTime : 16
		lastTime = now
		percent = Math.min(target, percent + delta / MIN_DURATION)
		element.style.setProperty('--scroll-percent', String(percent))
		if (percent < target) {
			animationFrame = requestAnimationFrame(animate)
			return
		}
		animationFrame = 0
		lastTime = 0
		if (percent === 1) stopListening()
	}
	const setTarget = (next) => {
		if (next <= target) return
		target = next
		if (!animationFrame) animationFrame = requestAnimationFrame(animate)
	}
	const update = () => {
		frame = 0
		const { top, height } = element.getBoundingClientRect()
		const revealStart = window.innerHeight * start
		const revealEnd = window.innerHeight * end
		// Near the bottom of the page the text may never reach the end line: squeeze the reveal so
		// it finishes exactly as the page runs out
		const scrollLeft = document.documentElement.scrollHeight - window.innerHeight - window.scrollY
		const reachable = revealStart - (top - scrollLeft)
		const distance = Math.min(height + revealStart - revealEnd, reachable)
		if (distance < MIN_SCROLL) {
			if (top < window.innerHeight) setTarget(1)
			return
		}
		setTarget(clamp((revealStart - top) / distance))
	}
	const requestUpdate = () => {
		if (!frame) frame = requestAnimationFrame(update)
	}
	const sizes = new ResizeObserver(requestUpdate)
	function stopListening() {
		window.removeEventListener('scroll', requestUpdate)
		window.removeEventListener('resize', requestUpdate)
		sizes.disconnect()
		cancelAnimationFrame(frame)
		cancelAnimationFrame(animationFrame)
	}
	window.addEventListener('scroll', requestUpdate, { passive: true })
	window.addEventListener('resize', requestUpdate)
	sizes.observe(element)
	update()
	return () => {
		stopListening()
		element.replaceChildren(...original)
	}
}

const GLYPHS = '0123456789#$%&*+/<>?'

/**
 * A value that scrambles in once on screen (`.bt-odometer`): characters appear left to right 0.04s
 * apart, each flickering through random digits and symbols every 0.05s; from 0.6s they lock into
 * the real characters, 0.1s apart. Reduced motion shows the value.
 */
export function odometer(element, value = element.textContent.trim()) {
	const chars = [...value]
	element.classList.add('bt-odometer', 'idle')
	element.replaceChildren(
		h('span', { class: 'bt-sr-only' }, value),
		...chars.map((char) =>
			h(
				'span',
				{ class: 'char', 'aria-hidden': 'true' },
				h('span', { class: 'sizer' }, char),
				h('span', { class: 'glyph' }, char),
			),
		),
	)
	const glyphs = [...element.querySelectorAll('.glyph')]
	const write = (index, text) => {
		if (glyphs[index].textContent !== text) glyphs[index].textContent = text
	}
	const settle = () => chars.forEach((char, index) => write(index, char))
	let tween
	const observer = new IntersectionObserver(([entry]) => {
		if (!entry.isIntersecting) return
		observer.disconnect()
		element.classList.remove('idle')
		if (reducedMotion()) return settle()
		chars.forEach((_, index) => write(index, ''))
		const swaps = chars.map(() => -1)
		const progress = { time: 0 }
		const duration = 0.6 + (chars.length - 1) * 0.1
		tween = gsap.to(progress, {
			time: duration,
			duration,
			onUpdate() {
				const swap = Math.floor(progress.time / 0.05)
				chars.forEach((char, index) => {
					if (progress.time < index * 0.04) write(index, '')
					else if (/\s/.test(char) || progress.time >= 0.6 + index * 0.1) write(index, char)
					else if (swaps[index] !== swap) {
						swaps[index] = swap
						write(index, GLYPHS[Math.floor(Math.random() * GLYPHS.length)])
					}
				})
			},
			onComplete: settle,
		})
	})
	observer.observe(element)
	return () => {
		observer.disconnect()
		tween?.kill()
		settle()
	}
}

// Two full cycles so every digit visibly rolls, even when the target is 0
const STRIP = Array.from({ length: 20 }, (_, index) => index % 10)

/**
 * A value that changes while it is shown (a calculator total, a live metric): `set(value)` rolls
 * each digit's strip to its number in 0.55s power3.out. Digits are matched from the right, so
 * "980" → "1,024" rolls the three it had and brings the new one up from 0. Characters that are
 * not digits (a currency sign, a unit, a space) are swapped in place. Reduced motion sets the
 * value with no roll.
 *
 * @param {HTMLElement} element
 * @param {string | number} [initial]  Default: the element's text.
 * @returns {{ set(value: string | number, options?: { immediate?: boolean }): void }}
 */
export function rollingNumber(element, initial = element.textContent.trim()) {
	element.classList.add('bt-odometer')
	const label = h('span', { class: 'bt-sr-only' })
	const position = (digit) => (-(10 + Number(digit)) / STRIP.length) * 100
	const shape = (value) => value.replace(/\d/g, '0')
	let shown = ''
	/** Each digit's strip and the digit it shows, left to right. */
	let digits = []
	function build(value) {
		// Where each digit was, counted from the right, so a longer or shorter value still rolls
		const before = digits.map(({ digit }) => digit).reverse()
		digits = []
		const cells = [...value].map((char) => {
			if (!/\d/.test(char)) return h('span', { class: 'char', 'aria-hidden': 'true' }, char)
			const strip = h(
				'span',
				{ class: 'strip' },
				STRIP.map((digit) => h('span', {}, String(digit))),
			)
			digits.push({ strip, digit: '0' })
			return h(
				'span',
				{ class: 'digit', 'aria-hidden': 'true' },
				h('span', { class: 'sizer' }, char),
				strip,
			)
		})
		digits.forEach((entry, index) => {
			entry.digit = before[digits.length - 1 - index] ?? '0'
			gsap.set(entry.strip, { yPercent: position(entry.digit) })
		})
		element.replaceChildren(label, ...cells)
	}
	function set(value, { immediate = false } = {}) {
		value = String(value)
		const first = !shown
		if (first || shape(value) !== shape(shown)) build(value)
		else {
			// Same layout: only the characters that are not digits may have changed
			const cells = [...element.children].slice(1)
			;[...value].forEach((char, index) => {
				if (!/\d/.test(char) && cells[index].textContent !== char) cells[index].textContent = char
			})
		}
		label.textContent = value
		const targets = [...value].filter((char) => /\d/.test(char))
		digits.forEach((entry, index) => {
			entry.digit = targets[index]
			const yPercent = position(entry.digit)
			if (first || immediate || reducedMotion()) {
				gsap.killTweensOf(entry.strip)
				gsap.set(entry.strip, { yPercent })
			} else gsap.to(entry.strip, { yPercent, duration: 0.55, ease: 'power3.out', overwrite: true })
		})
		shown = value
	}
	set(initial)
	return { set }
}

/**
 * A metric that counts up once when it comes on screen, then rolls to each new value: the two
 * number motions in one, for values that update while the page is open.
 *
 *   const latency = liveNumber(element, { value: 98.5, decimals: 1, suffix: ' ms' })
 *   latency.set(101.2)     // rolls, 0.55s power3.out
 *
 * Before it has been on screen `set` only stores the value. Reduced motion shows the value and
 * changes it with no motion.
 *
 * @param {HTMLElement} element
 * @param {object} [options]  Each falls back to the element's data attribute of the same name.
 * @param {number} [options.value]     Default: the number in the element's text.
 * @param {number} [options.from]      Where the first count starts. Default 0.
 * @param {number} [options.decimals]  Digits after the point. Default 0.
 * @param {string} [options.prefix]
 * @param {string} [options.suffix]
 * @param {number} [options.duration]  First count, in milliseconds (power2.out). Default 1500.
 * @returns {{ set(value: number): void, dispose(): void }}
 */
export function liveNumber(element, options = {}) {
	const data = element.dataset
	const toText = numberText({
		decimals: Number(options.decimals ?? data.decimals ?? 0),
		prefix: options.prefix ?? data.prefix ?? '',
		suffix: options.suffix ?? data.suffix ?? '',
	})
	const from = Number(options.from ?? data.from ?? 0)
	const duration = Number(options.duration ?? data.duration ?? 1500)
	let value = Number(options.value ?? data.value ?? element.textContent.replace(/[^0-9.-]/g, ''))
	// `.bt-number` stacks its children in one cell for animateNumber; the digits here sit in a row
	element.classList.remove('bt-number')
	const roller = rollingNumber(element, toText(reducedMotion() ? value : from))
	let counted = false
	let tween
	const observer = new IntersectionObserver(([entry]) => {
		if (!entry.isIntersecting) return
		observer.disconnect()
		counted = true
		if (reducedMotion()) return roller.set(toText(value), { immediate: true })
		const progress = { number: from }
		tween = gsap.to(progress, {
			number: value,
			duration: duration / 1000,
			ease: 'power2.out',
			onUpdate: () => roller.set(toText(progress.number), { immediate: true }),
			onComplete: () => {
				tween = undefined
				roller.set(toText(value), { immediate: true })
			},
		})
	})
	observer.observe(element)
	return {
		set(next) {
			value = Number(next)
			if (!counted) {
				if (reducedMotion()) roller.set(toText(value), { immediate: true })
				return
			}
			tween?.kill()
			tween = undefined
			roller.set(toText(value))
		},
		dispose() {
			observer.disconnect()
			tween?.kill()
		},
	}
}

/**
 * `.bt-marquee`: its content repeated in a row that drifts left (`speed` px per ms, 0.02), faster
 * while the page scrolls (pass the Lenis instance), and can be dragged and thrown. Runs only on
 * screen; still under reduced motion.
 */
export function marquee(
	container,
	{ speed = 0.02, repeat = 3, reverse = false, lenis, draggable = true } = {},
) {
	const content = [...container.childNodes]
	const track = Object.assign(document.createElement('div'), { className: 'track' })
	const items = Array.from({ length: repeat }, (_, index) => {
		const item = document.createElement('div')
		item.append(...content.map((node) => (index ? node.cloneNode(true) : node)))
		if (index) item.setAttribute('aria-hidden', 'true')
		return item
	})
	track.append(...items)
	container.append(track)

	let position = 0
	let velocity = 0
	let dragging = false
	let lastX = 0
	let inView = false
	let previous
	let frame = 0
	const observer = new IntersectionObserver(([entry]) => (inView = entry.isIntersecting))
	observer.observe(container)
	const loop = (time) => {
		const delta = time - (previous ?? time)
		previous = time
		frame = requestAnimationFrame(loop)
		if (!inView || reducedMotion()) return
		if (Math.abs(velocity) > 0.001) {
			position += velocity * delta * 10
			velocity *= 0.93 // inertia
		} else {
			velocity = 0
			let step = speed
			if (window.innerWidth > 800) step *= 1 + Math.abs((lenis?.velocity || 0) * 0.1)
			position += delta * step * (reverse ? -1 : 1)
		}
		const width = items[0].offsetWidth || 1
		track.style.transform = `translate3d(${-(((position % width) + width) % width)}px, 0, 0)`
	}
	frame = requestAnimationFrame(loop)
	const onDown = (event) => {
		if (!draggable) return
		dragging = true
		lastX = event.clientX
		velocity = 0
	}
	const onMove = (event) => {
		if (!dragging) return
		velocity = (event.clientX - lastX) * -0.01
		lastX = event.clientX
	}
	const onUp = () => (dragging = false)
	container.addEventListener('pointerdown', onDown)
	document.addEventListener('pointermove', onMove)
	document.addEventListener('pointerup', onUp)
	return () => {
		cancelAnimationFrame(frame)
		observer.disconnect()
		container.removeEventListener('pointerdown', onDown)
		document.removeEventListener('pointermove', onMove)
		document.removeEventListener('pointerup', onUp)
	}
}

/* ---------- Wire everything from the markup ---------- */

/**
 * Finds every motion hook under `root` and starts it. Returns one function that stops them all.
 *
 * | Markup                                            | Starts                         |
 * | ------------------------------------------------- | ------------------------------ |
 * | `.bt-header`                                      | stickyHeader, navMenus         |
 * | `.bt-logos[data-rotate]`                          | rotateLogos                    |
 * | `.bt-logos > i.hole`, `[data-texture-hole]`       | alignTexture                   |
 * | `.bt-number[data-count]`                          | animateNumber                  |
 * | `[data-live-number]` (`data-value`, `data-decimals`, …) | liveNumber, shown only; call it yourself to keep `set` |
 * | `[data-odometer]`                                 | odometer                       |
 * | `[data-reveal-text]`                              | revealText                     |
 * | `.bt-accordion` (`data-single` for one at a time) | accordion                      |
 * | `.bt-steps` (`data-seconds`, `data-stack="#id"`, `data-frame="#id"`) | steps       |
 * | `[role=tablist][data-panels="#id"]`               | tabs over that element's children |
 * | `.bt-marquee`                                     | marquee                        |
 *
 * Page-wide pieces are opt-in: `smoothScroll(Lenis)` and `pageTransitions()`.
 */
export function initMotion(root = document) {
	const stops = []
	const each = (selector, start) => {
		for (const element of root.querySelectorAll(selector)) {
			// Already wired, by an earlier initMotion or by a block (mountFeatures wires its own steps)
			if (claimed(element, selector)) continue
			const result = start(element)
			const stop = typeof result === 'function' ? result : () => result?.dispose?.()
			if (!claimed(element, selector)) claim(element, selector, stop)
			stops.push(() => {
				release(element, selector, { owner: stop })
				stop()
			})
		}
	}
	const find = (selector) => (selector ? document.querySelector(selector) : undefined)
	each('.bt-header', (header) => {
		const stopSticky = stickyHeader(header)
		const stopMenus = navMenus(header)
		return () => (stopSticky(), stopMenus())
	})
	each('.bt-logos[data-rotate]', (list) => rotateLogos(list))
	each('.bt-number[data-count]', (number) => animateNumber(number))
	each('[data-live-number]', (number) => liveNumber(number))
	each('[data-odometer]', (element) => odometer(element))
	each('[data-reveal-text]', (element) => revealText(element))
	each('.bt-accordion', (element) =>
		accordion(element, { single: element.hasAttribute('data-single') }),
	)
	each('.bt-steps', (list) =>
		steps(list, {
			seconds: Number(list.dataset.seconds ?? 5),
			stack: find(list.dataset.stack),
			frame: find(list.dataset.frame),
		}),
	)
	each('[role="tablist"][data-panels]', (tablist) =>
		tabs(tablist, find(tablist.dataset.panels)?.children ?? []),
	)
	each('.bt-marquee', (element) => marquee(element))
	each('.bt-tabbar-scroll', (wrap) => scrollCue(wrap))
	const holes = root.querySelectorAll('.bt-logos > i.hole, [data-texture-hole]')
	if (holes.length) stops.push(alignTexture(holes))
	const cornerHoles = root.querySelectorAll('.bt-logos.stepped > .bt-logo-tile')
	if (cornerHoles.length) stops.push(alignTexture(cornerHoles, undefined, { corner: true }))
	return () => stops.forEach((stop) => stop())
}
