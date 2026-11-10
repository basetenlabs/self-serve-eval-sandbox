import { CanvasTexture, LinearFilter, NoColorSpace } from 'three'
import { createVideoTexture } from './videoTexture.js'

/**
 * A block face you draw instead of footage: white and greys on black, in the brand's two
 * typefaces. The scenes read a face as a mask (black = the block's dark shade, white = its light
 * shade), so draw in greys only and let the scene colour it.
 *
 *   const face = createFaceCanvas(680 / 774, (f, time) => {
 *     f.label('Model library', 24, 40)
 *     f.metric('18.7k', 'requests/min', 24, 300)
 *     f.chart([2, 5, 4, 7, 6, 9, 11], 24, 420, 632, 300)
 *   }, { animate: true })
 *
 * The draw function gets a helper `f` laid out on a 680px-wide design space (the height follows
 * the aspect ratio: `f.height`), and the time in seconds when `animate` is on (redrawn every frame
 * while its block is on screen; leave it off for a still face).
 *
 * Aspect ratios of the home hero blocks, in order: 1920/2180 (tall), 1920/730, 1920/1240, 1920/900.
 * The product cube's code face is square.
 */
export function createFaceCanvas(aspect, draw, { animate = false, width = 1024 } = {}) {
	const canvas = Object.assign(document.createElement('canvas'), {
		width,
		height: Math.round(width / aspect),
	})
	const context = canvas.getContext('2d')
	const scale = width / DESIGN_WIDTH
	const helper = createHelper(context, DESIGN_WIDTH / aspect)

	function render(time = 0) {
		context.setTransform(scale, 0, 0, scale, 0, 0)
		context.fillStyle = '#000'
		context.fillRect(0, 0, DESIGN_WIDTH, helper.height)
		draw(helper, time)
	}

	return { canvas, animate, render }
}

const DESIGN_WIDTH = 680
const WHITE = '#fff'
/** Secondary text and rules. */
const GREY = '#8c8c8c'
/** Row and chart fills. */
const FILL = '#3a3a3a'

const cssFont = (name, fallback) =>
	getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

