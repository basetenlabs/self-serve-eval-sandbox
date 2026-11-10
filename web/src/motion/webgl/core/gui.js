/**
 * Stand-in for the Tweakpane debug panel the site's scenes bind their parameters to.
 * Every call is accepted and does nothing, so scene code stays the site's own. To tune a
 * scene live, pass the real class: `mountScene(el, scene, { Pane })` with
 * `import { Pane } from 'tweakpane'` (v4).
 */
export function createNullGui() {
	const node = {
		addBinding: () => node,
		addFolder: () => node,
		addButton: () => node,
		addBlade: () => node,
		on: () => node,
		refresh() {},
		dispose() {},
		hidden: true,
		// Scenes may park helper nodes (a file input) in the panel's element
		element: document.createElement('div'),
	}
	return node
}
