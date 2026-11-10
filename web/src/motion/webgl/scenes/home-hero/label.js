import { CanvasTexture, SRGBColorSpace } from 'three'
const TITLE_CANVAS_WIDTH = 1024
const ICON_CANVAS_WIDTH = 512
// In world units, like the faces
const MARGIN = 0.05
const TITLE_MARGIN_LEFT = 0.08
const FONT_SIZE = 0.12
const LINE_HEIGHT = 1
/**
 * Two transparent textures: the product name for `titleFace`, a mask in the alpha
 * channel, left aligned and vertically centered, wrapped on words when it does not fit;
 * the product icon for `iconFace`, as wide as the face within the margin and aligned to
 * its top (premultiplied: blend it as `color * (1 - icon.a) + icon.rgb`).
 */
export function createLabelTextures(titleFace, iconFace) {
	function createCanvasTexture(face, width) {
		const scale = width / face.width
		const height = Math.round(face.height * scale)
		const canvas = Object.assign(document.createElement('canvas'), { width, height })
		const texture = new CanvasTexture(canvas)
		return { context: canvas.getContext('2d'), texture, width, height, scale }
	}
	const icon = createCanvasTexture(iconFace, ICON_CANVAS_WIDTH)
	icon.texture.colorSpace = SRGBColorSpace
	icon.texture.premultiplyAlpha = true
	const title = createCanvasTexture(titleFace, TITLE_CANVAS_WIDTH)
	const icons = new Map()
	let request = 0
	function loadIcon(src) {
		let image = icons.get(src)
		if (!image) {
			image = new Promise((resolve) => {
				const element = new Image()
				// Without CORS the canvas would be tainted and could not be uploaded
				element.crossOrigin = 'anonymous'
				element.onload = () => resolve(element)
				element.onerror = () => resolve(undefined)
				element.src = src
			})
			icons.set(src, image)
		}
		return image
	}
	const fontFamily = () =>
		getComputedStyle(document.documentElement).getPropertyValue('--beausite').trim() || 'sans-serif'
	function wrap(context, text, maxWidth) {
		const lines = []
		for (const word of text.trim().split(/\s+/)) {
			const line = lines.length ? `${lines.at(-1)} ${word}` : word
			if (lines.length && context.measureText(line).width <= maxWidth) {
				lines[lines.length - 1] = line
			} else {
				lines.push(word)
			}
		}
		return lines
	}
	function draw(label, image) {
		icon.context.clearRect(0, 0, icon.width, icon.height)
		if (image) {
			const margin = MARGIN * icon.scale
			const size = icon.width - 2 * margin
			icon.context.drawImage(image, margin, margin, size, size)
		}
		const { context, width, height, scale } = title
		const marginLeft = TITLE_MARGIN_LEFT * scale
		context.clearRect(0, 0, width, height)
		if (label) {
			const fontSize = FONT_SIZE * scale
			const lineHeight = fontSize * LINE_HEIGHT
			context.font = `400 ${fontSize}px ${fontFamily()}`
			context.letterSpacing = `${-0.01 * fontSize}px`
			context.fillStyle = '#fff'
			context.textBaseline = 'middle'
			const lines = wrap(context, label.name, width - marginLeft - MARGIN * scale)
			const firstLineY = height / 2 - ((lines.length - 1) * lineHeight) / 2
			lines.forEach((line, index) =>
				context.fillText(line, marginLeft, firstLineY + index * lineHeight),
			)
		}
		icon.texture.needsUpdate = true
		title.texture.needsUpdate = true
	}
	return {
		icon: icon.texture,
		title: title.texture,
		/** Starts loading the icons, so slide changes can draw them at once. */
		preload(labels) {
			labels.forEach((label) => label?.icon && void loadIcon(label.icon))
		},
		/** Draws a label once its icon and the font are ready (the last call wins). */
		async show(label) {
			const current = ++request
			const [image] = await Promise.all([
				label?.icon ? loadIcon(label.icon) : undefined,
				document.fonts.load(`400 16px ${fontFamily()}`).catch(() => {}),
			])
			if (current === request) {
				draw(label, image)
			}
		},
		dispose() {
			request++
			icon.texture.dispose()
			title.texture.dispose()
		},
	}
}