function createHelper(context, height) {
	const sans = () => cssFont('--beausite', 'sans-serif')
	const mono = () => cssFont('--geist-mono', 'ui-monospace, monospace')

	function text(
		value,
		x,
		y,
		{ size = 20, font = 'sans', color = WHITE, tracking = 0, weight = 400 } = {},
	) {
		context.font = `${weight} ${size}px ${font === 'mono' ? mono() : sans()}`
		context.letterSpacing = `${tracking * size}px`
		context.fillStyle = color
		context.textBaseline = 'alphabetic'
		context.fillText(value, x, y)
		return context.measureText(value).width
	}

	return {
		context,
		width: DESIGN_WIDTH,
		height,
		white: WHITE,
		grey: GREY,
		fill: FILL,
		text,
		/** Uppercase mono label: "MODEL LIBRARY". */
		label(value, x, y, { size = 20, color = WHITE } = {}) {
			return text(String(value).toUpperCase(), x, y, { size, font: 'mono', color, tracking: 0.08 })
		},
		/** A big number with a small unit, and a mono caption under it. */
		metric(value, caption, x, y, { size = 64, unit = '' } = {}) {
			const numberWidth = text(value, x, y, { size, tracking: -0.02 })
			if (unit) text(unit, x + numberWidth + size * 0.12, y, { size: size * 0.42 })
			if (caption)
				text(caption, x, y + size * 0.52, {
					size: size * 0.32,
					font: 'mono',
					color: GREY,
					tracking: 0.04,
				})
		},
		/** A filled row with a name, as in a list of models. */
		row(value, x, y, rowWidth, { rowHeight = 34, size = 20 } = {}) {
			context.fillStyle = FILL
			context.fillRect(x, y, rowWidth, rowHeight)
			text(value, x + 12, y + rowHeight / 2 + size * 0.34, { size, font: 'mono', tracking: 0.04 })
		},
		/** An outlined box, e.g. a prompt field. */
		box(x, y, boxWidth, boxHeight, { color = WHITE } = {}) {
			context.strokeStyle = color
			context.lineWidth = 1.5
			context.strokeRect(x, y, boxWidth, boxHeight)
		},
		/** A horizontal rule; dashed for chart guides. */
		rule(x, y, ruleWidth, { color = GREY, dashed = false } = {}) {
			context.strokeStyle = color
			context.lineWidth = 1.5
			context.setLineDash(dashed ? [6, 6] : [])
			context.beginPath()
			context.moveTo(x, y)
			context.lineTo(x + ruleWidth, y)
			context.stroke()
			context.setLineDash([])
		},
		/**
		 * A stepped line chart over a filled area, inside the box from (x, y) down `chartHeight`.
		 * `progress` (0..1) draws only the first part of the line, to animate it in.
		 */
		chart(values, x, y, chartWidth, chartHeight, { progress = 1 } = {}) {
			const max = Math.max(...values)
			const min = Math.min(...values, 0)
			const count = Math.max(2, Math.round((values.length - 1) * progress) + 1)
			const points = values
				.slice(0, count)
				.map((value, index) => [
					x + (index / (values.length - 1)) * chartWidth,
					y + chartHeight - ((value - min) / (max - min || 1)) * chartHeight,
				])
			context.beginPath()
			points.forEach(([px, py], index) => (index ? context.lineTo(px, py) : context.moveTo(px, py)))
			context.strokeStyle = WHITE
			context.lineWidth = 3
			context.lineJoin = 'miter'
			context.stroke()
			context.lineTo(points.at(-1)[0], y + chartHeight)
			context.lineTo(x, y + chartHeight)
			context.closePath()
			context.fillStyle = '#232323'
			context.fill()
		},
		/**
		 * Terminal text typed out line by line, anchored to the bottom and scrolling up, as on the
		 * product cube's code face. `time` in seconds; it loops.
		 */
		terminal(
			lines,
			time,
			{ size = 44, x = 22, lineHeight = 1.5, charsPerSecond = 28, hold = 2 } = {},
		) {
			const total = lines.reduce((sum, line) => sum + line.length + 1, 0)
			let typed = Math.floor((time % (total / charsPerSecond + hold)) * charsPerSecond)
			const shown = []
			for (const line of lines) {
				if (typed <= 0) break
				shown.push(line.slice(0, typed))
				typed -= line.length + 1
			}
			const step = size * lineHeight
			shown.forEach((line, index) => {
				const y = height - 24 - (shown.length - 1 - index) * step
				text(line, x, y, { size, font: 'mono', color: '#c8c8c8' })
			})
		},
	}
}

/**
 * The moving picture on a cube's code face: footage when `source` is a URL, a drawn face when it
 * is a canvas from `createFaceCanvas`, and plain dark when there is none. Call `update(elapsed)`
 * on the result every frame (a no-op for footage).
 */
export function createFaceClip(source) {
	if (typeof source === 'string' && source) return createVideoTexture(source)
	const clip = createCanvasClip(
		source || Object.assign(document.createElement('canvas'), { width: 2, height: 2 }),
	)
	clip.play()
	return clip
}

/** Wraps a face from `createFaceCanvas` (or any canvas) like a video clip, for the scenes. */
export function createCanvasClip(face) {
	const canvas = face.canvas ?? face
	const texture = new CanvasTexture(canvas)
	// The scenes decode sRGB themselves, as they must for video frames.
	texture.colorSpace = NoColorSpace
	texture.minFilter = LinearFilter
	texture.generateMipmaps = false
	let playing = false
	face.render?.(0)
	texture.needsUpdate = true

	return {
		texture,
		loaded: document.fonts.ready.then(() => {
			face.render?.(0)
			texture.needsUpdate = true
		}),
		presented: true,
		play() {
			playing = true
		},
		pause() {
			playing = false
		},
		/** Redraws an animated face; called by the scene every frame. */
		update(time) {
			if (playing && face.animate) {
				face.render(time)
				texture.needsUpdate = true
			}
		},
		dispose() {
			texture.dispose()
		},
	}
}
