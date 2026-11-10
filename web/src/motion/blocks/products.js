/**
 * Products section: a row of product cubes on a tinted floor, a tab list over the top-left corner
 * and one card per product over the bottom-right, wired as on www.baseten.co ("Built for every AI
 * workload").
 *
 *   <div class="bt-scene">
 *     <div class="visual" aria-hidden="true"><div class="bt-webgl"></div></div>
 *     <div class="corner"><div class="bt-tabs"></div></div>     <!-- filled from `products` -->
 *     <div class="bt-float-card">…first product…</div>          <!-- one card per product, in order -->
 *     <div class="bt-float-card" hidden>…second product…</div>
 *   </div>
 *
 *   mountProducts(document.querySelector('.bt-scene'), { products, label: 'Our products' })
 *
 * A product: { id, name, icon, color, background, pattern, videoUrl | face }.
 * - `pattern`: the 5x5 mark punched into the cube's front, rows top to bottom, "1" = hole:
 *   '00000 \ 01110 \ 01010 \ 01110 \ 00000'.
 * - `videoUrl`: looping footage for the cube's left face (white on black; black is dropped and
 *   white takes the product colour). `face`: a canvas drawn with createFaceCanvas(1, …) instead.
 *
 * What moves:
 * - choosing a product (tab, arrow keys, or a click on its cube) scrolls the row the short way
 *   to centre it, 0.6s sine.inOut; the cube turns a quarter to face the camera, lights up from
 *   10% brightness, its mark's holes open 0.2s later, and a translucent box stretches out behind
 *   it; the floor tint cross-fades to the product's background; the camera zooms to 0.93 and back;
 * - the mark's holes breathe on their own (noise-driven depth);
 * - the pointer over the centred cube's front opens white holes along its trail (0.5s in, 1.5s out);
 * - the card and tab icon swap at once, no fade.
 */
import { mountScene } from '../mount.js'
import { tabListKeyboard } from '../motion.js'
import { createProductsScene } from '../webgl/scenes/products.js'

/** The tab mark: a square that unfolds into an arrow on hover and focus (see .bt-arrow in baseten.css). */
export const ARROW_SVG =
	'<svg class="bt-arrow" aria-hidden="true" focusable="false" width="13" height="14" viewBox="0 0 13 14" fill="none"><g><path d="M3.536 3.536L3.536 10.607L10.607 3.536Z" fill="currentColor"/><path d="M10.607 10.607L10.607 3.536L3.536 10.607Z" fill="currentColor"/></g></svg>'

export function mountProducts(
	root,
	{ products, label = 'Products', initialIndex = 0, onChange, ...mountOptions },
) {
	const { scene, store, select } = createProductsScene({
		products,
		initialActiveIndex: initialIndex,
	})
	const visual = root.querySelector('.visual')
	const tablist = root.querySelector('.bt-tabs')
	const cards = [...root.querySelectorAll(':scope > .bt-float-card')]
	const panelId = cards[0]?.parentElement && (root.id || `bt-products-${++count}`) + '-panel'

	tablist.setAttribute('role', 'tablist')
	tablist.setAttribute('aria-label', label)
	tablist.setAttribute('aria-orientation', 'vertical')
	tablist.innerHTML = products
		.map(
			(product) =>
				`<button type="button" role="tab"><span>${product.name}</span><span class="mark">${ARROW_SVG}${
					product.icon ? `<img src="${product.icon}" alt="">` : ''
				}</span></button>`,
		)
		.join('')
	const tabs = [...tablist.children]
	cards.forEach((card) => card.setAttribute('role', 'tabpanel'))

	function render() {
		const { activeIndex } = store.get()
		tabs.forEach((tab, index) => {
			const active = index === activeIndex
			tab.classList.toggle('active', active)
			tab.setAttribute('aria-selected', String(active))
			tab.tabIndex = active ? 0 : -1
			if (panelId) tab.setAttribute('aria-controls', panelId)
		})
		cards.forEach((card, index) => {
			card.hidden = index !== activeIndex
			card.id = index === activeIndex && panelId ? panelId : ''
		})
		// Shows through before the scene has drawn, and when WebGL is not available.
		visual.style.backgroundColor = products[activeIndex].background
		onChange?.(activeIndex)
	}

	const handle = mountScene(root.querySelector('.bt-webgl'), scene, mountOptions)
	function choose(index) {
		handle.wake(1.5)
		select(index)
	}
	tabs.forEach((tab, index) => tab.addEventListener('click', () => choose(index)))
	const removeKeyboard = tabListKeyboard(tablist, { onChange: choose })
	const unsubscribe = store.subscribe(() => {
		handle.wake(1.5)
		render()
	})
	render()

	return {
		...handle,
		select: choose,
		dispose() {
			removeKeyboard()
			unsubscribe()
			handle.dispose()
		},
	}
}

let count = 0
