/**
 * Home hero: the isometric floor with four product blocks, its product picker (icons, tooltip,
 * autoplay line) and the product card, wired as on www.baseten.co.
 *
 *   <div class="bt-hero-composition">
 *     <div class="content">…copy and CTAs…</div>
 *     <div class="visual"><div class="bt-webgl"></div></div>
 *     <div class="switcher"></div>            <!-- filled from `slides` -->
 *     <div class="bt-logos stepped">…</div>   <!-- optional, see rotateLogos in motion.js -->
 *   </div>
 *
 *   mountHomeHero(document.querySelector('.bt-hero-composition'), { slides, poster })
 *
 * A slide: { name, description, icon, color, background, videos: [4 urls] | faces: [4 canvases] }.
 * `videos` are black-and-white clips used as masks on the block fronts (scripts/fetch_scene_media.py
 * fetches the site's own); `faces` are canvases you draw (webgl/utils/faceCanvas.js).
 *
 * What moves:
 * - blocks rise from under the floor on load, left to right (0.5s each, 0.04s apart, power2.out);
 * - every 8s (the line under the picker fills) the next product plays: blocks sink (power2.in),
 *   the floor re-colours cell by cell, the camera zooms out to 0.85 and back, the blocks rise in
 *   one of four formations with the next product's faces and colour; the card fades out and in (0.3s);
 * - hovering a block lifts it 20% of a cell (0.3s, power2.out) and holds autoplay; hovering or
 *   keyboard-focusing the picker holds it too;
 * - the floor cells under the pointer saturate and fade back (half-life 0.8s).
 */
import { mountScene } from '../mount.js'
import { tabListKeyboard } from '../motion.js'
import { createHomeHeroScene, createHomeHeroSlider } from '../webgl/scenes/home-hero/index.js'

export function mountHomeHero(root, { slides, autoplaySeconds = 8, ...mountOptions }) {
	const slider = createHomeHeroSlider(slides.length)
	const { scene, store } = createHomeHeroScene({
		slider,
		autoplaySeconds,
		colors: slides.map(({ color }) => color),
		labels: slides.map(({ name, icon }) => ({ name, icon })),
		slideVideos: slides.map(({ videos }) => videos),
		slideFaces: slides.map(({ faces }) => faces),
	})

	// Picker and card
	const switcher = root.querySelector('.switcher')
	switcher.innerHTML = `
		<div class="icons" role="tablist" aria-label="Products">
			${slides
				.map(
					(slide, index) => `
			<button type="button" role="tab" aria-label="${slide.name}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}"
				class="${index === 0 ? 'active' : ''}" style="--slide-background:${slide.background}">
				<img src="${slide.icon}" alt="" width="24" height="24"><span class="tooltip" aria-hidden="true">${slide.name}</span>
			</button>`,
				)
				.join('')}
			<span class="timer" aria-hidden="true"></span>
		</div>
		<div class="card" role="tabpanel">
			${slides
				.map(
					(slide, index) =>
						`<div class="slide"${index === 0 ? '' : ' hidden'}><strong>${slide.name}</strong>${slide.description ? `<span>${slide.description}</span>` : ''}</div>`,
				)
				.join('')}
		</div>`
	const tablist = switcher.querySelector('.icons')
	const tabs = [...tablist.querySelectorAll('[role="tab"]')]
	const timer = tablist.querySelector('.timer')
	const card = switcher.querySelector('.card')
	const copies = [...card.children]

	const handle = mountScene(root.querySelector('.bt-webgl'), scene, mountOptions)

	function select(index) {
		handle.wake(2)
		slider.select(index)
	}

	tabs.forEach((tab, index) => tab.addEventListener('click', () => select(index)))
	const removeKeyboard = tabListKeyboard(tablist, { onChange: select })

	// Autoplay waits while the pointer is over the picker, or keyboard focus is inside it
	// (a click leaves focus on the tab, which must not keep it paused).
	let hovered = false
	let focused = false
	const hold = () =>
		slider.setPaused(hovered || focused || matchMedia('(prefers-reduced-motion: reduce)').matches)
	tablist.addEventListener('pointerenter', () => ((hovered = true), hold()))
	tablist.addEventListener('pointerleave', () => ((hovered = false), hold()))
	tablist.addEventListener(
		'focusin',
		(event) => ((focused = event.target.matches(':focus-visible')), hold()),
	)
	tablist.addEventListener('focusout', (event) => {
		if (!tablist.contains(event.relatedTarget)) focused = false
		hold()
	})
	hold()

	let previous = {}
	const unsubscribe = store.subscribe(() => {
		const state = store.get()
		if (state.activeIndex !== previous.activeIndex) {
			tabs.forEach((tab, index) => {
				const active = index === state.activeIndex
				tab.classList.toggle('active', active)
				tab.setAttribute('aria-selected', String(active))
				tab.tabIndex = active ? 0 : -1
			})
			timer.style.backgroundColor = slides[state.activeIndex].color
		}
		if (state.displayedIndex !== previous.displayedIndex) {
			copies.forEach((copy, index) => (copy.hidden = index !== state.displayedIndex))
		}
		if (state.cardVisible !== previous.cardVisible) {
			card.classList.toggle('hidden', !state.cardVisible)
		}
		if (state.progress !== previous.progress) {
			timer.style.transform = `scaleX(${state.progress})`
		}
		previous = state
	})
	timer.style.backgroundColor = slides[0].color
	timer.style.transform = 'scaleX(0)'

	return {
		slider,
		store,
		select,
		dispose() {
			unsubscribe()
			removeKeyboard()
			handle.dispose()
		},
	}
}
