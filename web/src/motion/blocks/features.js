import { mountScene } from '../mount.js'
import { reducedMotion, steps } from '../motion.js'
import { createGlitchEffectScene } from '../webgl/scenes/glitch-effect.js'

/**
 * A photograph-like image made in code, for the glitch scene when there is no photo to hand:
 * a pale sky over a darker ground with a few soft shapes. The scene breaks it into drifting
 * pixels and tints it, so only its light and dark areas matter. Returns a data URL.
 */
export function glitchImage({ width = 640, height = 960, seed = 7 } = {}) {
	const canvas = Object.assign(document.createElement('canvas'), { width, height })
	const context = canvas.getContext('2d')
	let state = seed
	const random = () => (state = (state * 16807) % 2147483647) / 2147483647
	const sky = context.createLinearGradient(0, 0, 0, height)
	sky.addColorStop(0, '#8fa6c4')
	sky.addColorStop(0.55, '#c9d6e6')
	sky.addColorStop(0.56, '#5c7a2e')
	sky.addColorStop(1, '#2f4a17')
	context.fillStyle = sky
	context.fillRect(0, 0, width, height)
	for (let index = 0; index < 60; index++) {
		const ground = index % 3 > 0
		const x = random() * width
		const y = ground ? height * (0.56 + random() * 0.44) : height * random() * 0.5
		const radius = (ground ? 20 + random() * 60 : 60 + random() * 140) * (width / 640)
		const blob = context.createRadialGradient(x, y, 0, x, y, radius)
		const tone = ground
			? ['#d8d04a', '#16300c', '#7fa23a'][index % 3]
			: ['#ffffff', '#6f8fb8'][index % 2]
		blob.addColorStop(0, tone)
		blob.addColorStop(1, tone + '00')
		context.globalAlpha = ground ? 0.5 : 0.35
		context.fillStyle = blob
		context.fillRect(x - radius, y - radius, radius * 2, radius * 2)
	}
	// One tall dark figure, so the mosaic has a subject
	context.globalAlpha = 0.85
	context.fillStyle = '#3d3a2a'
	context.fillRect(width * 0.42, height * 0.36, width * 0.2, height * 0.4)
	return canvas.toDataURL('image/jpeg', 0.85)
}

/**
 * Features section with an auto-advancing step list and one live frame (`.bt-features`, markup in
 * baseten.css). The frame runs the site's glitch scene: `image` (any photo; default a generated
 * one) broken into a coarse grid of pixels that drift on noise, lightened towards the active
 * step's colour, under a faint isometric line grid; the pointer leaves a brighter, more agitated
 * trail. On a step change the tint cross-fades in the shader (0.6s) while the artwork in the
 * frame's `.bt-fade-stack` sinks out and the next rises in (0.3s each), and the countdown holds
 * while the pointer is on the frame.
 *
 * `colors`: one per step (default Green for all). Phones get no frame: each row shows its own
 * `.media` square instead. Reduced motion or no WebGL: the frame is the step's flat colour.
 *
 * @returns {{ steps: ReturnType<typeof steps>, scene: ReturnType<typeof mountScene> | null, dispose(): void }}
 */
export function mountFeatures(
	root,
	{ colors = [], image, seconds = 5, onChange, ...mountOptions } = {},
) {
	const list = root.querySelector('.bt-steps')
	const area = root.querySelector('.steps-area')
	const frame = root.querySelector(':scope > .frame')
	const host = frame?.querySelector('.bt-webgl')
	const desktop = window.matchMedia('(min-width: 801px)')
	const colorOf = (index) => colors[index] ?? colors[0] ?? '#19E76E'

	const definition = createGlitchEffectScene({ imageUrl: null, tint: colorOf(0) })
	let handle = null
	const imageUrl = image ?? glitchImage()
	function syncScene() {
		const wanted = !!host && desktop.matches && !reducedMotion()
		if (wanted && !handle) handle = mountScene(host, definition, mountOptions)
		else if (!wanted && handle) {
			handle.dispose()
			handle = null
		}
	}

	const stepList = steps(list, {
		seconds,
		frame,
		stack: frame?.querySelector('.bt-fade-stack'),
		onChange(index) {
			const color = colorOf(index)
			frame?.style.setProperty('--step-color', color)
			list.children[index]?.style.setProperty('--step-color', color)
			// One update for both, so a step change is a single cross-fade
			definition.store.set({ imageUrl, tint: color })
			onChange?.(index)
		},
	})

	// The list's height with its tallest row open, so the section does not move as steps change
	function measure() {
		if (!area) return
		if (!desktop.matches) return area.style.removeProperty('--steps-block-size')
		let collapsed = 0
		let tallest = 0
		for (const row of list.children) {
			const details = row.querySelector('.details')
			const open = details?.getBoundingClientRect().height ?? 0
			collapsed += row.getBoundingClientRect().height - open
			tallest = Math.max(tallest, details?.firstElementChild?.scrollHeight ?? 0)
		}
		area.style.setProperty('--steps-block-size', `${Math.ceil(collapsed + tallest)}px`)
	}
	const sizes = new ResizeObserver(measure)
	sizes.observe(list)
	const onLayout = () => {
		syncScene()
		measure()
	}
	desktop.addEventListener('change', onLayout)
	onLayout()

	return {
		steps: stepList,
		get scene() {
			return handle
		},
		dispose() {
			desktop.removeEventListener('change', onLayout)
			sizes.disconnect()
			stepList.dispose()
			handle?.dispose()
			area?.style.removeProperty('--steps-block-size')
		},
	}
}
