import { h, svg } from '../dom.js'
import { mountScene } from '../mount.js'
import { alignTexture, CHEVRON_SVG, odometer, reducedMotion, tabs } from '../motion.js'
import { createGlitchEffectScene } from '../webgl/scenes/glitch-effect.js'
import { ARROW_SVG } from './products.js'

/**
 * Use-case tabs, as under "Powering the frontier" on the site's product pages (`.bt-usecases` in
 * baseten.css). Left: a tile in the item's Base colour with the customer's logo, over a block in
 * its Light colour holding compact tabs. Right: the selected item's quote, attribution, metrics
 * and optional button on Light Grey 1.
 *
 * The tile runs the site's glitch scene over `texture`: a pale mosaic multiplied onto the colour,
 * its pixels drifting on noise, a little brighter and busier under the pointer. On a tab change
 * the scene's tint cross-fades (0.6s) while the tile and the tab block change colour (0.3s
 * ease-out), the old panel goes at once, the new one fades in (0.3s ease-out) and its metric
 * values scramble in again. Reduced motion or no WebGL: the still texture on the flat colour.
 *
 *   <div class="bt-usecases">
 *     <div class="panels bt-fade-stack cut"></div>
 *     <div class="nav">
 *       <div class="tile"><img class="texture" src="tile-texture.png" alt=""><div class="bt-webgl" aria-hidden="true"></div><img class="logo" alt=""></div>
 *       <div class="bt-tabs compact" role="tablist" aria-label="Powering the frontier" aria-orientation="vertical"></div>
 *       <i class="hole"></i>
 *     </div>
 *   </div>
 *
 * @param {HTMLElement} root the `.bt-usecases` element
 * @param {object} options
 * @param {Array<{ tab: string, quote: string, author?: string, title?: string,
 *   logo: { src: string, alt?: string, width?: number, height?: number },
 *   color: string, light: string,
 *   metrics?: Array<{ value: string, label: string }>,
 *   cta?: { text: string, url: string, variant?: 'primary' | 'secondary' | 'tertiary' } }>} options.items
 *   `cta.variant`: the button's look per item (the site alternates Black and White ones); default primary.
 *   `cta.url` must be an http(s) or same-site address; any other scheme leaves the button without a link.
 *   `color`: the tile, a Base colour (#FFBE4D). `light`: the tab block, its Light step (#FFEDC4).
 * @param {number} [options.initialIndex]
 * @param {(index: number) => void} [options.onChange]
 *   Other options go to `mountScene` (`poster`, `reducedMotion`, `tune`, `onFallback`).
 * @returns {{ select(index: number): void, scene: ReturnType<typeof mountScene> | null, dispose(): void }}
 */
const BUTTON_VARIANTS = { primary: '', secondary: 'secondary', tertiary: 'tertiary' }

/** An address a button may link to: http(s) or relative to this page. Anything else (javascript:, data:) gives none. */
function safeHref(url) {
	try {
		const parsed = new URL(String(url), document.baseURI)
		return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? String(url) : null
	} catch {
		return null
	}
}

export function mountUseCases(root, { items, initialIndex = 0, onChange, ...mountOptions }) {
	const panels = root.querySelector('.panels')
	const tile = root.querySelector('.tile')
	const tablist = root.querySelector('[role="tablist"]')
	const logo = tile.querySelector('.logo')
	const texture = tile.querySelector('.texture')
	const host = tile.querySelector('.bt-webgl')
	const id = root.id || `usecases-${Math.random().toString(36).slice(2, 8)}`

	// Built node by node: item text goes in as text, never as markup
	panels.replaceChildren(
		...items.map((item, index) =>
			h(
				'figure',
				{ role: 'tabpanel', id: `${id}-panel-${index}`, 'aria-labelledby': `${id}-tab-${index}` },
				h(
					'div',
					{ class: 'heading' },
					h('span', { class: 'bt-quote-mark', 'aria-hidden': 'true' }),
					h('blockquote', {}, item.quote),
					(item.author || item.title) &&
						h(
							'p',
							{ class: 'bt-attribution' },
							item.author && h('span', {}, item.author),
							item.author && item.title && ', ',
							item.title && h('span', { class: 'title' }, item.title),
						),
				),
				h(
					'div',
					{ class: 'bottom' },
					item.metrics?.length > 0 &&
						h(
							'dl',
							{},
							item.metrics.map((metric) =>
								h('div', {}, h('dt', {}, metric.label), h('dd', {}, h('span', { 'data-value': metric.value }, metric.value))),
							),
						),
					item.cta &&
						h(
							'div',
							{ class: 'cta' },
							h(
								'a',
								{
									class: `bt-button has-chevron ${Object.hasOwn(BUTTON_VARIANTS, item.cta.variant) ? BUTTON_VARIANTS[item.cta.variant] : ''}`.trim(),
									href: safeHref(item.cta.url),
								},
								// As on the site: the label, then the chevron that slides on hover
								h('span', {}, h('span', { class: 'label' }, item.cta.text), h('span', { class: 'chevron', 'aria-hidden': 'true' }, svg(CHEVRON_SVG))),
							),
						),
				),
			),
		),
	)
	tablist.replaceChildren(
		...items.map((item, index) =>
			h(
				'button',
				{ type: 'button', role: 'tab', id: `${id}-tab-${index}`, 'aria-controls': `${id}-panel-${index}` },
				h('span', {}, item.tab),
				svg(ARROW_SVG),
			),
		),
	)

	// The scene only where it can move; the still texture under it is the resting picture
	const definition = createGlitchEffectScene({
		imageUrl: texture?.currentSrc || texture?.src || null,
		tint: items[initialIndex]?.color,
		blend: 'multiply',
		subdivisionScale: 0.75,
		trailRadius: 0.15,
		trailResolutionScale: 0.125,
		trailLightenIntensity: 0.05,
	})
	const handle = host && texture && !reducedMotion() ? mountScene(host, definition, mountOptions) : null

	let stopNumbers = []
	const control = tabs(tablist, panels.children, {
		initialIndex,
		onChange(index) {
			const item = items[index]
			tile.style.backgroundColor = item.color
			tablist.style.backgroundColor = item.light
			logo.src = item.logo.src
			logo.alt = item.logo.alt ?? ''
			if (item.logo.width) logo.width = item.logo.width
			if (item.logo.height) logo.height = item.logo.height
			definition.store.set({ tint: item.color })
			// The shown panel's values scramble in, every time it is shown
			stopNumbers.forEach((stop) => stop())
			stopNumbers = [...panels.children[index].querySelectorAll('dd > span')].map((value) =>
				odometer(value, value.dataset.value),
			)
			onChange?.(index)
		},
	})
	const hole = root.querySelector('.nav > .hole')
	const stopTexture = hole ? alignTexture([hole]) : () => {}

	return {
		select: control.select,
		scene: handle,
		dispose() {
			stopNumbers.forEach((stop) => stop())
			stopTexture()
			control.dispose()
			handle?.dispose()
		},
	}
}
