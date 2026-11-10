import { createStore } from '../../core/store.js'
/**
 * Slide state of the home hero, shared by its scene and the UI around it. It does not
 * depend on three.js, so the UI can create it and render before the scene loads: until
 * then a selection switches slide at once, and nothing plays automatically.
 */
export function createHomeHeroSlider(slideCount) {
	const store = createStore({
		activeIndex: 0,
		displayedIndex: 0,
		cardVisible: true,
		transitioning: false,
		progress: 0,
		paused: false,
	})
	let transitionTo
	const wrapIndex = (index) => ((Math.round(index) % slideCount) + slideCount) % slideCount
	return {
		slideCount,
		store,
		/** Shows a slide; selecting the active one restarts its autoplay timer. */
		select(index) {
			const { activeIndex } = store.get()
			const nextIndex = wrapIndex(index)
			if (nextIndex === activeIndex) {
				store.set({ progress: 0 })
			} else if (transitionTo) {
				transitionTo(nextIndex)
			} else {
				store.set({ activeIndex: nextIndex, displayedIndex: nextIndex, progress: 0 })
			}
		},
		setPaused(paused) {
			if (store.get().paused !== paused) {
				store.set({ paused })
			}
		},
		/** Set by the scene while it is mounted: plays the change to another slide. */
		setTransition(transition) {
			transitionTo = transition
		},
	}
}
